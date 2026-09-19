'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, Plus, ScrollText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ActionBadge, CategoryBadge } from '@/components/shared/badges';
import { EmptyState } from '@/components/shared/empty-state';
import type { CategoryOption } from '@/components/review/review-workbench';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/client';
import type { AccountDto, RuleDto } from '@/lib/serialize';
import { ACTIONS, RULE_KINDS, type RuleKind } from '@/lib/types';
import { cn, formatInt } from '@/lib/utils';

const KIND_LABEL: Record<RuleKind, string> = {
  SENDER: 'Sender',
  DOMAIN: 'Domain',
  SUBJECT_CONTAINS: 'Subject contains',
  FREEFORM: 'Instruction',
};

const SELECT_CLASS = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

export function RulesManager({
  rules,
  categories,
  accounts,
  selectedId,
}: {
  rules: RuleDto[];
  categories: CategoryOption[];
  accounts: AccountDto[];
  selectedId: string;
}) {
  const router = useRouter();
  const names = Object.fromEntries(categories.map((c) => [c.key, c.name]));
  const emailById = Object.fromEntries(accounts.map((a) => [a.id, a.email]));
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(rules.length === 0);
  const [form, setForm] = useState({
    kind: 'SENDER' as RuleKind,
    pattern: '',
    action: 'KEEP' as (typeof ACTIONS)[number],
    category: '',
    note: '',
    autoApply: false,
    accountId: selectedId === 'all' ? '' : selectedId,
  });

  async function mutate(id: string, request: () => Promise<unknown>, success?: string) {
    setBusy(id);
    try {
      await request();
      if (success) toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    await mutate(
      'new',
      () =>
        api('/api/rules', {
          method: 'POST',
          json: {
            accountId: form.accountId || null,
            kind: form.kind,
            pattern: form.pattern,
            action: form.kind === 'FREEFORM' ? null : form.action,
            category: form.category || null,
            note: form.note,
            autoApply: form.autoApply,
          },
        }),
      'Rule added. It applies from the next run.',
    );
    setForm((prev) => ({ ...prev, pattern: '', note: '', autoApply: false }));
    setShowForm(false);
  }

  const matching = rules.filter((r) => r.kind !== 'FREEFORM');
  const instructions = rules.filter((r) => r.kind === 'FREEFORM');

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Rules</CardTitle>
            <CardDescription className="mt-1">
              Sender, domain and subject rules decide an email before the AI sees it, at no cost. Instructions
              are free text the AI reads with every batch.
            </CardDescription>
          </div>
          <Button size="sm" variant={showForm ? 'secondary' : 'default'} onClick={() => setShowForm((v) => !v)}>
            <Plus />
            New rule
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {showForm ? (
          <form onSubmit={create} className="grid gap-3 rounded-md border bg-muted/30 p-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <select
                className={SELECT_CLASS}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as RuleKind })}
              >
                {RULE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Applies to</Label>
              <select
                className={SELECT_CLASS}
                value={form.accountId}
                onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              >
                <option value="">All mailboxes</option>
                {/* With a mailbox chosen in the top right, a rule is for that
                    mailbox or for all of them, never quietly for another. */}
                {accounts
                  .filter((a) => selectedId === 'all' || a.id === selectedId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {selectedId === 'all' ? a.email : `This mailbox (${a.email})`}
                    </option>
                  ))}
              </select>
            </div>

            {form.kind === 'FREEFORM' ? (
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Instruction</Label>
                <Textarea
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  rows={3}
                  required
                  placeholder='e.g. "Anything mentioning an invoice or a payout is Finance and must never be trashed."'
                />
              </div>
            ) : (
              <>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>
                    {form.kind === 'SENDER'
                      ? 'Sender address'
                      : form.kind === 'DOMAIN'
                        ? 'Domain'
                        : 'Subject contains'}
                  </Label>
                  <Input
                    value={form.pattern}
                    onChange={(e) => setForm({ ...form, pattern: e.target.value })}
                    required
                    placeholder={
                      form.kind === 'SENDER'
                        ? 'newsletter@example.com (or *@example.com)'
                        : form.kind === 'DOMAIN'
                          ? 'example.com (matches subdomains too)'
                          : 'invoice'
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Action</Label>
                  <select
                    className={SELECT_CLASS}
                    value={form.action}
                    onChange={(e) => setForm({ ...form, action: e.target.value as (typeof ACTIONS)[number] })}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a.charAt(0) + a.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <select
                    className={SELECT_CLASS}
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    <option value="">Let the AI pick the category</option>
                    {categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                {form.action === 'TRASH' ? (
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Switch checked={form.autoApply} onCheckedChange={(v) => setForm({ ...form, autoApply: v })} />
                    Trash immediately, without waiting for my confirmation
                  </label>
                ) : null}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Note (optional)</Label>
                  <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why this rule exists" />
                </div>
              </>
            )}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy === 'new'}>
                {busy === 'new' ? <Loader2 className="animate-spin" /> : <Plus />}
                Add rule
              </Button>
            </div>
          </form>
        ) : null}

        {matching.length === 0 && instructions.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No rules yet"
            description="Add a sender or domain rule for the mail you always know what to do with, or an instruction for the AI."
            className="py-6"
          />
        ) : null}

        {matching.length > 0 ? (
          <div className="overflow-hidden rounded-md border">
            <ul className="divide-y">
              {matching.map((rule) => (
                <li key={rule.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2', !rule.enabled && 'opacity-60')}>
                  <Badge variant="secondary" className="w-28 justify-center">
                    {KIND_LABEL[rule.kind as RuleKind] ?? rule.kind}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm" title={rule.pattern}>
                    {rule.pattern}
                  </span>
                  {rule.action ? <ActionBadge action={rule.action} /> : null}
                  {rule.category ? <CategoryBadge category={rule.category} names={names} /> : <span className="text-xs text-muted-foreground">AI picks category</span>}
                  <span className="text-xs text-muted-foreground">
                    {rule.accountId ? emailById[rule.accountId] ?? 'one mailbox' : 'all mailboxes'}
                    {' · '}
                    {formatInt(rule.hits)} hit{rule.hits === 1 ? '' : 's'}
                    {rule.source === 'learned' ? ' · learned' : ''}
                  </span>
                  {rule.action === 'TRASH' ? (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Trash without review">
                      <Switch
                        checked={rule.autoApply}
                        disabled={busy === rule.id}
                        onCheckedChange={(v) =>
                          mutate(rule.id, () => api(`/api/rules/${rule.id}`, { method: 'PATCH', json: { autoApply: v } }))
                        }
                      />
                      auto
                    </label>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Enabled">
                    <Switch
                      checked={rule.enabled}
                      disabled={busy === rule.id}
                      onCheckedChange={(v) =>
                        mutate(rule.id, () => api(`/api/rules/${rule.id}`, { method: 'PATCH', json: { enabled: v } }))
                      }
                    />
                    on
                  </label>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-danger"
                    aria-label="Delete rule"
                    disabled={busy === rule.id}
                    onClick={() => mutate(rule.id, () => api(`/api/rules/${rule.id}`, { method: 'DELETE' }), 'Rule deleted.')}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {instructions.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Instructions for the AI</p>
            <ul className="space-y-2">
              {instructions.map((rule) => (
                <li key={rule.id} className={cn('flex items-start gap-3 rounded-md border px-3 py-2', !rule.enabled && 'opacity-60')}>
                  <p className="min-w-0 flex-1 text-sm">{rule.note || rule.pattern}</p>
                  <span className="text-xs text-muted-foreground">
                    {rule.accountId ? emailById[rule.accountId] ?? 'one mailbox' : 'all mailboxes'}
                  </span>
                  <Switch
                    checked={rule.enabled}
                    disabled={busy === rule.id}
                    onCheckedChange={(v) =>
                      mutate(rule.id, () => api(`/api/rules/${rule.id}`, { method: 'PATCH', json: { enabled: v } }))
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-danger"
                    aria-label="Delete instruction"
                    disabled={busy === rule.id}
                    onClick={() => mutate(rule.id, () => api(`/api/rules/${rule.id}`, { method: 'DELETE' }), 'Instruction deleted.')}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
