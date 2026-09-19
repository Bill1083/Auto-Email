/**
 * The pipeline: one run for one account.
 *
 *   budget -> new-mail lane -> backlog lane -> fetch -> rules -> classify
 *   -> plan -> apply -> persist -> update cursors
 *
 * One run per account at a time (in-process lock). A failure part-way leaves
 * the already-persisted chunks in place and records the error on the run;
 * emails that were fetched but not persisted are simply picked up next time,
 * because the lanes only ever look at ids the database has not seen.
 */

import type { Account, Category, Rule } from '@prisma/client';

import {
  ensureAccountLabels,
  getAccount,
  markNeedsReauth,
  providerFor,
  recordAccountError,
} from '@/lib/accounts';
import { OTHER_CATEGORY, listCategories } from '@/lib/categories';
import { epochSeconds, ReauthRequiredError, type MailProvider } from '@/lib/mail/provider';
import { executePlans, planChanges } from '@/lib/pipeline/apply';
import { computeBudget, effectiveDailyLimit, processedToday } from '@/lib/pipeline/budget';
import { addUsage, computeCostUsd } from '@/lib/pipeline/cost';
import { buildSystemInstruction, classifyBatch, fallbackDecision } from '@/lib/pipeline/classify';
import {
  autoPromoteSuggestions,
  regenerateLearnedNotes,
  relevantExamples,
} from '@/lib/pipeline/learning';
import { freeformInstructions, matchRule } from '@/lib/pipeline/rules';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettings, type AppSettings } from '@/lib/settings';
import {
  ZERO_USAGE,
  parseLabelMap,
  type Decision,
  type Lane,
  type LabelMap,
  type RawEmail,
  type RunTrigger,
} from '@/lib/types';
import { chunk } from '@/lib/utils';

export interface RunOptions {
  accountId: string;
  trigger: RunTrigger;
  lane?: Lane | 'both';
}

export interface RunOutcome {
  runId: string | null;
  status: 'OK' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  processed: number;
  message: string;
}

const locks = new Map<string, Promise<RunOutcome>>();

export function isRunning(accountId: string): boolean {
  return locks.has(accountId);
}

export function runAccount(options: RunOptions): Promise<RunOutcome> {
  const existing = locks.get(options.accountId);
  if (existing) return existing;
  const promise = execute(options).finally(() => locks.delete(options.accountId));
  locks.set(options.accountId, promise);
  return promise;
}

/** Sequential, so two accounts never compete for the same Gemini quota. */
export async function runAllAccounts(trigger: RunTrigger, lane: Lane | 'both' = 'both'): Promise<RunOutcome[]> {
  const accounts = await withDatabase(() =>
    prisma.account.findMany({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }),
  );
  if (!accounts.ok) return [];
  const outcomes: RunOutcome[] = [];
  for (const account of accounts.data) {
    outcomes.push(await runAccount({ accountId: account.id, trigger, lane }));
  }
  return outcomes;
}

// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  lane: Lane;
}

interface Prepared {
  email: RawEmail;
  lane: Lane;
  decision: Decision;
  rule: Rule | null;
}

const MAX_LIST_PAGES = 6;
const MAX_SNAPSHOT_PAGES = 120; // 60,000 ids

