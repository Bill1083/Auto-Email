import { describe, expect, it, vi } from 'vitest';
import type { Category } from '@prisma/client';

// No database in these tests: the modules under test only need the types.
vi.mock('@/lib/prisma', () => ({
  prisma: {},
  withDatabase: async () => ({ ok: false, error: 'mocked' }),
  isDatabaseReachable: async () => false,
}));

import { BUILT_IN_CATEGORIES } from '@/lib/categories';
import {
  applyGuards,
  buildBatchPrompt,
  buildSystemInstruction,
  decisionsResponseSchema,
  describeEmail,
  fallbackDecision,
  formatExamples,
} from '@/lib/pipeline/classify';
import type { RawEmail } from '@/lib/types';

const categories: Category[] = BUILT_IN_CATEGORIES.map((def) => ({
  key: def.key,
  name: def.name,
  description: def.description,
  labelName: def.labelName,
  defaultAction: def.defaultAction,
  allowTrash: def.allowTrash,
  autoTrash: false,
  enabled: true,
  builtIn: true,
  sortOrder: def.sortOrder,
}));

const email: RawEmail = {
  id: 'abc123',
  threadId: 't',
  internalDate: new Date('2026-09-01T10:00:00Z'),
  from: { name: 'HMRC', address: 'noreply@hmrc.gov.uk', domain: 'hmrc.gov.uk' },
  to: 'you@example.com',
  replyTo: null,
  subject: 'Self Assessment payment due',
  snippet: 'Your payment is due',
  bodyText: 'Your Self Assessment payment is due on 31 January.',
  hasAttachments: true,
  attachmentNames: ['statement.pdf'],
  listUnsubscribe: false,
  automated: true,
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES', 'IMPORTANT'],
};

describe('decisionsResponseSchema', () => {
  it('accepts a well-formed response and defaults needsReply', () => {
    const parsed = decisionsResponseSchema.safeParse({
      decisions: [{ id: 'abc123', category: 'FINANCE', action: 'KEEP', confidence: 90, reason: 'Tax reminder.' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.decisions[0].needsReply).toBe(false);
  });

  it('rejects unknown actions and out-of-range confidence', () => {
    expect(
      decisionsResponseSchema.safeParse({
        decisions: [{ id: 'x', category: 'FINANCE', action: 'DELETE', confidence: 90, reason: '' }],
      }).success,
    ).toBe(false);
    expect(
      decisionsResponseSchema.safeParse({
        decisions: [{ id: 'x', category: 'FINANCE', action: 'KEEP', confidence: 140, reason: '' }],
      }).success,
    ).toBe(false);
  });
});

describe('applyGuards', () => {
  const base = { id: 'abc123', confidence: 95, reason: 'Looks like marketing.', needsReply: false };

  it('maps an unknown category to OTHER with a note', () => {
    const decision = applyGuards({ ...base, category: 'SPORTS', action: 'ARCHIVE' }, categories);
    expect(decision.category).toBe('OTHER');
    expect(decision.guardNote).toMatch(/Unknown or disabled/);
  });

  it('never trashes a protected category', () => {
    const finance = applyGuards({ ...base, category: 'FINANCE', action: 'TRASH' }, categories);
    expect(finance.action).toBe('KEEP');
    expect(finance.guardNote).toMatch(/may not be trashed/);

    const receipts = applyGuards({ ...base, category: 'RECEIPTS', action: 'TRASH' }, categories);
    expect(receipts.action).toBe('ARCHIVE');
  });

  it('allows trash where the category permits it', () => {
    const promo = applyGuards({ ...base, category: 'PROMOTIONS', action: 'TRASH' }, categories);
    expect(promo.action).toBe('TRASH');
    expect(promo.guardNote).toBeNull();
  });

  it('turns anything needing a reply into ATTENTION', () => {
    const decision = applyGuards({ ...base, category: 'WORK', action: 'KEEP', needsReply: true }, categories);
    expect(decision.action).toBe('ATTENTION');
    expect(decision.needsReply).toBe(true);
  });

  it('clamps and rounds confidence and marks the decider as ai', () => {
    const decision = applyGuards({ ...base, category: 'WORK', action: 'KEEP', confidence: 99.6 }, categories);
    expect(decision.confidence).toBe(100);
    expect(decision.decidedBy).toBe('ai');
  });
});

describe('fallbackDecision', () => {
  it('routes to attention with zero confidence', () => {
    const decision = fallbackDecision('Model unavailable');
    expect(decision).toMatchObject({ category: 'OTHER', action: 'ATTENTION', confidence: 0, decidedBy: 'fallback' });
  });
});

describe('prompt construction', () => {
  it('lists categories, instructions and the profile in the system instruction', () => {
    const text = buildSystemInstruction({
      categories,
      settings: { profileText: 'I trade futures.', learnedNotes: '- Keep prop firm mail', geminiModel: 'x', autoTrashMinConfidence: 90 },
      instructions: ['Invoices are always Finance.'],
      accountEmail: 'you@example.com',
    });
    expect(text).toContain('I trade futures.');
    expect(text).toContain('Keep prop firm mail');
    expect(text).toContain('Invoices are always Finance.');
    expect(text).toContain('FINANCE (Finance)');
    expect(text).toContain('[never TRASH]');
    expect(text).toContain('you@example.com');
  });

  it('describes signals and includes every id in the batch prompt', () => {
    const description = describeEmail(email);
    expect(description).toContain('### id: abc123');
    expect(description).toContain('gmail tab: updates');
    expect(description).toContain('attachments: statement.pdf');
    expect(description).toContain('gmail marked important');
    expect(description).toContain('automated/bulk sender');

    const prompt = buildBatchPrompt([email], []);
    expect(prompt).toContain('(none)');
    expect(prompt).toContain('Return one decision for each of these ids: abc123');
  });

  it('formats corrections and confirmations differently', () => {
    const text = formatExamples([
      { fromAddress: 'a@x.com', subject: 'Hi', aiAction: 'TRASH', aiCategory: 'PROMOTIONS', userAction: 'KEEP', userCategory: 'NEWSLETTERS', note: 'I read these' },
      { fromAddress: 'b@x.com', subject: 'Sale', aiAction: 'TRASH', aiCategory: 'PROMOTIONS', userAction: 'TRASH', userCategory: null, note: null },
    ]);
    expect(text).toContain('the person changed it to KEEP (NEWSLETTERS)');
    expect(text).toContain('Note from the person: "I read these"');
    expect(text).toContain('the person confirmed TRASH');
  });
});
