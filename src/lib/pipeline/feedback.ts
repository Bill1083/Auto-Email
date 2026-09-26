/**
 * What happens when the user acts on a message from the dashboard.
 *
 * Every action here does two things: fixes the mailbox (the user's decision
 * is applied to Gmail immediately) and records the decision against the
 * message so the learning layer can use it.
 */

import type { Message, Prisma } from '@prisma/client';
import { z } from 'zod';

import { ensureAccountLabels, getAccount, providerFor } from '@/lib/accounts';
import { ReauthRequiredError, type MailProvider } from '@/lib/mail/provider';
import {
  applyUserAction,
  clearAttention,
  groupLabelOps,
  planChanges,
  revertChanges,
  type Plan,
} from '@/lib/pipeline/apply';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettings } from '@/lib/settings';
import {
  ACTIONS,
  GMAIL_LABELS,
  SYSTEM_LABELS,
  parseChanges,
  parseLabelMap,
  type Action,
  type LabelMap,
} from '@/lib/types';

/** Request body for the feedback routes. */
export const feedbackBodySchema = z.object({
  /** An action to apply, DONE for a handled attention item, CONFIRM for thumbs-up. */
  action: z.enum([...ACTIONS, 'DONE', 'CONFIRM']),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(500).optional(),
});

export type FeedbackBody = z.infer<typeof feedbackBodySchema>;

export async function handleFeedback(id: string, input: FeedbackBody): Promise<Message> {
  if (input.action === 'DONE') return markAttentionDone(id, input.note);
  if (input.action === 'CONFIRM') return confirmDecision(id);
  return applyFeedback(id, {
    action: input.action,
    category: input.category ?? null,
    note: input.note ?? null,
  });
}

export class FeedbackError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FeedbackError';
    this.status = status;
  }
}

async function loadMessage(messageId: string): Promise<Message> {
  const result = await withDatabase(() => prisma.message.findUnique({ where: { id: messageId } }));
  if (!result.ok) throw new FeedbackError('The database could not be reached.', 503);
  if (!result.data) throw new FeedbackError('No such message.', 404);
  return result.data;
}

async function context(message: Message) {
  const account = await getAccount(message.accountId);
  if (!account) throw new FeedbackError('The account for this message no longer exists.', 404);
  if (account.status === 'NEEDS_REAUTH') {
    throw new FeedbackError('This account needs to be reconnected before its mail can be changed.', 409);
  }
  const provider = providerFor(account);
  // A dry run never created labels; the user's first real action does.
  let labelMap: LabelMap = parseLabelMap(account.labelMapJson);
  if (Object.keys(labelMap).length === 0) {
    labelMap = await ensureAccountLabels(account, provider);
  }
  const settings = await getSettings(account.id);
  return { account, provider, labelMap, settings };
}

export interface FeedbackInput {
  action: Action;
  category?: string | null;
  note?: string | null;
}

/** The user chose an action (and optionally a category) for a message. */
export async function applyFeedback(messageId: string, input: FeedbackInput): Promise<Message> {
  const message = await loadMessage(messageId);
  const { provider, labelMap, settings } = await context(message);
  const category = input.category ?? message.userCategory ?? message.category;

  const plan = await applyUserAction({
    provider,
    message,
    labelMap,
    settings,
    action: input.action,
    category,
  });

  const now = new Date();
  const updated = await withDatabase(() =>
    prisma.message.update({
      where: { id: message.id },
      data: {
        userAction: input.action,
        userCategory: category,
        feedbackNote: input.note?.trim() ? input.note.trim().slice(0, 500) : message.feedbackNote,
        feedbackAt: now,
        status: plan.status,
        appliedAt: now,
        appliedChangesJson: JSON.stringify(plan.changes),
        // Any explicit decision closes an open attention item.
        attentionDoneAt: input.action === 'ATTENTION' ? null : now,
      },
    }),
  );
  if (!updated.ok) throw new FeedbackError('The mailbox was updated but the record could not be saved.', 500);
  return updated.data;
}

