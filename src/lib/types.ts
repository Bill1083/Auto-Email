/**
 * Shared domain types.
 */

export const ACTIONS = ['KEEP', 'ARCHIVE', 'TRASH', 'ATTENTION'] as const;
export type Action = (typeof ACTIONS)[number];

export const DECIDED_BY = ['rule', 'ai', 'user', 'fallback'] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];

export const MESSAGE_STATUSES = [
  'DRY_RUN',
  'PENDING_REVIEW',
  'APPLIED',
  'TRASHED',
  'REVERTED',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const ACCOUNT_STATUSES = ['ACTIVE', 'NEEDS_REAUTH', 'PAUSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const RULE_KINDS = ['SENDER', 'DOMAIN', 'SUBJECT_CONTAINS', 'FREEFORM'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export type Lane = 'new' | 'backlog';
export type RunTrigger = 'schedule' | 'manual' | 'cron';

/** System labels applied alongside category labels. Keys into the label map. */
export const SYSTEM_LABELS = {
  review: '__review',
  attention: '__attention',
} as const;

/** Gmail's own label ids that the pipeline reads or writes. */
export const GMAIL_LABELS = {
  inbox: 'INBOX',
  unread: 'UNREAD',
  starred: 'STARRED',
  trash: 'TRASH',
  spam: 'SPAM',
  important: 'IMPORTANT',
} as const;

/** An email as the pipeline sees it: headers, signals and a body excerpt. */
export interface RawEmail {
  id: string;
  threadId: string;
  internalDate: Date;
  from: { name: string | null; address: string; domain: string };
  to: string | null;
  replyTo: string | null;
  subject: string;
  snippet: string;
  /** Plain-text excerpt, already cleaned and truncated. */
  bodyText: string;
  hasAttachments: boolean;
  attachmentNames: string[];
  listUnsubscribe: boolean;
  /** `Precedence: bulk/list` or `Auto-Submitted` present. */
  automated: boolean;
  labelIds: string[];
}

export interface Decision {
  category: string;
  action: Action;
  confidence: number;
  reason: string;
  needsReply: boolean;
  decidedBy: DecidedBy;
  ruleId?: string | null;
  guardNote?: string | null;
}

/** Exactly what was changed on the provider, so undo can replay it in reverse. */
export interface AppliedChanges {
  addedLabelIds: string[];
  removedLabelIds: string[];
  trashed: boolean;
  starred: boolean;
}

export const EMPTY_CHANGES: AppliedChanges = {
  addedLabelIds: [],
  removedLabelIds: [],
  trashed: false,
  starred: false,
};

export function parseChanges(raw: string | null | undefined): AppliedChanges {
  if (!raw) return { ...EMPTY_CHANGES };
  try {
    const parsed = JSON.parse(raw) as Partial<AppliedChanges>;
    return {
      addedLabelIds: Array.isArray(parsed.addedLabelIds) ? parsed.addedLabelIds : [],
      removedLabelIds: Array.isArray(parsed.removedLabelIds) ? parsed.removedLabelIds : [],
      trashed: Boolean(parsed.trashed),
      starred: Boolean(parsed.starred),
    };
  } catch {
    return { ...EMPTY_CHANGES };
  }
}

/** category key or system label -> provider label id. */
export type LabelMap = Record<string, string>;

export function parseLabelMap(raw: string | null | undefined): LabelMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as LabelMap) : {};
  } catch {
    return {};
  }
}

export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export interface TokenUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedTokens: 0,
};
