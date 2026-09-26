import { describe, expect, it } from 'vitest';

import type { MailProvider } from '@/lib/mail/provider';
import { executePlans, groupLabelOps, planChanges, revertChanges } from '@/lib/pipeline/apply';
import type { AppliedChanges } from '@/lib/types';

const labelMap = {
  PROMOTIONS: 'Label_promo',
  FINANCE: 'Label_finance',
  __review: 'Label_review',
  __attention: 'Label_attention',
};

const settings = { moveReviewOutOfInbox: true, starAttention: true, autoTrashMinConfidence: 90 };
const categories = [
  { key: 'PROMOTIONS', autoTrash: false },
  { key: 'FINANCE', autoTrash: false },
];

function plan(action: 'KEEP' | 'ARCHIVE' | 'TRASH' | 'ATTENTION', overrides: Partial<Parameters<typeof planChanges>[0]> = {}) {
  return planChanges({
    decision: { action, category: 'PROMOTIONS', confidence: 95 },
    currentLabelIds: ['INBOX', 'UNREAD'],
    labelMap,
    categories,
    settings,
    autoTrashRequested: false,
    ...overrides,
  });
}

describe('planChanges', () => {
  it('KEEP only adds the category label', () => {
    expect(plan('KEEP')).toEqual({
      changes: { addedLabelIds: ['Label_promo'], removedLabelIds: [], trashed: false, starred: false },
      status: 'APPLIED',
    });
  });

  it('ARCHIVE removes the inbox label only when it is there', () => {
    expect(plan('ARCHIVE').changes.removedLabelIds).toEqual(['INBOX']);
    expect(plan('ARCHIVE', { currentLabelIds: ['UNREAD'] }).changes.removedLabelIds).toEqual([]);
  });

  it('ATTENTION adds the attention label and a star', () => {
    const result = plan('ATTENTION');
    expect(result.changes.addedLabelIds).toEqual(['Label_promo', 'Label_attention', 'STARRED']);
    expect(result.changes.starred).toBe(true);
    expect(plan('ATTENTION', { settings: { ...settings, starAttention: false } }).changes.starred).toBe(false);
  });

  it('TRASH is queued for review by default and leaves the inbox', () => {
    const result = plan('TRASH');
    expect(result.status).toBe('PENDING_REVIEW');
    expect(result.changes.addedLabelIds).toEqual(['Label_promo', 'Label_review']);
    expect(result.changes.removedLabelIds).toEqual(['INBOX']);
    expect(result.changes.trashed).toBe(false);
  });

  it('TRASH stays in the inbox when configured to', () => {
    const result = plan('TRASH', { settings: { ...settings, moveReviewOutOfInbox: false } });
    expect(result.changes.removedLabelIds).toEqual([]);
  });

  it('auto-trashes only when requested and confident enough', () => {
    expect(plan('TRASH', { autoTrashRequested: true }).status).toBe('TRASHED');
    expect(plan('TRASH', { autoTrashRequested: true, decision: { action: 'TRASH', category: 'PROMOTIONS', confidence: 80 } }).status).toBe('PENDING_REVIEW');
    expect(plan('TRASH', { categories: [{ key: 'PROMOTIONS', autoTrash: true }] }).status).toBe('TRASHED');
  });

  it('does not re-add a label the message already carries', () => {
    expect(plan('KEEP', { currentLabelIds: ['INBOX', 'Label_promo'] }).changes.addedLabelIds).toEqual([]);
  });
});

class FakeProvider implements MailProvider {
  readonly kind = 'mock' as const;
  calls: string[] = [];
  async profile() {
    return { email: 'x', messagesTotal: 0 };
  }
  async listIds() {
    return { ids: [], nextPageToken: null, estimate: 0 };
  }
  async fetch() {
    return null;
  }
  async fetchBody() {
    return null;
  }
  async modify(ids: string[], add: string[], remove: string[]) {
    this.calls.push(`modify ${ids.join('+')} add=${add.join(',')} remove=${remove.join(',')}`);
  }
  async trash(id: string) {
    this.calls.push(`trash ${id}`);
  }
  async untrash(id: string) {
    this.calls.push(`untrash ${id}`);
  }
  async ensureLabels() {
    return {};
  }
}

describe('executePlans', () => {
  it('groups identical change sets into one call and trashes individually', async () => {
    const provider = new FakeProvider();
    const archive: AppliedChanges = { addedLabelIds: ['L1'], removedLabelIds: ['INBOX'], trashed: false, starred: false };
    const auto: AppliedChanges = { addedLabelIds: ['L1'], removedLabelIds: [], trashed: true, starred: false };
    await executePlans(provider, [
      { id: 'a', changes: archive },
      { id: 'b', changes: archive },
      { id: 'c', changes: auto },
      { id: 'd', changes: { addedLabelIds: [], removedLabelIds: [], trashed: false, starred: false } },
    ]);
    expect(provider.calls).toEqual(['modify a+b add=L1 remove=INBOX', 'modify c add=L1 remove=', 'trash c']);
  });
});

describe('revertChanges', () => {
  it('untrashes then swaps the labels back', async () => {
    const provider = new FakeProvider();
    await revertChanges(provider, 'a', { addedLabelIds: ['L1', 'STARRED'], removedLabelIds: ['INBOX'], trashed: true, starred: true });
    expect(provider.calls).toEqual(['untrash a', 'modify a add=INBOX remove=L1,STARRED']);
  });
});

describe('groupLabelOps', () => {
  it('collapses matching change sets so a bulk action costs a handful of calls', () => {
    const ops = Array.from({ length: 300 }, (_, i) => ({
      item: `m${i}`,
      add: i % 2 === 0 ? ['Label_promo'] : ['Label_finance'],
      remove: ['INBOX'],
    }));
    const { groups, untouched } = groupLabelOps(ops);
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(150);
    expect(groups[1].items).toHaveLength(150);
    expect(untouched).toEqual([]);
  });

  it('ignores the order labels were listed in', () => {
    const { groups } = groupLabelOps([
      { item: 'a', add: ['x', 'y'], remove: [] },
      { item: 'b', add: ['y', 'x'], remove: [] },
      { item: 'c', add: ['y', 'x', 'y'], remove: [] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toEqual(['a', 'b', 'c']);
    expect(groups[0].add).toEqual(['x', 'y']);
  });

  it('separates the items with nothing to change, which still count as done', () => {
    const { groups, untouched } = groupLabelOps([
      { item: 'a', add: [], remove: [] },
      { item: 'b', add: ['x'], remove: [] },
      { item: 'c', add: [], remove: [] },
    ]);
    expect(untouched).toEqual(['a', 'c']);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toEqual(['b']);
  });
});
