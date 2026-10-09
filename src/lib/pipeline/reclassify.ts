/**
 * Sorting again the emails Gemini could not classify the first time.
 *
 * New runs no longer file an email as unclassified just because Gemini was
 * busy; they leave it untouched and try again later. This is for the ones
 * that were filed that way before, and for the occasional email that fails
 * for a reason that is not a busy model: the user asks, and it goes through
 * exactly the same rules, model and guards a run would use.
 */

import type { Message } from '@prisma/client';

import { ensureAccountLabels, getAccount, providerFor } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { ReauthRequiredError } from '@/lib/mail/provider';
import { executePlans, planChanges, revertChanges } from '@/lib/pipeline/apply';
import { buildSystemInstruction, classifyBatch, fallbackDecision } from '@/lib/pipeline/classify';
import { computeCostUsd } from '@/lib/pipeline/cost';
import type { BulkOutcome } from '@/lib/pipeline/feedback';
import { relevantExamples } from '@/lib/pipeline/learning';
import { freeformInstructions, matchRule } from '@/lib/pipeline/rules';
import { decisionFromRule, withRuleAction } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettings } from '@/lib/settings';
import { parseChanges, parseLabelMap, type Decision, type RawEmail } from '@/lib/types';
import { chunk } from '@/lib/utils';

/** Only an email the model failed on, and that the user has not dealt with. */
export function canReclassify(message: Pick<Message, 'decidedBy' | 'userAction'>): boolean {
  return message.decidedBy === 'fallback' && message.userAction === null;
}

export async function reclassifyMessages(ids: string[], deadline: number): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { done: [], failed: [], remaining: [] };
  const found = await withDatabase(() => prisma.message.findMany({ where: { id: { in: ids } } }));
  if (!found.ok) {
    for (const id of ids) outcome.failed.push({ id, error: 'The database could not be reached.' });
    return outcome;
  }

  const byAccount = new Map<string, Message[]>();
  const byId = new Map(found.data.map((message) => [message.id, message]));
  for (const id of ids) {
    const message = byId.get(id);
    if (!message) outcome.failed.push({ id, error: 'No such message.' });
    else if (!canReclassify(message)) {
      outcome.failed.push({ id, error: 'Only unclassified emails can be sorted again.' });
    } else {
      const list = byAccount.get(message.accountId) ?? [];
      list.push(message);
      byAccount.set(message.accountId, list);
    }
  }

  for (const [accountId, messages] of byAccount) {
    if (Date.now() > deadline) {
      outcome.remaining.push(...messages.map((message) => message.id));
      continue;
    }
    try {
      await reclassifyForAccount(accountId, messages, deadline, outcome);
    } catch (error) {
      const reason =
        error instanceof ReauthRequiredError
          ? 'Account needs to be reconnected.'
          : error instanceof Error
            ? error.message
            : 'Unknown error';
      const settled = new Set([...outcome.done, ...outcome.failed.map((entry) => entry.id), ...outcome.remaining]);
      for (const message of messages) {
        if (!settled.has(message.id)) outcome.failed.push({ id: message.id, error: reason });
      }
    }
  }
  return outcome;
}

