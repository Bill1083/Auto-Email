'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  Loader2,
  Search,
  ThumbsUp,
  Undo2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';

import { ActionBadge, CategoryBadge, ConfidenceMeter, DecidedByBadge, StatusBadge } from '@/components/shared/badges';
import { EmptyState } from '@/components/shared/empty-state';
import { MessagePreview } from '@/components/shared/message-preview';
import type { CategoryOption } from '@/components/review/review-workbench';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/client';
import type { MessageDto } from '@/lib/serialize';
import { formatRelative } from '@/lib/time';
import { ACTIONS } from '@/lib/types';
import { cn, formatInt } from '@/lib/utils';

interface ListResponse {
  items: MessageDto[];
  total: number;
  page: number;
  pageSize: number;
}

interface Filters {
  view: 'all' | 'deleted';
  q: string;
  action: string;
  category: string;
  decidedBy: string;
  status: string;
  days: string;
}

const PAGE_SIZE = 50;

const SELECT_CLASS = 'h-9 rounded-md border bg-background px-2 text-sm';

export function ActivityTable({
  selectedId,
  categories,
  initial,
}: {
  selectedId: string;
  categories: CategoryOption[];
  initial?: Partial<Filters>;
}) {
  const router = useRouter();
  const names = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c.name])), [categories]);
  const [filters, setFilters] = useState<Filters>({
    view: initial?.view ?? 'all',
    q: initial?.q ?? '',
    action: initial?.action ?? '',
    category: initial?.category ?? '',
    decidedBy: initial?.decidedBy ?? '',
    status: initial?.status ?? '',
    days: initial?.days ?? '',
  });
  const [search, setSearch] = useState(filters.q);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<MessageDto | null>(null);
  const [editing, setEditing] = useState<{ id: string; action: string; category: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      view: filters.view,
      accountId: selectedId,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    for (const key of ['q', 'action', 'category', 'decidedBy', 'status', 'days'] as const) {
      if (filters[key]) params.set(key, filters[key]);
    }
    try {
      setData(await api<ListResponse>(`/api/messages?${params.toString()}`));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filters, page, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  function update(patch: Partial<Filters>) {
    setPage(1);
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  async function run(id: string, request: () => Promise<unknown>, success: string) {
    setBusy(id);
    try {
      await request();
      toast.success(success);
      setEditing(null);
      await load();
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-3">
      {/* Filters: one row, above the data. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: search.trim() });
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject or sender…"
            className="h-9 pl-8"
          />
        </div>
        <select className={SELECT_CLASS} value={filters.view} onChange={(e) => update({ view: e.target.value as Filters['view'], status: '' })}>
          <option value="all">Everything</option>
          <option value="deleted">Deleted (undo available)</option>
        </select>
        <select className={SELECT_CLASS} value={filters.action} onChange={(e) => update({ action: e.target.value })}>
          <option value="">Any action</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a.charAt(0) + a.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <select className={SELECT_CLASS} value={filters.category} onChange={(e) => update({ category: e.target.value })}>
          <option value="">Any category</option>
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
        <select className={SELECT_CLASS} value={filters.decidedBy} onChange={(e) => update({ decidedBy: e.target.value })}>
          <option value="">Decided by anyone</option>
          <option value="ai">AI</option>
          <option value="rule">Rule</option>
          <option value="fallback">Unclassified</option>
        </select>
        {filters.view === 'all' ? (
          <select className={SELECT_CLASS} value={filters.status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Any status</option>
            <option value="APPLIED">Applied</option>
            <option value="PENDING_REVIEW">Awaiting review</option>
            <option value="TRASHED">Trashed</option>
            <option value="DRY_RUN">Dry run</option>
            <option value="REVERTED">Undone</option>
          </select>
        ) : null}
        <select className={SELECT_CLASS} value={filters.days} onChange={(e) => update({ days: e.target.value })}>
          <option value="">All time</option>
          <option value="1">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
        <Button type="submit" variant="outline" size="sm" className="h-9">
          Apply
        </Button>
      </form>

      <div className="overflow-hidden rounded-lg border bg-card">
        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            icon={History}
            title="No matching activity"
            description="Every email the pipeline touches shows up here with what was decided, who decided it, and an undo."
          />
        ) : (
          <ul className={cn('divide-y', loading && 'opacity-60')}>
            {data.items.map((message) => {
              const isEditing = editing?.id === message.id;
              const canUndo = ['APPLIED', 'PENDING_REVIEW', 'TRASHED'].includes(message.status);
              return (
                <li key={message.id} className="grid grid-cols-[minmax(0,1fr)] gap-2 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {message.userAction && message.userAction !== message.action ? (
                        <span className="flex items-center gap-1">
                          <ActionBadge action={message.action} className="opacity-50 line-through" compact />
                          <ActionBadge action={message.userAction} />
                        </span>
                      ) : (
                        <ActionBadge action={message.userAction ?? message.action} />
                      )}
                      <CategoryBadge category={message.userCategory ?? message.category} names={names} />
                      <StatusBadge status={message.status} />
                      <span className="tnum text-xs text-muted-foreground">{formatRelative(message.processedAt)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPreview(message)}
                      className="group mt-1 flex w-full items-start gap-2 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium group-hover:underline">
                          {message.subject || '(no subject)'}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {message.fromName ? `${message.fromName} · ` : ''}
                          {message.fromAddress}
                          {message.accountEmail ? ` · ${message.accountEmail}` : ''}
                        </span>
                      </span>
                      <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                    </button>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/80">Why:</span> {message.reason}
                      {message.guardNote ? <span className="block">{message.guardNote}</span> : null}
                      {message.feedbackNote ? (
                        <span className="block">
                          <span className="font-medium text-foreground/80">Your note:</span> {message.feedbackNote}
                        </span>
                      ) : null}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-3">
                      <ConfidenceMeter value={message.confidence} />
                      <DecidedByBadge decidedBy={message.decidedBy} />
                      {message.userAction ? (
                        <span className="text-xs text-muted-foreground">
                          reviewed {formatRelative(message.feedbackAt)}
                        </span>
                      ) : null}
                    </div>
                    {isEditing ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-muted/50 p-2">
                        <select
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                          value={editing.action}
                          onChange={(e) => setEditing({ ...editing, action: e.target.value })}
                        >
                          {ACTIONS.map((a) => (
                            <option key={a} value={a}>
                              {a.charAt(0) + a.slice(1).toLowerCase()}
                            </option>
                          ))}
                        </select>
                        <select
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                          value={editing.category}
                          onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                        >
                          {categories.map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          className="h-8"
                          disabled={busy === message.id}
                          onClick={() =>
                            run(
                              message.id,
                              () =>
                                api(`/api/messages/${message.id}/feedback`, {
                                  method: 'POST',
                                  json: { action: editing.action, category: editing.category },
                                }),
                              'Applied to the mailbox and remembered.',
                            )
                          }
                        >
                          Apply
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 md:flex-col md:items-stretch">
                    {!message.userAction ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 justify-start px-2 text-muted-foreground hover:text-foreground"
                        title="This decision was right"
                        disabled={busy === message.id}
                        onClick={() =>
                          run(
                            message.id,
                            () => api(`/api/messages/${message.id}/feedback`, { method: 'POST', json: { action: 'CONFIRM' } }),
                            'Marked as correct.',
                          )
                        }
                      >
                        <ThumbsUp />
                        <span className="hidden lg:inline">Correct</span>
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 justify-start px-2 text-muted-foreground hover:text-foreground"
                      title="Change what happens to this email"
                      disabled={busy === message.id}
                      onClick={() =>
                        setEditing(
                          isEditing
                            ? null
                            : {
                                id: message.id,
                                action: message.userAction ?? message.action,
                                category: message.userCategory ?? message.category,
                              },
                        )
                      }
                    >
                      <Wand2 />
                      <span className="hidden lg:inline">Change</span>
                    </Button>
                    {canUndo ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 justify-start px-2 text-muted-foreground hover:text-foreground"
                        title="Put it back exactly as it was"
                        disabled={busy === message.id}
                        onClick={() =>
                          run(
                            message.id,
                            () => api(`/api/messages/${message.id}/undo`, { method: 'POST' }),
                            'Reverted in the mailbox.',
                          )
                        }
                      >
                        <Undo2 />
                        <span className="hidden lg:inline">Undo</span>
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {data ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tnum">
            {formatInt(data.total)} result{data.total === 1 ? '' : 's'} · page {page} of {totalPages}
          </span>
          <span className="flex gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
              Prev
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              Next
              <ChevronRight />
            </Button>
          </span>
        </div>
      ) : null}

      <MessagePreview message={preview} names={names} onOpenChange={(open) => !open && setPreview(null)} />
    </div>
  );
}
