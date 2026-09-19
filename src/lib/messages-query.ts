/**
 * Query parsing shared by the messages API and the server-rendered pages.
 */

import type { Prisma } from '@prisma/client';

import { ACTIONS, MESSAGE_STATUSES } from '@/lib/types';

export type MessageView = 'review' | 'attention' | 'deleted' | 'all';

export interface MessageQuery {
  view: MessageView;
  accountId: string | null;
  action: string | null;
  category: string | null;
  decidedBy: string | null;
  status: string | null;
  q: string | null;
  days: number | null;
  page: number;
  pageSize: number;
}

export function parseMessageQuery(params: URLSearchParams): MessageQuery {
  const view = params.get('view');
  const num = (key: string, fallback: number, min: number, max: number) => {
    const raw = Number(params.get(key));
    return Number.isFinite(raw) && raw >= min ? Math.min(max, Math.floor(raw)) : fallback;
  };
  const pick = (key: string, allowed?: readonly string[]) => {
    const value = params.get(key);
    if (!value) return null;
    return !allowed || allowed.includes(value) ? value : null;
  };
  const accountParam = params.get('accountId');
  return {
    view: view === 'review' || view === 'attention' || view === 'deleted' ? view : 'all',
    accountId: accountParam && accountParam !== 'all' ? accountParam : null,
    action: pick('action', ACTIONS),
    category: pick('category'),
    decidedBy: pick('decidedBy', ['rule', 'ai', 'user', 'fallback']),
    status: pick('status', MESSAGE_STATUSES),
    q: params.get('q')?.trim().slice(0, 100) || null,
    days: params.get('days') ? num('days', 0, 1, 3650) || null : null,
    page: num('page', 1, 1, 100_000),
    pageSize: num('pageSize', 50, 1, 200),
  };
}

export function messageWhere(query: MessageQuery): Prisma.MessageWhereInput {
  const where: Prisma.MessageWhereInput = {};
  if (query.accountId) where.accountId = query.accountId;

  switch (query.view) {
    case 'review':
      where.action = 'TRASH';
      where.status = { in: ['PENDING_REVIEW', 'DRY_RUN'] };
      where.userAction = null;
      break;
    case 'attention':
      where.action = 'ATTENTION';
      where.attentionDoneAt = null;
      where.userAction = null;
      where.status = { not: 'REVERTED' };
      break;
    case 'deleted':
      where.status = 'TRASHED';
      break;
    default:
      if (query.action) where.action = query.action;
      if (query.status) where.status = query.status;
  }
  if (query.category) where.category = query.category;
  if (query.decidedBy) where.decidedBy = query.decidedBy;
  if (query.days) where.processedAt = { gte: new Date(Date.now() - query.days * 86_400_000) };
  if (query.q) {
    where.OR = [
      { subject: { contains: query.q } },
      { fromAddress: { contains: query.q } },
      { fromName: { contains: query.q } },
    ];
  }
  return where;
}
