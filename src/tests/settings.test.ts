import { describe, expect, it, vi } from 'vitest';

// No database: resolution is pure, and a write without a mailbox is refused
// before the database is ever touched.
vi.mock('@/lib/prisma', () => ({
  prisma: {},
  withDatabase: async () => ({ ok: false, error: 'mocked' }),
  isDatabaseReachable: async () => false,
}));

import {
  SettingsScopeError,
  defaultSettings,
  getSettings,
  resolveSettings,
  updateSettings,
} from '@/lib/settings';

describe('resolveSettings', () => {
  it('falls back to the defaults when a mailbox has nothing stored', () => {
    expect(resolveSettings({})).toEqual(defaultSettings());
  });

  it('keeps two mailboxes completely independent', () => {
    const work = resolveSettings({
      profileText: 'Work: clients and invoices matter.',
      dryRun: 'false',
      geminiModel: 'gemini-2.5-flash',
      runTimes: '08:00',
    });
    const personal = resolveSettings({
      profileText: 'Personal: friends and family.',
      dryRun: 'true',
      geminiModel: 'gemini-2.5-flash-lite',
      runTimes: '20:00',
    });
    expect(work.profileText).toBe('Work: clients and invoices matter.');
    expect(personal.profileText).toBe('Personal: friends and family.');
    expect(work.dryRun).toBe(false);
    expect(personal.dryRun).toBe(true);
    expect(work.geminiModel).toBe('gemini-2.5-flash');
    expect(personal.geminiModel).toBe('gemini-2.5-flash-lite');
    expect(work.runTimes).toBe('08:00');
    expect(personal.runTimes).toBe('20:00');
  });

  it('ignores keys that are not settings, such as demo mailbox state', () => {
    const resolved = resolveSettings({ 'mock:demo@automail.local': '{"labels":{}}' });
    expect(resolved).toEqual(defaultSettings());
  });

  it('ignores values that do not parse', () => {
    const resolved = resolveSettings({ aiBatchSize: 'not a number', backlogOrder: 'sideways', dryRun: 'maybe' });
    expect(resolved.aiBatchSize).toBe(defaultSettings().aiBatchSize);
    expect(resolved.backlogOrder).toBe(defaultSettings().backlogOrder);
    expect(resolved.dryRun).toBe(defaultSettings().dryRun);
  });

  it('clamps stored numbers to their allowed range', () => {
    expect(resolveSettings({ aiBatchSize: '9999' }).aiBatchSize).toBe(50);
    expect(resolveSettings({ autoTrashMinConfidence: '-5' }).autoTrashMinConfidence).toBe(0);
  });

  it('normalises run times', () => {
    expect(resolveSettings({ runTimes: '19:00, 7:00, 07:00, nonsense' }).runTimes).toBe('07:00,19:00');
  });
});

describe('scoping', () => {
  it('returns the defaults on "All accounts" without reading anything', async () => {
    expect(await getSettings(null)).toEqual(defaultSettings());
    expect(await getSettings(undefined)).toEqual(defaultSettings());
  });

  it('refuses to write without a mailbox rather than writing globally', async () => {
    await expect(updateSettings({ profileText: 'x' }, null)).rejects.toBeInstanceOf(SettingsScopeError);
    await expect(updateSettings({ geminiModel: 'x' }, undefined)).rejects.toBeInstanceOf(SettingsScopeError);
    await expect(updateSettings({ dryRun: false }, '')).rejects.toBeInstanceOf(SettingsScopeError);
  });
});