async function execute(options: RunOptions): Promise<RunOutcome> {
  const account = await getAccount(options.accountId);
  if (!account) return { runId: null, status: 'FAILED', processed: 0, message: 'Account not found.' };
  if (account.status !== 'ACTIVE') {
    return {
      runId: null,
      status: 'SKIPPED',
      processed: 0,
      message:
        account.status === 'PAUSED' ? 'Account is paused.' : 'Account needs to be reconnected.',
    };
  }

  // Scoped to this mailbox: its own profile, learned notes, dry-run state and
  // backlog query, with the shared settings for everything else.
  const settings = await getSettings(account.id);
  const lane = options.lane ?? 'both';
  const dailyLimit = effectiveDailyLimit(account, settings);
  const already = await processedToday(account.id);
  const budget = computeBudget({ dailyLimit, processedToday: already, maxPerRun: settings.maxPerRun });

  const created = await withDatabase(() =>
    prisma.run.create({
      data: {
        accountId: account.id,
        trigger: options.trigger,
        lane,
        dryRun: settings.dryRun,
        budget,
      },
    }),
  );
  if (!created.ok) {
    return { runId: null, status: 'FAILED', processed: 0, message: 'Database unavailable.' };
  }
  const run = created.data;
  const startedAt = new Date();

  const finish = async (
    status: 'OK' | 'PARTIAL' | 'FAILED',
    counts: Partial<{
      fetched: number;
      ruleDecided: number;
      aiDecided: number;
      kept: number;
      archived: number;
      trashProposed: number;
      autoTrashed: number;
      attention: number;
      costUsd: number;
    }>,
    error: string | null,
  ) => {
    await withDatabase(() =>
      prisma.run.update({
        where: { id: run.id },
        data: { status, error, finishedAt: new Date(), ...counts },
      }),
    );
  };

  if (budget <= 0) {
    await finish('OK', {}, null);
    return {
      runId: run.id,
      status: 'OK',
      processed: 0,
      message: `Daily cap reached (${already}/${dailyLimit} today).`,
    };
  }

  let provider: MailProvider;
  try {
    provider = providerFor(account);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider unavailable.';
    await finish('FAILED', {}, message);
    return { runId: run.id, status: 'FAILED', processed: 0, message };
  }

  const counts = {
    fetched: 0,
    ruleDecided: 0,
    aiDecided: 0,
    kept: 0,
    archived: 0,
    trashProposed: 0,
    autoTrashed: 0,
    attention: 0,
    costUsd: 0,
  };
  let persisted = 0;
  let partialError: string | null = null;

  try {
    // Labels are only created on the mailbox when changes will actually be
    // applied; a dry run leaves the mailbox completely untouched.
    const labelMap: LabelMap = settings.dryRun
      ? parseLabelMap(account.labelMapJson)
      : await ensureAccountLabels(account, provider);

    const [categories, rules] = await Promise.all([
      listCategories(true),
      withDatabase(() => prisma.rule.findMany({ orderBy: { createdAt: 'asc' } })).then((r) =>
        r.ok ? r.data : [],
      ),
    ]);

    // --- Lanes -------------------------------------------------------------
    const candidates: Candidate[] = [];
    let newLaneExhausted = false;
    if (lane === 'new' || lane === 'both') {
      const { ids, exhausted } = await collectNewIds(account, provider, settings, budget);
      newLaneExhausted = exhausted;
      candidates.push(...ids.map((id) => ({ id, lane: 'new' as const })));
    }
    if ((lane === 'backlog' || lane === 'both') && candidates.length < budget && !account.backlogDone) {
      const ids = await collectBacklogIds(account, provider, settings, budget - candidates.length);
      candidates.push(...ids.map((id) => ({ id, lane: 'backlog' as const })));
    }

    // --- Fetch -------------------------------------------------------------
    const emails: { email: RawEmail; lane: Lane }[] = [];
    const gone: string[] = [];
    for (const candidate of candidates) {
      const email = await provider.fetch(candidate.id, settings.maxBodyChars);
      if (!email) {
        gone.push(candidate.id);
        continue;
      }
      emails.push({ email, lane: candidate.lane });
    }
    counts.fetched = emails.length;
    if (gone.length > 0) {
      await withDatabase(() =>
        prisma.backlogItem.updateMany({
          where: { accountId: account.id, gmailId: { in: gone } },
          data: { status: 'GONE' },
        }),
      );
    }

    // --- Rules -------------------------------------------------------------
    const prepared: Prepared[] = [];
    const needsAi: { email: RawEmail; lane: Lane; rule: Rule | null }[] = [];
    for (const { email, lane: emailLane } of emails) {
      const match = matchRule(email, rules, account.id);
      if (match && match.category) {
        prepared.push({
          email,
          lane: emailLane,
          rule: match.rule,
          decision: {
            category: match.category,
            action: match.action,
            confidence: 100,
            reason: describeRule(match.rule),
            needsReply: false,
            decidedBy: 'rule',
            ruleId: match.rule.id,
            guardNote: null,
          },
        });
        counts.ruleDecided += 1;
      } else {
        // A rule without a category still needs the model to pick the label;
        // the rule's action wins afterwards.
        needsAi.push({ email, lane: emailLane, rule: match?.rule ?? null });
      }
    }

    // --- Classify ----------------------------------------------------------
    if (needsAi.length > 0) {
      const ctx = {
        categories,
        settings,
        instructions: freeformInstructions(rules, account.id),
        accountEmail: account.email,
      };
      const systemInstruction = buildSystemInstruction(ctx);
      let usage = { ...ZERO_USAGE };

      for (const batch of chunk(needsAi, settings.aiBatchSize)) {
        const batchEmails = batch.map((b) => b.email);
        const examples = await relevantExamples(account.id, batchEmails);
        const result = await classifyBatch(batchEmails, examples, ctx, systemInstruction);
        const costUsd = computeCostUsd(result.usage, {
          inputPerM: settings.priceInputPerM,
          outputPerM: settings.priceOutputPerM,
        });
        usage = addUsage(usage, result.usage);
        counts.costUsd += costUsd;

        await withDatabase(() =>
          prisma.aiCall.create({
            data: {
              runId: run.id,
              accountId: account.id,
              purpose: 'classify',
              model: result.model,
              emailCount: batchEmails.length,
              promptTokens: result.usage.promptTokens,
              outputTokens: result.usage.outputTokens,
              thoughtTokens: result.usage.thoughtTokens,
              cachedTokens: result.usage.cachedTokens,
              costUsd,
              latencyMs: result.latencyMs,
              ok: result.ok,
              errorCode: result.errorCode,
            },
          }),
        );
        if (!result.ok && result.errorReason) {
          partialError = `${result.errorCode}: ${result.errorReason}`;
        }

        for (const item of batch) {
          const aiDecision =
            result.decisions.get(item.email.id) ?? fallbackDecision('No decision returned.');
          let decision = aiDecision;
          if (item.rule && item.rule.action) {
            decision = {
              ...aiDecision,
              action: item.rule.action as Decision['action'],
              category: aiDecision.decidedBy === 'fallback' ? OTHER_CATEGORY : aiDecision.category,
              confidence: 100,
              reason: `${describeRule(item.rule)} ${aiDecision.decidedBy === 'ai' ? `Category by AI: ${aiDecision.reason}` : ''}`.trim(),
              decidedBy: 'rule',
              ruleId: item.rule.id,
            };
            counts.ruleDecided += 1;
          } else {
            counts.aiDecided += 1;
          }
          prepared.push({ email: item.email, lane: item.lane, decision, rule: item.rule });
        }
      }
    }

    // --- Plan, apply, persist (in chunks so a mid-run failure loses little) --
    const ruleHits = new Map<string, number>();
    for (const group of chunk(prepared, 25)) {
      const planned = group.map((item) => {
        const plan = planChanges({
          decision: item.decision,
          currentLabelIds: item.email.labelIds,
          labelMap,
          categories,
          settings,
          autoTrashRequested: Boolean(item.rule?.autoApply && item.rule.action === 'TRASH'),
        });
        return { item, plan };
      });

      if (!settings.dryRun) {
        await executePlans(
          provider,
          planned.map((p) => ({ id: p.item.email.id, changes: p.plan.changes })),
        );
      }

      const now = new Date();
      const writes = planned.map(({ item, plan }) =>
        prisma.message.create({
          data: {
            accountId: account.id,
            gmailId: item.email.id,
            threadId: item.email.threadId,
            internalDate: item.email.internalDate,
            fromName: item.email.from.name,
            fromAddress: item.email.from.address,
            fromDomain: item.email.from.domain,
            toAddress: item.email.to,
            subject: item.email.subject,
            snippet: (item.email.snippet || item.email.bodyText).slice(0, 300),
            hasAttachments: item.email.hasAttachments,
            listUnsubscribe: item.email.listUnsubscribe,
            gmailLabelsJson: JSON.stringify(item.email.labelIds),
            category: item.decision.category,
            action: item.decision.action,
            confidence: item.decision.confidence,
            reason: item.decision.reason.slice(0, 400),
            needsReply: item.decision.needsReply,
            decidedBy: item.decision.decidedBy,
            ruleId: item.decision.ruleId ?? null,
            guardNote: item.decision.guardNote ?? null,
            status: settings.dryRun ? 'DRY_RUN' : plan.status,
            appliedAt: settings.dryRun ? null : now,
            appliedChangesJson: settings.dryRun ? '{}' : JSON.stringify(plan.changes),
            runId: run.id,
            lane: item.lane,
            processedAt: now,
          },
        }),
      );
      // Individual creates rather than one transaction: a duplicate id (the
      // same message listed by both lanes) must not sink the whole chunk.
      for (const write of writes) {
        const result = await withDatabase(() => write);
        if (result.ok) persisted += 1;
      }

      for (const { item, plan } of planned) {
        if (item.rule) ruleHits.set(item.rule.id, (ruleHits.get(item.rule.id) ?? 0) + 1);
        switch (item.decision.action) {
          case 'KEEP':
            counts.kept += 1;
            break;
          case 'ARCHIVE':
            counts.archived += 1;
            break;
          case 'ATTENTION':
            counts.attention += 1;
            break;
          case 'TRASH':
            if (plan.status === 'TRASHED') counts.autoTrashed += 1;
            else counts.trashProposed += 1;
            break;
        }
      }

      const backlogIds = group.filter((g) => g.lane === 'backlog').map((g) => g.email.id);
      if (backlogIds.length > 0) {
        await withDatabase(() =>
          prisma.backlogItem.updateMany({
            where: { accountId: account.id, gmailId: { in: backlogIds } },
            data: { status: 'DONE' },
          }),
        );
      }
    }

    for (const [ruleId, hits] of ruleHits) {
      await withDatabase(() =>
        prisma.rule.update({ where: { id: ruleId }, data: { hits: { increment: hits } } }),
      );
    }

    // --- Cursors -----------------------------------------------------------
    const pendingBacklog = await withDatabase(() =>
      prisma.backlogItem.count({ where: { accountId: account.id, status: 'PENDING' } }),
    );
    const refreshed = await getAccount(account.id);
    await withDatabase(() =>
      prisma.account.update({
        where: { id: account.id },
        data: {
          ...(lane !== 'backlog'
            ? {
                lastNewLaneAt: startedAt,
                // Only advance the sync point when everything new was consumed;
                // otherwise the remainder is picked up next run.
                ...(newLaneExhausted ? { lastSyncAt: startedAt } : {}),
              }
            : {}),
          ...(pendingBacklog.ok
            ? {
                backlogEstimate: pendingBacklog.data,
                backlogDone: Boolean(refreshed?.backlogBuiltAt) && pendingBacklog.data === 0,
              }
            : {}),
          lastError: null,
        },
      }),
    );

    await finish(partialError ? 'PARTIAL' : 'OK', counts, partialError);

    // --- Learning housekeeping (cheap, best effort) ------------------------
    try {
      await autoPromoteSuggestions(account.id, settings);
      await maybeRefreshLearnedNotes(account.id, settings);
    } catch (error) {
      console.warn('[automail] learning housekeeping failed:', error instanceof Error ? error.message : error);
    }

    return {
      runId: run.id,
      status: partialError ? 'PARTIAL' : 'OK',
      processed: persisted,
      message:
        persisted === 0
          ? 'Nothing new to process.'
          : `${persisted} email${persisted === 1 ? '' : 's'} processed${settings.dryRun ? ' (dry run)' : ''}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[automail] run ${run.id} failed:`, message);
    if (error instanceof ReauthRequiredError) {
      await markNeedsReauth(account.id, message);
    } else {
      await recordAccountError(account.id, message);
    }
    await finish('FAILED', counts, message);
    return { runId: run.id, status: 'FAILED', processed: persisted, message };
  }
}

