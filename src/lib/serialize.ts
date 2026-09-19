/**
 * Wire shapes for the dashboard. Dates become ISO strings, secrets never
 * leave the server, and the client gets exactly the fields it renders.
 */

import type { Account, AiCall, Category, Message, Rule, Run } from '@prisma/client';

export interface MessageDto {
  id: string;
  accountId: string;
  accountEmail: string;
  gmailId: string;
  threadId: string;
  internalDate: string;
  fromName: string | null;
  fromAddress: string;
  fromDomain: string;
  subject: string;
  snippet: string;
  hasAttachments: boolean;
  listUnsubscribe: boolean;
  category: string;
  action: string;
  confidence: number;
  reason: string;
  needsReply: boolean;
  decidedBy: string;
  ruleId: string | null;
  guardNote: string | null;
  status: string;
  appliedAt: string | null;
  attentionDoneAt: string | null;
  userAction: string | null;
  userCategory: string | null;
  feedbackNote: string | null;
  feedbackAt: string | null;
  lane: string;
  processedAt: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function serializeMessage(message: Message, accountEmail: string): MessageDto {
  return {
    id: message.id,
    accountId: message.accountId,
    accountEmail,
    gmailId: message.gmailId,
    threadId: message.threadId,
    internalDate: message.internalDate.toISOString(),
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    fromDomain: message.fromDomain,
    subject: message.subject,
    snippet: message.snippet,
    hasAttachments: message.hasAttachments,
    listUnsubscribe: message.listUnsubscribe,
    category: message.category,
    action: message.action,
    confidence: message.confidence,
    reason: message.reason,
    needsReply: message.needsReply,
    decidedBy: message.decidedBy,
    ruleId: message.ruleId,
    guardNote: message.guardNote,
    status: message.status,
    appliedAt: iso(message.appliedAt),
    attentionDoneAt: iso(message.attentionDoneAt),
    userAction: message.userAction,
    userCategory: message.userCategory,
    feedbackNote: message.feedbackNote,
    feedbackAt: iso(message.feedbackAt),
    lane: message.lane,
    processedAt: message.processedAt.toISOString(),
  };
}

export interface RunDto {
  id: string;
  accountId: string;
  accountEmail?: string;
  trigger: string;
  lane: string;
  status: string;
  error: string | null;
  dryRun: boolean;
  budget: number;
  fetched: number;
  ruleDecided: number;
  aiDecided: number;
  kept: number;
  archived: number;
  trashProposed: number;
  autoTrashed: number;
  attention: number;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  running?: boolean;
}

export function serializeRun(run: Run, accountEmail?: string): RunDto {
  return {
    id: run.id,
    accountId: run.accountId,
    accountEmail,
    trigger: run.trigger,
    lane: run.lane,
    status: run.status,
    error: run.error,
    dryRun: run.dryRun,
    budget: run.budget,
    fetched: run.fetched,
    ruleDecided: run.ruleDecided,
    aiDecided: run.aiDecided,
    kept: run.kept,
    archived: run.archived,
    trashProposed: run.trashProposed,
    autoTrashed: run.autoTrashed,
    attention: run.attention,
    costUsd: run.costUsd,
    startedAt: run.startedAt.toISOString(),
    finishedAt: iso(run.finishedAt),
  };
}

export interface AccountDto {
  id: string;
  email: string;
  displayName: string | null;
  provider: string;
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
  lastNewLaneAt: string | null;
  lastScheduledRunAt: string | null;
  backlogBuiltAt: string | null;
  backlogDone: boolean;
  backlogEstimate: number | null;
  dailyLimit: number | null;
  labelPrefix: string;
  createdAt: string;
}

export function serializeAccount(account: Account): AccountDto {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    provider: account.provider,
    status: account.status,
    lastError: account.lastError,
    lastSyncAt: iso(account.lastSyncAt),
    lastNewLaneAt: iso(account.lastNewLaneAt),
    lastScheduledRunAt: iso(account.lastScheduledRunAt),
    backlogBuiltAt: iso(account.backlogBuiltAt),
    backlogDone: account.backlogDone,
    backlogEstimate: account.backlogEstimate,
    dailyLimit: account.dailyLimit,
    labelPrefix: account.labelPrefix,
    createdAt: account.createdAt.toISOString(),
  };
}

export interface RuleDto {
  id: string;
  accountId: string | null;
  kind: string;
  pattern: string;
  action: string | null;
  category: string | null;
  note: string;
  autoApply: boolean;
  source: string;
  hits: number;
  enabled: boolean;
  createdAt: string;
}

export function serializeRule(rule: Rule): RuleDto {
  return {
    id: rule.id,
    accountId: rule.accountId,
    kind: rule.kind,
    pattern: rule.pattern,
    action: rule.action,
    category: rule.category,
    note: rule.note,
    autoApply: rule.autoApply,
    source: rule.source,
    hits: rule.hits,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
  };
}

export interface CategoryDto {
  key: string;
  name: string;
  description: string;
  labelName: string | null;
  defaultAction: string;
  allowTrash: boolean;
  autoTrash: boolean;
  enabled: boolean;
  builtIn: boolean;
  sortOrder: number;
}

export function serializeCategory(category: Category): CategoryDto {
  return { ...category };
}

export interface AiCallDto {
  id: string;
  purpose: string;
  model: string;
  emailCount: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  errorCode: string | null;
  createdAt: string;
}

export function serializeAiCall(call: AiCall): AiCallDto {
  return {
    id: call.id,
    purpose: call.purpose,
    model: call.model,
    emailCount: call.emailCount,
    promptTokens: call.promptTokens,
    outputTokens: call.outputTokens,
    thoughtTokens: call.thoughtTokens,
    costUsd: call.costUsd,
    latencyMs: call.latencyMs,
    ok: call.ok,
    errorCode: call.errorCode,
    createdAt: call.createdAt.toISOString(),
  };
}
