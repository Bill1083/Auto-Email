/**
 * Turning decisions into label changes on the mailbox, and back again.
 *
 * Every change is recorded as the exact label ids added and removed, so undo
 * is a mechanical reversal rather than a guess. Trash goes through the
 * provider's trash endpoint, which Gmail reverses with untrash for 30 days.
 */

import type { Category, Message } from '@prisma/client';

import type { MailProvider } from '@/lib/mail/provider';
import type { AppSettings } from '@/lib/settings';
import {
  GMAIL_LABELS,
  SYSTEM_LABELS,
  parseChanges,
  type Action,
  type AppliedChanges,
  type Decision,
  type LabelMap,
  type MessageStatus,
} from '@/lib/types';

export interface PlanInput {
  decision: Pick<Decision, 'action' | 'category' | 'confidence'>;
  /** Label ids the message currently carries. */
  currentLabelIds: string[];
  labelMap: LabelMap;
  categories: Pick<Category, 'key' | 'autoTrash'>[];
  settings: Pick<AppSettings, 'moveReviewOutOfInbox' | 'starAttention' | 'autoTrashMinConfidence'>;
  /** A matching rule with autoApply, or a category with autoTrash. */
  autoTrashRequested: boolean;
}

export interface Plan {
  changes: AppliedChanges;
  status: MessageStatus;
}

/**
 * What to do on the provider for one decision. Pure, so it is unit-tested
 * for every action and every combination of settings.
 */
export function planChanges(input: PlanInput): Plan {
  const { decision, labelMap, settings } = input;
  const has = new Set(input.currentLabelIds);
  const add = new Set<string>();
  const remove = new Set<string>();

  const categoryLabel = labelMap[decision.category];
  if (categoryLabel && !has.has(categoryLabel)) add.add(categoryLabel);

  const inInbox = has.has(GMAIL_LABELS.inbox);
  let status: MessageStatus = 'APPLIED';
  let trashed = false;
  let starred = false;

  switch (decision.action) {
    case 'KEEP':
      break;
    case 'ARCHIVE':
      if (inInbox) remove.add(GMAIL_LABELS.inbox);
      break;
    case 'ATTENTION': {
      const attention = labelMap[SYSTEM_LABELS.attention];
      if (attention && !has.has(attention)) add.add(attention);
      if (settings.starAttention && !has.has(GMAIL_LABELS.starred)) {
        add.add(GMAIL_LABELS.starred);
        starred = true;
      }
      break;
    }
    case 'TRASH': {
      const category = input.categories.find((c) => c.key === decision.category);
      const auto =
        (input.autoTrashRequested || Boolean(category?.autoTrash)) &&
        decision.confidence >= settings.autoTrashMinConfidence;
      if (auto) {
        trashed = true;
        status = 'TRASHED';
      } else {
        const review = labelMap[SYSTEM_LABELS.review];
        if (review && !has.has(review)) add.add(review);
        if (settings.moveReviewOutOfInbox && inInbox) remove.add(GMAIL_LABELS.inbox);
        status = 'PENDING_REVIEW';
      }
      break;
    }
  }

  return {
    changes: {
      addedLabelIds: [...add],
      removedLabelIds: [...remove],
      trashed,
      starred,
    },
    status,
  };
}

export interface LabelOp<T> {
  item: T;
  add: string[];
  remove: string[];
}

export interface LabelGroup<T> {
  add: string[];
  remove: string[];
  items: T[];
}

/**
 * Collapse per-message label changes into the fewest `modify` calls: emails
 * getting the same labels added and removed travel together. Pure, because the
 * difference between one call and three hundred is what keeps a bulk action
 * inside a request timeout, and that is worth testing directly.
 *
 * `untouched` are the items with nothing to change, which still count as done.
 */