function describeRule(rule: Rule): string {
  const what =
    rule.kind === 'SENDER'
      ? `sender ${rule.pattern}`
      : rule.kind === 'DOMAIN'
        ? `domain ${rule.pattern}`
        : `subject containing "${rule.pattern}"`;
  return `Rule: ${what} → ${rule.action}.`;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

async function knownIds(accountId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await withDatabase(() =>
    prisma.message.findMany({
      where: { accountId, gmailId: { in: ids } },
      select: { gmailId: true },
    }),
  );
  return new Set(result.ok ? result.data.map((m) => m.gmailId) : []);
}

/**
 * Ids received since the account's sync point that the database has not seen.
 * `exhausted` is true when every new id fitted in the budget.
 */
async function collectNewIds(
  account: Account,
  provider: MailProvider,
  settings: AppSettings,
  budget: number,
): Promise<{ ids: string[]; exhausted: boolean }> {
  const since = account.lastSyncAt ?? account.createdAt;
  // A minute of overlap; duplicates are filtered against the database.
  const query = `${settings.backlogQuery} after:${Math.max(0, epochSeconds(since) - 60)}`.trim();

  const ids: string[] = [];
  let pageToken: string | null = null;
  let pages = 0;
  let exhausted = true;
  do {
    const page = await provider.listIds(query, 100, pageToken);
    pages += 1;
    const unseen = await knownIds(account.id, page.ids);
    for (const id of page.ids) {
      if (unseen.has(id) || ids.includes(id)) continue;
      if (ids.length >= budget) {
        exhausted = false;
        break;
      }
      ids.push(id);
    }
    pageToken = page.nextPageToken;
    if (!exhausted) break;
  } while (pageToken && pages < MAX_LIST_PAGES);
  if (pageToken && exhausted) exhausted = false;
  return { ids, exhausted };
}

/** Take the next pending ids from the snapshot, building it on first use. */
async function collectBacklogIds(
  account: Account,
  provider: MailProvider,
  settings: AppSettings,
  limit: number,
): Promise<string[]> {
  if (!account.backlogBuiltAt) {
    await buildBacklogSnapshot(account, provider, settings);
  }

  const ids: string[] = [];
  let skip = 0;
  while (ids.length < limit) {
    const page = await withDatabase(() =>
      prisma.backlogItem.findMany({
        where: { accountId: account.id, status: 'PENDING' },
        orderBy: { position: settings.backlogOrder === 'oldest' ? 'desc' : 'asc' },
        take: limit - ids.length,
        skip,
      }),
    );
    if (!page.ok || page.data.length === 0) break;
    skip += page.data.length;
    const seen = await knownIds(account.id, page.data.map((p) => p.gmailId));
    const alreadyDone = page.data.filter((p) => seen.has(p.gmailId)).map((p) => p.gmailId);
    if (alreadyDone.length > 0) {
      await withDatabase(() =>
        prisma.backlogItem.updateMany({
          where: { accountId: account.id, gmailId: { in: alreadyDone } },
          data: { status: 'DONE' },
        }),
      );
      skip -= alreadyDone.length;
    }
    for (const item of page.data) {
      if (!seen.has(item.gmailId)) ids.push(item.gmailId);
    }
  }
  return ids;
}

/**
 * Snapshot every id matching the backlog query up to the account's sync
 * point. Ids only (5 quota units per 500), so even a very large mailbox is
 * cheap to index once.
 */
async function buildBacklogSnapshot(
  account: Account,
  provider: MailProvider,
  settings: AppSettings,
): Promise<void> {
  const cutoff = account.lastSyncAt ?? account.createdAt;
  const query = `${settings.backlogQuery} before:${epochSeconds(cutoff) + 1}`.trim();

  await withDatabase(() => prisma.backlogItem.deleteMany({ where: { accountId: account.id } }));

  let pageToken: string | null = null;
  let position = 0;
  let pages = 0;
  do {
    const page = await provider.listIds(query, 500, pageToken);
    pages += 1;
    if (page.ids.length > 0) {
      const rows = page.ids.map((gmailId) => ({ accountId: account.id, gmailId, position: position++ }));
      await withDatabase(() => prisma.backlogItem.createMany({ data: rows }));
    }
    pageToken = page.nextPageToken;
  } while (pageToken && pages < MAX_SNAPSHOT_PAGES);

  await withDatabase(() =>
    prisma.account.update({
      where: { id: account.id },
      data: {
        backlogBuiltAt: new Date(),
        backlogEstimate: position,
        backlogDone: position === 0,
        // The first run of a fresh account defines the new-mail boundary.
        ...(account.lastSyncAt ? {} : { lastSyncAt: cutoff }),
      },
    }),
  );
}

/** Weekly, per mailbox: distil that mailbox's corrections into preferences. */
async function maybeRefreshLearnedNotes(accountId: string, settings: AppSettings): Promise<void> {
  if (!settings.learnedNotesAuto) return;
  const last = settings.learnedNotesUpdatedAt ? Date.parse(settings.learnedNotesUpdatedAt) : 0;
  if (Date.now() - last < 7 * 86_400_000) return;
  const feedback = await withDatabase(() =>
    prisma.message.count({ where: { accountId, userAction: { not: null } } }),
  );
  if (!feedback.ok || feedback.data < 5) return;
  // Stamp first so a failing model call does not retry on every run.
  const stamp = new Date().toISOString();
  await prisma.setting.upsert({
    where: { scope_key: { scope: accountId, key: 'learnedNotesUpdatedAt' } },
    create: { scope: accountId, key: 'learnedNotesUpdatedAt', value: stamp },
    update: { value: stamp },
  });
  await regenerateLearnedNotes(accountId);
}
