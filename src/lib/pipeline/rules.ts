/**
 * Deterministic rules, applied before the model sees anything.
 *
 * A matching sender / domain / subject rule decides the email outright: no
 * tokens spent, no ambiguity, and the user's explicit wishes always beat the
 * model. FREEFORM rules are not matched here; they are sent to the model as
 * standing instructions (see `classify.ts`).
 */

import type { Rule } from '@prisma/client';

import { ACTIONS, type Action, type RawEmail } from '@/lib/types';

export interface RuleMatch {
  rule: Rule;
  action: Action;
  category: string | null;
}

const KIND_ORDER: Record<string, number> = { SENDER: 0, DOMAIN: 1, SUBJECT_CONTAINS: 2 };

export function normalisePattern(kind: string, pattern: string): string {
  let value = pattern.trim().toLowerCase();
  if (kind === 'DOMAIN') value = value.replace(/^@/, '').replace(/^\*\./, '').replace(/^mailto:/, '');
  if (kind === 'SENDER') value = value.replace(/^mailto:/, '');
  return value;
}

/** `example.com` matches `example.com` and `mail.example.com`. */
export function domainMatches(pattern: string, domain: string): boolean {
  const p = normalisePattern('DOMAIN', pattern);
  const d = domain.toLowerCase();
  if (!p || !d) return false;
  return d === p || d.endsWith(`.${p}`);
}

/** Exact address, or a simple `*` glob such as `*@newsletter.example.com`. */
export function senderMatches(pattern: string, address: string): boolean {
  const p = normalisePattern('SENDER', pattern);
  const a = address.toLowerCase();
  if (!p || !a) return false;
  if (!p.includes('*')) return a === p;
  const regex = new RegExp(`^${p.split('*').map(escapeRegex).join('.*')}$`);
  return regex.test(a);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ruleMatches(rule: Pick<Rule, 'kind' | 'pattern'>, email: RawEmail): boolean {
  switch (rule.kind) {
    case 'SENDER':
      return senderMatches(rule.pattern, email.from.address);
    case 'DOMAIN':
      return domainMatches(rule.pattern, email.from.domain);
    case 'SUBJECT_CONTAINS': {
      const needle = rule.pattern.trim().toLowerCase();
      return needle.length > 0 && email.subject.toLowerCase().includes(needle);
    }
    default:
      return false;
  }
}

/** Rules that can decide an email for this account, most specific first. */
export function applicableRules(rules: Rule[], accountId: string): Rule[] {
  return rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.kind !== 'FREEFORM' &&
        rule.action !== null &&
        (ACTIONS as readonly string[]).includes(rule.action) &&
        (rule.accountId === null || rule.accountId === accountId),
    )
    .sort(
      (a, b) =>
        (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
}

export function matchRule(email: RawEmail, rules: Rule[], accountId: string): RuleMatch | null {
  for (const rule of applicableRules(rules, accountId)) {
    if (ruleMatches(rule, email)) {
      return { rule, action: rule.action as Action, category: rule.category };
    }
  }
  return null;
}

/** Free-text instructions that go into every prompt for this account. */
export function freeformInstructions(rules: Rule[], accountId: string): string[] {
  return rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.kind === 'FREEFORM' &&
        (rule.accountId === null || rule.accountId === accountId),
    )
    .map((rule) => (rule.note || rule.pattern).trim())
    .filter((text) => text.length > 0);
}