export function groupLabelOps<T>(ops: LabelOp<T>[]): { groups: LabelGroup<T>[]; untouched: T[] } {
  const groups = new Map<string, LabelGroup<T>>();
  const untouched: T[] = [];
  for (const op of ops) {
    const add = [...new Set(op.add)].sort();
    const remove = [...new Set(op.remove)].sort();
    if (add.length === 0 && remove.length === 0) {
      untouched.push(op.item);
      continue;
    }
    const key = `${add.join(',')}|${remove.join(',')}`;
    const group = groups.get(key) ?? { add, remove, items: [] };
    group.items.push(op.item);
    groups.set(key, group);
  }
  return { groups: [...groups.values()], untouched };
}

/** Apply a batch of plans with as few provider calls as possible. */
export async function executePlans(
  provider: MailProvider,
  items: { id: string; changes: AppliedChanges }[],
): Promise<void> {
  const { groups } = groupLabelOps(
    items.map((item) => ({
      item: item.id,
      add: item.changes.addedLabelIds,
      remove: item.changes.removedLabelIds,
    })),
  );
  for (const group of groups) {
    await provider.modify(group.items, group.add, group.remove);
  }
  for (const item of items) {
    if (item.changes.trashed) await provider.trash(item.id);
  }
}

/** Reverse a recorded change set. */
export async function revertChanges(
  provider: MailProvider,
  id: string,
  changes: AppliedChanges,
): Promise<void> {
  if (changes.trashed) await provider.untrash(id);
  const add = changes.removedLabelIds;
  const remove = changes.addedLabelIds;
  if (add.length > 0 || remove.length > 0) await provider.modify([id], add, remove);
}

export interface UserActionInput {
  provider: MailProvider;
  message: Message;
  labelMap: LabelMap;
  settings: Pick<AppSettings, 'moveReviewOutOfInbox' | 'starAttention' | 'autoTrashMinConfidence'>;
  action: Action;
  category: string;
}

/**
 * The user changed their mind about a message: undo what was done, then do
 * what they asked. Returns the new change set and status to persist.
 */
export async function applyUserAction(input: UserActionInput): Promise<Plan> {
  const { provider, message } = input;
  const previous = parseChanges(message.appliedChangesJson);

  // Nothing was applied in a dry run, so there is nothing to reverse.
  if (message.status !== 'DRY_RUN') {
    await revertChanges(provider, message.gmailId, previous);
  }

  // Reconstruct the label set as it was before we touched the message.
  const original = new Set<string>(JSON.parse(message.gmailLabelsJson || '[]') as string[]);

  if (input.action === 'TRASH') {
    // A user-confirmed trash is immediate, never queued.
    const categoryLabel = input.labelMap[input.category];
    const add = categoryLabel && !original.has(categoryLabel) ? [categoryLabel] : [];
    if (add.length > 0) await provider.modify([message.gmailId], add, []);
    await provider.trash(message.gmailId);
    return {
      changes: { addedLabelIds: add, removedLabelIds: [], trashed: true, starred: false },
      status: 'TRASHED',
    };
  }

  const plan = planChanges({
    decision: { action: input.action, category: input.category, confidence: 100 },
    currentLabelIds: [...original],
    labelMap: input.labelMap,
    categories: [],
    settings: input.settings,
    autoTrashRequested: false,
  });
  await executePlans(provider, [{ id: message.gmailId, changes: plan.changes }]);
  return plan;
}

/** Remove the Attention label (and star) once the user has dealt with it. */
export async function clearAttention(
  provider: MailProvider,
  message: Message,
  labelMap: LabelMap,
): Promise<void> {
  const changes = parseChanges(message.appliedChangesJson);
  const remove = new Set<string>();
  const attention = labelMap[SYSTEM_LABELS.attention];
  if (attention && changes.addedLabelIds.includes(attention)) remove.add(attention);
  if (changes.starred) remove.add(GMAIL_LABELS.starred);
  if (remove.size > 0 && message.status !== 'DRY_RUN') {
    await provider.modify([message.gmailId], [], [...remove]);
  }
}
