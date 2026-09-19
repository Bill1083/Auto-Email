import { describe, expect, it, vi } from 'vitest';

// The scoping rule is pure; no database is needed to exercise it.
vi.mock('@/lib/prisma', () => ({
  prisma: {},
  withDatabase: async () => ({ ok: false, error: 'mocked' }),
  isDatabaseReachable: async () => false,
}));

import {
  PER_ACCOUNT_KEYS,
  defaultSettings,
  isPerAccountKey,
  resolveSettings,
} from '@/lib/settings';

describe('per-mailbox keys', () => {
  it('covers the settings that describe one mailbox', () => {
    expect([...PER_ACCOUNT_KEYS].sort()).toEqual(
      ['backlogOrder', 'backlogQuery', 'dryRun', 'learnedNotes', 'learnedNotesUpdatedAt', 'profileText'].sort(),
    );
    expect(isPerAccountKey('profileText')).toBe(true);
    expect(isPerAccountKey('geminiModel')).toBe(false);
  });
});

describe('resolveSettings', () => {
  it('falls back to the defaults when nothing is stored', () => {
    expect(resolveSettings({}, {})).toEqual(defaultSettings());
  });

  it('reads a mailbox profile from that mailbox only', () => {
    const work = resolveSettings({}, { profileText: 'Work: clients and invoices matter.' });
    const personal = resolveSettings({}, { profileText: 'Personal: friends and family.' });
    expect(work.profileText).toBe('Work: clients and invoices matter.');
    expect(personal.profileText).toBe('Personal: friends and family.');
  });

  it('never inherits a per-mailbox value from the global scope', () => {
    // A profile written before settings were split must not leak into every
    // mailbox: this is the whole point of the per-account scope.
    const global = {
      profileText: 'Left over from when the profile was shared.',
      learnedNotes: '- shared note',
      dryRun: 'false',
      backlogQuery: 'in:inbox',
    };
    const resolved = resolveSettings(global, {});
    expect(resolved.profileText).toBe('');
    expect(resolved.learnedNotes).toBe('');
    expect(resolved.dryRun).toBe(defaultSettings().dryRun);
    expect(resolved.backlogQuery).toBe(defaultSettings().backlogQuery);
  });

  it('leaves per-mailbox values at their defaults when no mailbox is named', () => {
    const resolved = resolveSettings({ geminiModel: 'gemini-2.5-flash-lite' }, null);
    expect(resolved.geminiModel).toBe('gemini-2.5-flash-lite');
    expect(resolved.profileText).toBe('');
  });

  it('reads shared keys from the global scope only', () => {
    const resolved = resolveSettings(
      { geminiModel: 'gemini-2.5-flash-lite', aiBatchSize: '25' },
      // A stray account-scoped row for a shared key must be ignored rather
      // than letting one mailbox change the model for everyone.
      { geminiModel: 'something-else', aiBatchSize: '1' },
    );
    expect(resolved.geminiModel).toBe('gemini-2.5-flash-lite');
    expect(resolved.aiBatchSize).toBe(25);
  });

  it('keeps each mailbox its own dry-run state', () => {
    expect(resolveSettings({}, { dryRun: 'false' }).dryRun).toBe(false);
    expect(resolveSettings({}, { dryRun: 'true' }).dryRun).toBe(true);
  });

  it('ignores values that do not parse', () => {
    const resolved = resolveSettings({ aiBatchSize: 'not a number' }, { backlogOrder: 'sideways' });
    expect(resolved.aiBatchSize).toBe(defaultSettings().aiBatchSize);
    expect(resolved.backlogOrder).toBe(defaultSettings().backlogOrder);
  });

  it('clamps stored numbers to their allowed range', () => {
    expect(resolveSettings({ aiBatchSize: '9999' }, {}).aiBatchSize).toBe(50);
    expect(resolveSettings({ autoTrashMinConfidence: '-5' }, {}).autoTrashMinConfidence).toBe(0);
  });
});