async function reclassifyForAccount(
  accountId: string,
  messages: Message[],
  deadline: number,
  outcome: BulkOutcome,
): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error('The account for this message no longer exists.');
  if (account.status === 'NEEDS_REAUTH') throw new ReauthRequiredError();

  const settings = await getSettings(account.id);
  const provider = providerFor(account);
  const labelMap = settings.dryRun ? parseLabelMap(account.labelMapJson) : await ensureAccountLabels(account, provider);
  const [categories, rules] = await Promise.all([
    listCategories(true),
    withDatabase(() => prisma.rule.findMany({ orderBy: { createdAt: 'asc' } })).then((r) => (r.ok ? r.data : [])),
  ]);

  // --- Read each email again --------------------------------------------
  const fetched: { message: Message; email: RawEmail }[] = [];
  for (const message of messages) {
    if (fetched.length > 0 && Date.now() > deadline) {
      outcome.remaining.push(message.id);
      continue;
    }
    const email = await provider.fetch(message.gmailId, settings.maxBodyChars);
    if (!email) outcome.failed.push({ id: message.id, error: 'This email is no longer in the mailbox.' });
    else fetched.push({ message, email });
  }

  // --- Rules first, then the model, exactly as a run does ----------------
  const decided: { message: Message; decision: Decision }[] = [];
  const needsAi: { message: Message; email: RawEmail; rule: ReturnType<typeof matchRule> }[] = [];
  for (const item of fetched) {
    const match = matchRule(item.email, rules, account.id);
    if (match && match.category) {
      decided.push({ message: item.message, decision: decisionFromRule(match.rule, match.action, match.category) });
    } else {
      needsAi.push({ ...item, rule: match });
    }
  }

  const ctx = { categories, settings, instructions: freeformInstructions(rules, account.id), accountEmail: account.email };
  const systemInstruction = buildSystemInstruction(ctx);
  for (const batch of chunk(needsAi, settings.aiBatchSize)) {
    const emails = batch.map((item) => item.email);
    const examples = await relevantExamples(account.id, emails);
    const result = await classifyBatch(emails, examples, ctx, systemInstruction);
    const costUsd = computeCostUsd(result.usage, {
      inputPerM: settings.priceInputPerM,
      outputPerM: settings.priceOutputPerM,
    });
    await withDatabase(() =>
      prisma.aiCall.create({
        data: {
          accountId: account.id,
          purpose: 'classify',
          model: result.model,
          emailCount: emails.length,
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

    // Still failing: leave the email exactly as it is and say why.
    if (!result.ok) {
      const reason = result.transient
        ? 'Gemini is still busy. Try again in a few minutes.'
        : (result.errorReason ?? 'Gemini could not classify this email.');
      for (const item of batch) outcome.failed.push({ id: item.message.id, error: reason });
      continue;
    }

    for (const item of batch) {
      const aiDecision = result.decisions.get(item.email.id) ?? fallbackDecision('No decision returned.');
      const decision = item.rule && item.rule.rule.action ? withRuleAction(aiDecision, item.rule.rule) : aiDecision;
      decided.push({ message: item.message, decision });
    }
  }

  // --- Undo the "unclassified" filing, apply the real decision -----------
  for (const { message, decision } of decided) {
    try {
      if (message.status !== 'DRY_RUN') {
        await revertChanges(provider, message.gmailId, parseChanges(message.appliedChangesJson));
      }
      const original = JSON.parse(message.gmailLabelsJson || '[]') as string[];
      const plan = planChanges({
        decision,
        currentLabelIds: original,
        labelMap,
        categories,
        settings,
        autoTrashRequested: false,
      });
      if (!settings.dryRun) {
        await executePlans(provider, [{ id: message.gmailId, changes: plan.changes }]);
      }

      const now = new Date();
      const saved = await withDatabase(() =>
        prisma.message.update({
          where: { id: message.id },
          data: {
            category: decision.category,
            action: decision.action,
            confidence: decision.confidence,
            reason: decision.reason.slice(0, 400),
            needsReply: decision.needsReply,
            decidedBy: decision.decidedBy,
            ruleId: decision.ruleId ?? null,
            guardNote: decision.guardNote ?? null,
            status: settings.dryRun ? 'DRY_RUN' : plan.status,
            appliedAt: settings.dryRun ? null : now,
            appliedChangesJson: settings.dryRun ? '{}' : JSON.stringify(plan.changes),
            attentionDoneAt: null,
          },
        }),
      );
      if (!saved.ok) throw new Error('The mailbox was updated but the record could not be saved.');
      if (decision.ruleId) {
        await withDatabase(() =>
          prisma.rule.update({ where: { id: decision.ruleId! }, data: { hits: { increment: 1 } } }),
        );
      }
      outcome.done.push(message.id);
    } catch (error) {
      if (error instanceof ReauthRequiredError) throw error;
      outcome.failed.push({ id: message.id, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}
