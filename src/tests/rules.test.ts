import { describe, expect, it } from 'vitest';
import type { Rule } from '@prisma/client';

import {
  applicableRules,
  domainMatches,
  freeformInstructions,
  matchRule,
  normalisePattern,
  senderMatches,
} from '@/lib/pipeline/rules';
import type { RawEmail } from '@/lib/types';

function email(overrides: Partial<RawEmail> = {}): RawEmail {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate: new Date('2026-09-01T10:00:00Z'),
    from: { name: 'Nike', address: 'nike@notifications.nike.com', domain: 'notifications.nike.com' },
    to: 'you@example.com',
    replyTo: null,
    subject: 'Members get 25% off',
    snippet: '',
    bodyText: '',
    hasAttachments: false,
    attachmentNames: [],
    listUnsubscribe: true,
    automated: true,
    labelIds: ['INBOX'],
    ...overrides,
  };
}

let seq = 0;
function rule(overrides: Partial<Rule>): Rule {
  seq += 1;
  return {
    id: `r${seq}`,
    accountId: null,
    kind: 'SENDER',
    pattern: '',
    action: 'KEEP',
    category: null,
    note: '',
    autoApply: false,
    source: 'user',
    hits: 0,
    enabled: true,
    createdAt: new Date(2026, 0, seq),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('senderMatches', () => {
  it('matches exact addresses case-insensitively', () => {
    expect(senderMatches('Nike@Notifications.nike.com', 'nike@notifications.nike.com')).toBe(true);
    expect(senderMatches('other@nike.com', 'nike@notifications.nike.com')).toBe(false);
  });

  it('supports a simple wildcard', () => {
    expect(senderMatches('*@notifications.nike.com', 'nike@notifications.nike.com')).toBe(true);
    expect(senderMatches('*@nike.com', 'nike@notifications.nike.com')).toBe(false);
  });

  it('never matches an empty pattern', () => {
    expect(senderMatches('', 'nike@notifications.nike.com')).toBe(false);
  });
});

describe('domainMatches', () => {
  it('matches the domain and its subdomains', () => {
    expect(domainMatches('nike.com', 'notifications.nike.com')).toBe(true);
    expect(domainMatches('nike.com', 'nike.com')).toBe(true);
  });

  it('does not match look-alike domains', () => {
    expect(domainMatches('nike.com', 'notnike.com')).toBe(false);
    expect(domainMatches('nike.com', 'nike.com.evil.org')).toBe(false);
  });

  it('tolerates a leading @ or *.', () => {
    expect(normalisePattern('DOMAIN', '@Nike.com')).toBe('nike.com');
    expect(normalisePattern('DOMAIN', '*.nike.com')).toBe('nike.com');
  });
});

describe('matchRule', () => {
  it('prefers sender over domain over subject regardless of creation order', () => {
    const subject = rule({ kind: 'SUBJECT_CONTAINS', pattern: '25%', action: 'ARCHIVE' });
    const domain = rule({ kind: 'DOMAIN', pattern: 'nike.com', action: 'TRASH' });
    const sender = rule({ kind: 'SENDER', pattern: 'nike@notifications.nike.com', action: 'KEEP' });
    const match = matchRule(email(), [subject, domain, sender], 'acct');
    expect(match?.rule.id).toBe(sender.id);
    expect(match?.action).toBe('KEEP');
  });

  it('skips disabled rules, rules for other accounts and instructions', () => {
    const disabled = rule({ kind: 'DOMAIN', pattern: 'nike.com', action: 'TRASH', enabled: false });
    const other = rule({ kind: 'DOMAIN', pattern: 'nike.com', action: 'TRASH', accountId: 'someone-else' });
    const freeform = rule({ kind: 'FREEFORM', note: 'Keep everything from Nike', action: null });
    expect(matchRule(email(), [disabled, other, freeform], 'acct')).toBeNull();
    expect(applicableRules([disabled, other, freeform], 'acct')).toHaveLength(0);
  });

  it('applies account-scoped rules to that account', () => {
    const scoped = rule({ kind: 'DOMAIN', pattern: 'nike.com', action: 'TRASH', accountId: 'acct', category: 'PROMOTIONS' });
    const match = matchRule(email(), [scoped], 'acct');
    expect(match?.category).toBe('PROMOTIONS');
  });

  it('matches subjects case-insensitively', () => {
    const subject = rule({ kind: 'SUBJECT_CONTAINS', pattern: 'members get', action: 'ARCHIVE' });
    expect(matchRule(email(), [subject], 'acct')?.action).toBe('ARCHIVE');
  });
});

describe('freeformInstructions', () => {
  it('returns enabled instruction text for the account and global scope', () => {
    const rules = [
      rule({ kind: 'FREEFORM', note: 'Invoices are always Finance.' }),
      rule({ kind: 'FREEFORM', note: 'Ignore this', enabled: false }),
      rule({ kind: 'FREEFORM', note: 'Only for another account', accountId: 'other' }),
      rule({ kind: 'FREEFORM', pattern: 'Pattern used when note is empty', note: '' }),
    ];
    expect(freeformInstructions(rules, 'acct')).toEqual([
      'Invoices are always Finance.',
      'Pattern used when note is empty',
    ]);
  });
});