/** Put the message back exactly as it was before the pipeline touched it. */
export async function undoMessage(messageId: string): Promise<Message> {
  const message = await loadMessage(messageId);
  if (message.status === 'DRY_RUN' || message.status === 'REVERTED') {
    throw new FeedbackError('Nothing was applied to this message, so there is nothing to undo.', 409);
  }
  const { provider } = await context(message);
  await revertChanges(provider, message.gmailId, parseChanges(message.appliedChangesJson));

  const updated = await withDatabase(() =>
    prisma.message.update({
      where: { id: message.id },
      data: { status: 'REVERTED', appliedChangesJson: '{}', attentionDoneAt: new Date() },
    }),
  );
  if (!updated.ok) throw new FeedbackError('The mailbox was reverted but the record could not be saved.', 500);
  return updated.data;
}

/** The user dealt with an attention item; the labels come off, nothing else changes. */
export async function markAttentionDone(messageId: string, note?: string | null): Promise<Message> {
  const message = await loadMessage(messageId);
  const { provider, labelMap } = await context(message);
  await clearAttention(provider, message, labelMap);

  const updated = await withDatabase(() =>
    prisma.message.update({
      where: { id: message.id },
      data: {
        attentionDoneAt: new Date(),
        // "Done" confirms the AI was right to flag it.
        userAction: message.userAction ?? 'ATTENTION',
        userCategory: message.userCategory ?? message.category,
        feedbackAt: message.feedbackAt ?? new Date(),
        feedbackNote: note?.trim() ? note.trim().slice(0, 500) : message.feedbackNote,
      },
    }),
  );
  if (!updated.ok) throw new FeedbackError('The record could not be saved.', 500);
  return updated.data;
}

/** Thumbs up: the decision was right. Recorded as agreement. */
export async function confirmDecision(messageId: string): Promise<Message> {
  const message = await loadMessage(messageId);
  const updated = await withDatabase(() =>
    prisma.message.update({
      where: { id: message.id },
      data: {
        userAction: message.action,
        userCategory: message.category,
        feedbackAt: new Date(),
      },
    }),
  );
  if (!updated.ok) throw new FeedbackError('The record could not be saved.', 500);
  return updated.data;
}

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

/** Everything the bulk route can ask for. */
export type BulkActionName = Action | 'DONE' | 'CONFIRM' | 'UNDO';

export interface BulkInput {
  action: BulkActionName;
  category?: string | null;
  note?: string | null;
}

export interface BulkOutcome {
  done: string[];
  failed: { id: string; error: string }[];
  /**
   * Ids the request deliberately stopped short of, because it was running out
   * of time. The caller sends them again.
   */
  remaining: string[];
}

/** How long one request will spend on the mailbox before handing the rest back. */
export const BULK_BUDGET_MS = 45_000;

/**
 * The most ids one request may carry. A request is deliberately a slice of the
 * job, not the whole job: a few hundred emails cannot be trashed inside any
 * sane proxy timeout, so the dashboard sends chunks.
 */
export const BULK_CHUNK_LIMIT = 50;

