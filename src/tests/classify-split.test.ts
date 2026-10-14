import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category } from '@prisma/client';

vi.mock('@/lib/prisma', () => ({
  prisma: {},
  withDatabase: async () => ({ ok: false, error: 'mocked' }),
  isDatabaseReachable: async () => false,
}));

/**
 * A stand-in for Gemini's content filter: any request containing the word
 * POISON is refused, as a real one refuses a whole batch over one email.
 * Everything else is sorted. Each call is recorded.
 */
const calls: string[][] = [];
vi.mock('@/lib/gemini', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/gemini')>();
  return {
    ...real,
    generateStructured: async ({ prompt }: { prompt: string }) => {
      const ids = (/Return one decision for each of these ids: (.*)$/m.exec(prompt)?.[1] ?? '').split(', ');
      calls.push(ids);
      const usage = { promptTokens: 100, outputTokens: 10, thoughtTokens: 0, cachedTokens: 0 };
      if (prompt.includes('POISON')) {
        return {
          ok: false,
          code: 'BLOCKED',
          reason: "Google's content filter refused to process the request (PROHIBITED_CONTENT).",
          model: 'test',
          usage,
          latencyMs: 1,
        };
      }
      return {
        ok: true,
        data: {
          decisions: ids.map((id) => ({
            id,
            category: 'PROMOTIONS',
            action: 'TRASH',
            confidence: 97,
            reason: 'Looks like a sale.',
            needsReply: false,
          })),
        },
        model: 'test',
        usage,
        latencyMs: 1,
      };
    },
  };
});

import { BUILT_IN_CATEGORIES } from '@/lib/categories';
import { classifyBatch } from '@/lib/pipeline/classify';
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

const ctx = {
  categories,
  settings: { profileText: '', learnedNotes: '', geminiModel: 'test', autoTrashMinConfidence: 90 },
  instructions: [],
  accountEmail: 'me@example.com',
};

function email(id: string, overrides: Partial<RawEmail> = {}): RawEmail {
  return {
    id,
    threadId: id,
    internalDate: new Date('2026-10-01T10:00:00Z'),
    from: { name: 'Shop', address: 'deals@shop.example', domain: 'shop.example' },
    to: 'me@example.com',
    replyTo: null,
    subject: `Offer ${id}`,
    snippet: 'Big sale',
    bodyText: 'Big sale this weekend.',
    hasAttachments: false,
    attachmentNames: [],
    listUnsubscribe: true,
    automated: true,
    labelIds: ['INBOX'],
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe('classifyBatch when Gemini refuses', () => {
  it('sorts the rest of the batch and isolates the one email it will not read', async () => {
    const emails = Array.from({ length: 10 }, (_, i) =>
      email(`e${i}`, i === 6 ? { bodyText: 'POISON in the body' } : {}),
    );
    const result = await classifyBatch(emails, [], ctx);

    const decided = [...result.decisions.values()];
    expect(decided).toHaveLength(10);
    // Nine sorted normally, at full confidence.
    expect(emails.filter((e) => e.id !== 'e6').every((e) => result.decisions.get(e.id)?.decidedBy === 'ai')).toBe(true);
    expect(result.decisions.get('e0')?.confidence).toBe(97);
  });

  it('sorts the refused email from its sender and subject, never confidently enough to auto-trash', async () => {
    const emails = [email('a'), email('b', { bodyText: 'POISON in the body' })];
    const result = await classifyBatch(emails, [], ctx);

    const b = result.decisions.get('b')!;
    expect(b.decidedBy).toBe('ai');
    expect(b.confidence).toBeLessThan(ctx.settings.autoTrashMinConfidence);
    expect(b.guardNote).toMatch(/sender and subject only/);
    // The headers-only attempt really did leave the body out.
    expect(calls.at(-1)).toEqual(['b']);
  });

  it('hands an email it will not read even from the headers to the user, with the real reason', async () => {
    const emails = [email('a'), email('b', { subject: 'POISON subject', bodyText: 'POISON' })];
    const result = await classifyBatch(emails, [], ctx);

    expect(result.decisions.get('a')?.decidedBy).toBe('ai');
    const b = result.decisions.get('b')!;
    expect(b.decidedBy).toBe('fallback');
    expect(b.action).toBe('ATTENTION');
    expect(b.reason).toMatch(/PROHIBITED_CONTENT/);
    expect(b.reason).toMatch(/have a look yourself/);
    expect(result.ok).toBe(false);
  });

  it('costs one call when nothing is refused', async () => {
    const result = await classifyBatch([email('a'), email('b'), email('c')], [], ctx);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('adds up the tokens of every call it made', async () => {
    const result = await classifyBatch([email('a'), email('b', { bodyText: 'POISON' })], [], ctx);
    // Whole batch, then each half, then the headers-only retry: 4 calls.
    expect(calls).toHaveLength(4);
    expect(result.usage.promptTokens).toBe(400);
  });
});
