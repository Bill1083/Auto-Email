'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  CheckCheck,
  Eye,
  Inbox,
  Loader2,
  MailCheck,
  Paperclip,
  RefreshCw,
  ShieldOff,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';

import { JOBS_CHANGED_EVENT, useJobs } from '@/components/shared/background-jobs';
import { CategoryBadge, ConfidenceMeter, DecidedByBadge } from '@/components/shared/badges';
import { EmptyState } from '@/components/shared/empty-state';
import { MessagePreview } from '@/components/shared/message-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/client';
import { friendlyReason } from '@/lib/gemini-errors';
import { jobDoing } from '@/lib/job-text';
import type { MessageDto } from '@/lib/serialize';
import { formatRelative } from '@/lib/time';
import { cn } from '@/lib/utils';

interface ListResponse {
  items: MessageDto[];
  total: number;
}

type Tab = 'review' | 'attention';
/** RETRY asks the AI to sort an unclassified email again. */
type BulkAction = 'KEEP' | 'ARCHIVE' | 'TRASH' | 'DONE' | 'RETRY';

export interface CategoryOption {
  key: string;
  name: string;
}

export function ReviewWorkbench({
  selectedId,
  categories,
  dryRun,
  initialTab = 'review',
}: {
  selectedId: string;
  categories: CategoryOption[];
  dryRun: boolean;
  initialTab?: Tab;
}) {
  const jobs = useJobs();
  const names = useMemo(() => Object.fromEntries(categories.map((c) => [c.key, c.name])), [categories]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [review, setReview] = useState<MessageDto[] | null>(null);
  const [attention, setAttention] = useState<MessageDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MessageDto | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  // How many are waiting in total, which is more than the page shows once a
  // queue grows past the page size.
  const [totals, setTotals] = useState<{ review: number; attention: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        api<ListResponse>(`/api/messages?view=review&accountId=${encodeURIComponent(selectedId)}&pageSize=200`),
        api<ListResponse>(`/api/messages?view=attention&accountId=${encodeURIComponent(selectedId)}&pageSize=200`),
      ]);
      setReview(r.items);
      setAttention(a.items);
      setTotals({ review: r.total, attention: a.total });
      setSelected(new Set());
    } catch (error) {
      toast.error(errorMessage(error));
      setReview([]);
      setAttention([]);
      setTotals(null);
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A background job finishing can put emails back (failures, or a re-sort
  // that still needs attention), so the lists catch up when one does.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(JOBS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(JOBS_CHANGED_EVENT, onChanged);
  }, [load]);

  const items = tab === 'review' ? review : attention;
  const allSelected = items !== null && items.length > 0 && items.every((m) => selected.has(m.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!items) return;
    setSelected(allSelected ? new Set() : new Set(items.map((m) => m.id)));
  }

  /**
   * Hand the action to the server and clear the emails from view at once.
   * The work carries on in the background, so the page can be left or even
   * closed; the header shows progress and a note appears when it finishes.
   */
  async function act(ids: string[], action: BulkAction, category?: string) {
    if (ids.length === 0) return;
    if (!jobs) {
      toast.error('Background actions are unavailable; reload the page.');
      return;
    }
    const single = ids.length === 1 ? overrides[ids[0]] : undefined;
    const chosen = category ?? single;
    setBusy(true);
    const job = await jobs.enqueue({ action, ids, accountId: selectedId, ...(chosen ? { category: chosen } : {}) });
    setBusy(false);
    if (!job) return;

    const gone = new Set(ids);
    setReview((prev) => (prev ? prev.filter((m) => !gone.has(m.id)) : prev));
    setAttention((prev) => (prev ? prev.filter((m) => !gone.has(m.id)) : prev));
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    setTotals((prev) =>
      prev
        ? tab === 'attention'
          ? { ...prev, attention: Math.max(0, prev.attention - job.total) }
          : { ...prev, review: Math.max(0, prev.review - job.total) }
        : prev,
    );
    if (ids.length > 1) {
      toast.success(`${jobDoing(action)}: ${job.total} emails, in the background. You can leave this page.`);
      // The server leaves queued emails out, so this brings in whatever is
      // next without the ones just handed off.
      void load();
    }
  }

  /** Every proposed deletion, not just the page that is loaded. */
  async function trashEverything() {
    setConfirmAll(false);
    if (!jobs) return;
    setBusy(true);
    const job = await jobs.enqueue({ action: 'TRASH', view: 'review', accountId: selectedId });
    setBusy(false);
    if (!job) return;
    setReview([]);
    setSelected(new Set());
    toast.success(`Moving ${job.total} emails to Trash in the background. You can leave this page.`);
    void load();
  }

  async function neverFlag(message: MessageDto) {
    setBusy(true);
    try {
      await api('/api/rules', {
        method: 'POST',
        json: {
          accountId: null,
          kind: 'SENDER',
          pattern: message.fromAddress,
          action: 'KEEP',
          category: overrides[message.id] ?? message.category,
          note: 'Created from "never flag this sender".',
        },
      });
      toast.success(`Rule added: ${message.fromAddress} → Keep.`);
      await act([message.id], 'DONE');
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  const selectedIds = [...selected].filter((id) => items?.some((m) => m.id === id));
  // Emails the AI failed on earlier (usually because Gemini was busy).
  const unclassified = (attention ?? []).filter((m) => m.decidedBy === 'fallback');

  return (
    <div className="space-y-4">
      {dryRun ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            Dry run is on: these are what the pipeline <em>would</em> do. Confirming a deletion here still
            moves that email to Trash, so you can start trusting it one email at a time.
          </p>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="review">
              Delete queue
              <Count value={totals?.review ?? (review ? review.length : null)} />
            </TabsTrigger>
            <TabsTrigger value="attention">
              Needs attention
              <Count value={totals?.attention ?? (attention ? attention.length : null)} />
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>
              <RefreshCw className={cn(busy && 'animate-spin')} />
              Refresh
            </Button>
            {tab === 'attention' && unclassified.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void act(unclassified.map((m) => m.id), 'RETRY')}
                disabled={busy}
                title="Ask the AI to sort the emails it could not classify before"
              >
                <Sparkles />
                Sort {unclassified.length} unclassified again
              </Button>
            ) : null}
            {tab === 'review' && review && review.length > 0 ? (
              <Button variant="destructive" size="sm" onClick={() => setConfirmAll(true)} disabled={busy}>
                <Trash2 />
                Trash all {totals?.review ?? review.length}
              </Button>
            ) : null}
          </div>
        </div>


        {/* Bulk bar */}
        {selectedIds.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
            <span className="font-medium">{selectedIds.length} selected</span>
            <span className="ml-auto flex flex-wrap gap-1.5">
              {tab === 'review' ? (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act(selectedIds, 'KEEP')}>
                    <Inbox />
                    Keep
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act(selectedIds, 'ARCHIVE')}>
                    <Archive />
                    Archive
                  </Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => act(selectedIds, 'TRASH')}>
                    <Trash2 />
                    Trash
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act(selectedIds, 'DONE')}>
                    <CheckCheck />
                    Done
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act(selectedIds, 'ARCHIVE')}>
                    <Archive />
                    Archive
                  </Button>
                </>
              )}
            </span>
          </div>
        ) : null}

        <TabsContent value="review" className="mt-3">
          <MessageList
            items={review}
            total={totals?.review ?? null}
            names={names}
            categories={categories}
            selected={selected}
            allSelected={allSelected && tab === 'review'}
            overrides={overrides}
            busy={busy}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onOverride={(id, category) => setOverrides((prev) => ({ ...prev, [id]: category }))}
            onPreview={setPreview}
            empty={
              <EmptyState
                icon={MailCheck}
                title="The delete queue is empty"
                description="Proposed deletions land here after each run. Confirm them in bulk or rescue the ones that matter; every choice teaches the AI."
              />
            }
            renderActions={(message) => (
              <>
                <RowButton icon={Inbox} label="Keep" disabled={busy} onClick={() => act([message.id], 'KEEP')} />
                <RowButton icon={Archive} label="Archive" disabled={busy} onClick={() => act([message.id], 'ARCHIVE')} />
                <RowButton
                  icon={Trash2}
                  label="Trash"
                  disabled={busy}
                  destructive
                  onClick={() => act([message.id], 'TRASH')}
                />
              </>
            )}
          />
        </TabsContent>

        <TabsContent value="attention" className="mt-3">
          <MessageList
            items={attention}
            total={totals?.attention ?? null}
            names={names}
            categories={categories}
            selected={selected}
            allSelected={allSelected && tab === 'attention'}
            overrides={overrides}
            busy={busy}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onOverride={(id, category) => setOverrides((prev) => ({ ...prev, [id]: category }))}
            onPreview={setPreview}
            empty={
              <EmptyState
                icon={CheckCheck}
                title="Nothing needs your attention"
                description="Emails the AI thinks you must read, answer or act on appear here, starred in Gmail, until you mark them done."
              />
            }
            renderActions={(message) => (
              <>
                {message.decidedBy === 'fallback' ? (
                  <RowButton
                    icon={Sparkles}
                    label="Sort again"
                    title="Ask the AI to classify this email again"
                    disabled={busy}
                    onClick={() => act([message.id], 'RETRY')}
                  />
                ) : null}
                <RowButton icon={CheckCheck} label="Done" disabled={busy} onClick={() => act([message.id], 'DONE')} />
                <RowButton icon={Archive} label="Archive" disabled={busy} onClick={() => act([message.id], 'ARCHIVE')} />
                <RowButton
                  icon={ShieldOff}
                  label="Never flag"
                  title="Add a rule so this sender is kept without being flagged"
                  disabled={busy}
                  onClick={() => neverFlag(message)}
                />
              </>
            )}
          />
        </TabsContent>
      </Tabs>

      <MessagePreview message={preview} names={names} onOpenChange={(open) => !open && setPreview(null)} />

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {totals?.review ?? review?.length ?? 0} emails to Trash?</DialogTitle>
            <DialogDescription>
              Everything currently in the delete queue goes to Gmail&apos;s Trash. It runs on the server, so
              you can carry on reviewing or close the page. Gmail keeps trashed mail for 30 days and each one can be
              undone from the Activity page until then.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void trashEverything()}
            >
              <Trash2 />
              Trash all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Count({ value }: { value: number | null }) {
  if (value === null) return <Loader2 className="ml-1.5 size-3 animate-spin" />;
  return (
    <span className="tnum ml-1.5 rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
      {value}
    </span>
  );
}

function RowButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
  title,
}: {
  icon: typeof Inbox;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
}) {
  return (
    <Button
      size="sm"
      variant={destructive ? 'destructive' : 'ghost'}
      className={cn('h-8 px-2', !destructive && 'text-muted-foreground hover:text-foreground')}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      <Icon />
      <span className="hidden lg:inline">{label}</span>
    </Button>
  );
}

function MessageList({
  items,
  total,
  names,
  categories,
  selected,
  allSelected,
  overrides,
  busy,
  onToggle,
  onToggleAll,
  onOverride,
  onPreview,
  renderActions,
  empty,
}: {
  items: MessageDto[] | null;
  /** The whole queue, which is larger than `items` once it passes a page. */
  total: number | null;
  names: Record<string, string>;
  categories: CategoryOption[];
  selected: Set<string>;
  allSelected: boolean;
  overrides: Record<string, string>;
  busy: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onOverride: (id: string, category: string) => void;
  onPreview: (message: MessageDto) => void;
  renderActions: (message: MessageDto) => React.ReactNode;
  empty: React.ReactNode;
}) {
  if (items === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading…
      </div>
    );
  }
  if (items.length === 0) return <div className="rounded-lg border bg-card">{empty}</div>;

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
        <Checkbox checked={allSelected} onCheckedChange={onToggleAll} aria-label="Select all" />
        <span>Select all {items.length}</span>
        {total !== null && total > items.length ? (
          <span>
            · {total} waiting in all; the rest load as these are cleared
          </span>
        ) : null}
      </div>
      <ul className="divide-y">
        {items.map((message) => {
          const category = overrides[message.id] ?? message.category;
          return (
            <li
              key={message.id}
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-2.5 md:grid-cols-[auto_minmax(0,1fr)_auto]',
                selected.has(message.id) && 'bg-primary/5',
              )}
            >
              <Checkbox
                className="mt-1"
                checked={selected.has(message.id)}
                onCheckedChange={() => onToggle(message.id)}
                aria-label={`Select ${message.subject}`}
              />
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => onPreview(message)}
                  className="group flex w-full min-w-0 items-start gap-2 text-left"
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
                  <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{message.snippet}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <select
                    value={category}
                    disabled={busy}
                    onChange={(e) => onOverride(message.id, e.target.value)}
                    aria-label="Category"
                    className="h-6 rounded-md border bg-background px-1.5 text-xs"
                  >
                    {categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.name}
                      </option>
                    ))}
                    {!categories.some((c) => c.key === category) ? (
                      <option value={category}>{names[category] ?? category}</option>
                    ) : null}
                  </select>
                  <ConfidenceMeter value={message.confidence} />
                  <DecidedByBadge decidedBy={message.decidedBy} />
                  {message.needsReply ? <Badge variant="warning">Needs reply</Badge> : null}
                  {message.hasAttachments ? <Paperclip className="size-3 text-muted-foreground" /> : null}
                  <span className="tnum text-xs text-muted-foreground">{formatRelative(message.internalDate)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">Why:</span> {friendlyReason(message.reason)}
                  {message.guardNote ? <span className="block">{message.guardNote}</span> : null}
                </p>
              </div>
              <div className="col-span-2 flex flex-wrap items-center gap-1 md:col-span-1 md:flex-col md:items-stretch">
                {renderActions(message)}
              </div>
              <span className="sr-only">
                <CategoryBadge category={category} names={names} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