function describe(error: unknown): string {
  if (error instanceof FeedbackError) return error.message;
  if (error instanceof ReauthRequiredError) return 'Account needs to be reconnected.';
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Apply one action to many messages.
 *
 * The naive version — call the single-message path in a loop — costs three
 * mailbox round trips and four queries per email, which for a few hundred
 * emails takes longer than any reverse proxy will wait. So label changes are
 * grouped into as few `modify` calls as the provider allows, the account,
 * settings and label map are resolved once instead of once per email, and the
 * work stops at a deadline and reports what is left rather than being cut off
 * mid-flight.
 */
export async function bulkAction(
  ids: string[],
  input: BulkInput,
  budgetMs = BULK_BUDGET_MS,
): Promise<BulkOutcome> {
  const unique = [...new Set(ids)];
  const deadline = Date.now() + budgetMs;
  const outcome: BulkOutcome = { done: [], failed: [], remaining: [] };

  // Undo reverses a different change set per message, and Attention is never
  // more than a handful at a time, so both keep the one-at-a-time path.
  if (input.action === 'UNDO' || input.action === 'ATTENTION') {
    for (const [index, id] of unique.entries()) {
      if (index > 0 && Date.now() > deadline) {
        outcome.remaining.push(id);
        continue;
      }
      try {
        if (input.action === 'UNDO') await undoMessage(id);
        else {
          await handleFeedback(id, {
            action: 'ATTENTION',
            category: input.category ?? undefined,
            note: input.note ?? undefined,
          });
        }
        outcome.done.push(id);
      } catch (error) {
        outcome.failed.push({ id, error: describe(error) });
        if (error instanceof ReauthRequiredError) break;
      }
    }
    return outcome;
  }

  const found = await withDatabase(() => prisma.message.findMany({ where: { id: { in: unique } } }));
  if (!found.ok) throw new FeedbackError('The database could not be reached.', 503);
  const byId = new Map(found.data.map((message) => [message.id, message]));
  for (const id of unique) {
    if (!byId.has(id)) outcome.failed.push({ id, error: 'No such message.' });
  }

  // Thumbs-up touches no mailbox at all, so it is one write and nothing else.
  if (input.action === 'CONFIRM') {
    const now = new Date();
    const saved = await withDatabase(() =>
      prisma.$transaction(
        found.data.map((message) =>
          prisma.message.update({
            where: { id: message.id },
            data: { userAction: message.action, userCategory: message.category, feedbackAt: now },
          }),
        ),
      ),
    );
    if (!saved.ok) throw new FeedbackError('The decisions could not be saved.', 500);
    outcome.done.push(...found.data.map((message) => message.id));
    return outcome;
  }

  const byAccount = new Map<string, Message[]>();
  for (const message of found.data) {
    const list = byAccount.get(message.accountId) ?? [];
    list.push(message);
    byAccount.set(message.accountId, list);
  }

  for (const messages of byAccount.values()) {
    if (Date.now() > deadline) {
      outcome.remaining.push(...messages.map((message) => message.id));
      continue;
    }
    try {
      await applyToAccount(messages, input, deadline, outcome);
    } catch (error) {
      const reason = describe(error);
      const settled = new Set([
        ...outcome.done,
        ...outcome.failed.map((entry) => entry.id),
        ...outcome.remaining,
      ]);
      for (const message of messages) {
        if (!settled.has(message.id)) outcome.failed.push({ id: message.id, error: reason });
      }
      if (error instanceof ReauthRequiredError) break;
    }
  }
  return outcome;
}

/** One `modify` per distinct add/remove pair, rather than one per message. */
async function modifyInGroups(
  provider: MailProvider,
  ops: { message: Message; add: string[]; remove: string[] }[],
  outcome: BulkOutcome,
): Promise<Message[]> {
  const { groups, untouched } = groupLabelOps(
    ops.map((op) => ({ item: op.message, add: op.add, remove: op.remove })),
  );
  const survivors: Message[] = [...untouched];

  for (const group of groups) {
    // Gmail takes up to 1000 ids per call; stay well inside that.
    for (let i = 0; i < group.items.length; i += 200) {
      const slice = group.items.slice(i, i + 200);
      try {
        await provider.modify(
          slice.map((message) => message.gmailId),
          group.add,
          group.remove,
        );
        survivors.push(...slice);
      } catch (error) {
        if (error instanceof ReauthRequiredError) throw error;
        const reason = describe(error);
        for (const message of slice) outcome.failed.push({ id: message.id, error: reason });
      }
    }
  }
  return survivors;
}

/** The grouped form of KEEP / ARCHIVE / TRASH / DONE for one account. */
async function applyToAccount(
  all: Message[],
  input: BulkInput,
  deadline: number,
  outcome: BulkOutcome,
): Promise<void> {
  const { provider, labelMap, settings } = await context(all[0]);
  const now = new Date();
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;

  if (input.action === 'DONE') {
    const ops = all.map((message) => {
      const changes = parseChanges(message.appliedChangesJson);
      const remove = new Set<string>();
      const attention = labelMap[SYSTEM_LABELS.attention];
      if (attention && changes.addedLabelIds.includes(attention)) remove.add(attention);
      if (changes.starred) remove.add(GMAIL_LABELS.starred);
      return { message, add: [], remove: message.status === 'DRY_RUN' ? [] : [...remove] };
    });
    const survivors = await modifyInGroups(provider, ops, outcome);
    await saveAll(survivors, outcome, (message) => ({
      attentionDoneAt: now,
      userAction: message.userAction ?? 'ATTENTION',
      userCategory: message.userCategory ?? message.category,
      feedbackAt: message.feedbackAt ?? now,
      feedbackNote: note ?? message.feedbackNote,
    }));
    return;
  }

  // Put every message back as it was before the pipeline touched it, so the
  // user's action starts from the same place the single-message path does.
  const untrash = all.filter(
    (message) => message.status !== 'DRY_RUN' && parseChanges(message.appliedChangesJson).trashed,
  );
  for (const message of untrash) {
    try {
      await provider.untrash(message.gmailId);
    } catch (error) {
      if (error instanceof ReauthRequiredError) throw error;
      outcome.failed.push({ id: message.id, error: describe(error) });
    }
  }
  const failedIds = new Set(outcome.failed.map((entry) => entry.id));
  const reverts = all
    .filter((message) => !failedIds.has(message.id))
    .map((message) => {
      const previous = parseChanges(message.appliedChangesJson);
      if (message.status === 'DRY_RUN') return { message, add: [], remove: [] };
      return { message, add: previous.removedLabelIds, remove: previous.addedLabelIds };
    });
  const reverted = await modifyInGroups(provider, reverts, outcome);

  // Then the action itself, planned purely so the provider work can be grouped.
  const plans = new Map<string, Plan>();
  const forward: { message: Message; add: string[]; remove: string[] }[] = [];
  for (const message of reverted) {
    const category = input.category ?? message.userCategory ?? message.category;
    const original = new Set<string>(JSON.parse(message.gmailLabelsJson || '[]') as string[]);
    let plan: Plan;
    if (input.action === 'TRASH') {
      const categoryLabel = labelMap[category];
      const add = categoryLabel && !original.has(categoryLabel) ? [categoryLabel] : [];
      plan = {
        changes: { addedLabelIds: add, removedLabelIds: [], trashed: true, starred: false },
        status: 'TRASHED',
      };
    } else {
      plan = planChanges({
        decision: { action: input.action as Action, category, confidence: 100 },
        currentLabelIds: [...original],
        labelMap,
        categories: [],
        settings,
        autoTrashRequested: false,
      });
    }
    plans.set(message.id, plan);
    forward.push({ message, add: plan.changes.addedLabelIds, remove: plan.changes.removedLabelIds });
  }
  const labelled = await modifyInGroups(provider, forward, outcome);

  // Gmail has no batch trash, so this is the one genuinely per-message call —
  // and the reason a few hundred emails need a deadline at all.
  const applied: Message[] = [];
  for (const [index, message] of labelled.entries()) {
    if (!plans.get(message.id)?.changes.trashed) {
      applied.push(message);
      continue;
    }
    if (index > 0 && Date.now() > deadline) {
      outcome.remaining.push(message.id);
      continue;
    }
    try {
      await provider.trash(message.gmailId);
      applied.push(message);
    } catch (error) {
      if (error instanceof ReauthRequiredError) throw error;
      outcome.failed.push({ id: message.id, error: describe(error) });
    }
  }

  await saveAll(applied, outcome, (message) => {
    const plan = plans.get(message.id)!;
    return {
      userAction: input.action as Action,
      userCategory: input.category ?? message.userCategory ?? message.category,
      feedbackNote: note ?? message.feedbackNote,
      feedbackAt: now,
      status: plan.status,
      appliedAt: now,
      appliedChangesJson: JSON.stringify(plan.changes),
      attentionDoneAt: now,
    };
  });
}

/** One transaction for the whole batch's records. */
async function saveAll(
  messages: Message[],
  outcome: BulkOutcome,
  data: (message: Message) => Prisma.MessageUpdateInput,
): Promise<void> {
  if (messages.length === 0) return;
  const saved = await withDatabase(() =>
    prisma.$transaction(
      messages.map((message) => prisma.message.update({ where: { id: message.id }, data: data(message) })),
    ),
  );
  if (!saved.ok) {
    // The mailbox is already changed, so this is worth surfacing loudly.
    throw new FeedbackError('The mailbox was updated but the records could not be saved.', 500);
  }
  outcome.done.push(...messages.map((message) => message.id));
}
