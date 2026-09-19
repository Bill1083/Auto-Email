'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, Mail, Save } from 'lucide-react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { MailboxTabs } from '@/components/shared/mailbox-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/client';

export interface MailboxSettingsValues {
  id: string;
  email: string;
  /** Null means "use the shared cap". Lives on the account, not in settings. */
  dailyLimit: number | null;
  dryRun: boolean;
  backlogOrder: 'newest' | 'oldest';
  backlogQuery: string;
}

/**
 * The settings that belong to one mailbox rather than the whole install.
 * Dry run especially: you can trust the personal mailbox while the work one
 * is still only watching.
 */
export function MailboxSettings({
  mailboxes,
  defaultId,
  defaultDailyLimit,
}: {
  mailboxes: MailboxSettingsValues[];
  defaultId: string | null;
  defaultDailyLimit: number;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(defaultId ?? mailboxes[0]?.id ?? null);
  const [drafts, setDrafts] = useState<Record<string, MailboxSettingsValues>>(() =>
    Object.fromEntries(mailboxes.map((m) => [m.id, m])),
  );
  const [saved, setSaved] = useState<Record<string, MailboxSettingsValues>>(() =>
    Object.fromEntries(mailboxes.map((m) => [m.id, m])),
  );
  const [busy, setBusy] = useState(false);

  // Connecting or disconnecting a mailbox refreshes this page without
  // remounting, so re-seed from the new props when the set of mailboxes
  // changes. Without this the tabs can outlive their drafts.
  const ids = mailboxes.map((m) => m.id).join(',');
  const [knownIds, setKnownIds] = useState(ids);
  if (ids !== knownIds) {
    setKnownIds(ids);
    setDrafts(Object.fromEntries(mailboxes.map((m) => [m.id, m])));
    setSaved(Object.fromEntries(mailboxes.map((m) => [m.id, m])));
    if (!mailboxes.some((m) => m.id === activeId)) setActiveId(mailboxes[0]?.id ?? null);
  }

  if (mailboxes.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Per-mailbox settings</CardTitle>
          <CardDescription className="mt-1">
            Dry run, the daily cap and the backlog scope are set for each mailbox separately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Mail}
            title="No mailbox connected"
            description="Connect a mailbox above and its own settings appear here."
            className="py-6"
          />
        </CardContent>
      </Card>
    );
  }

  const active = drafts[activeId ?? mailboxes[0].id] ?? mailboxes[0];
  const current = saved[active.id] ?? active;
  const dirty =
    active.dailyLimit !== current.dailyLimit ||
    active.dryRun !== current.dryRun ||
    active.backlogOrder !== current.backlogOrder ||
    active.backlogQuery !== current.backlogQuery;

  function setDraft(patch: Partial<MailboxSettingsValues>) {
    setDrafts((prev) => ({ ...prev, [active.id]: { ...active, ...patch } }));
  }

  async function save() {
    setBusy(true);
    try {
      if (
        active.dryRun !== current.dryRun ||
        active.backlogOrder !== current.backlogOrder ||
        active.backlogQuery !== current.backlogQuery
      ) {
        await api(`/api/settings?accountId=${encodeURIComponent(active.id)}`, {
          method: 'PATCH',
          json: {
            dryRun: active.dryRun,
            backlogOrder: active.backlogOrder,
            backlogQuery: active.backlogQuery,
          },
        });
      }
      // The daily cap is an account column, not a setting row.
      if (active.dailyLimit !== current.dailyLimit) {
        await api(`/api/accounts/${active.id}`, {
          method: 'PATCH',
          json: { dailyLimit: active.dailyLimit },
        });
      }
      setSaved((prev) => ({ ...prev, [active.id]: active }));
      toast.success(`Saved for ${active.email}.`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Per-mailbox settings</CardTitle>
        <CardDescription className="mt-1">
          These belong to one mailbox each, so a mailbox you trust can be live while another is
          still only watching. The profile and learned preferences are per mailbox too, on the
          Rules page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MailboxTabs mailboxes={mailboxes} activeId={active.id} onSelect={setActiveId} />

        <div className="rounded-md border p-3">
          <p className="mb-3 text-sm font-medium">{active.email}</p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Daily cap</Label>
              <Input
                type="number"
                min={0}
                max={5000}
                placeholder={`${defaultDailyLimit} (shared default)`}
                value={active.dailyLimit === null ? '' : String(active.dailyLimit)}
                onChange={(e) =>
                  setDraft({ dailyLimit: e.target.value.trim() === '' ? null : Number(e.target.value) })
                }
              />
              <p className="text-xs text-muted-foreground">
                Emails this mailbox may touch per day. Blank uses the shared default.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Backlog order</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={active.backlogOrder}
                onChange={(e) =>
                  setDraft({ backlogOrder: e.target.value as MailboxSettingsValues['backlogOrder'] })
                }
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Which end of this mailbox&apos;s history to work through first.
              </p>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label>Backlog search</Label>
              <Input
                className="font-mono text-xs"
                value={active.backlogQuery}
                onChange={(e) => setDraft({ backlogQuery: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Gmail search defining what counts as this mailbox&apos;s backlog. Reset the backlog
                after changing it.
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-md border px-3 py-2.5 sm:col-span-2">
              <Switch
                checked={active.dryRun}
                onCheckedChange={(v) => setDraft({ dryRun: v })}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">Dry run</span>
                <span className="block text-xs text-muted-foreground">
                  Decide and log everything for this mailbox, but change nothing in Gmail. Turn it
                  off once you trust what the review queue shows.
                </span>
              </span>
            </label>
          </div>

          <div className="mt-4 flex justify-end">
            <Button size="sm" onClick={save} disabled={busy || !dirty}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              Save for this mailbox
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
