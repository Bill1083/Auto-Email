/**
 * What happens when the user acts on a message from the dashboard.
 *
 * Every action here does two things: fixes the mailbox (the user's decision
 * is applied to Gmail immediately) and records the decision against the
 * message so the learning layer can use it.
 */

import type { Message } from '@prisma/client';
import { z } from 'zod';

import { ensureAccountLabels, getAccount, providerFor } from '@/lib/accounts';
import { applyUserAction, clearAttention, revertChanges } from '@/lib/pipeline/apply';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettings } from '@/lib/settings';
import { ACTIONS, parseChanges, parseLabelMap, type Action, type LabelMap } from '@/lib/types';

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
