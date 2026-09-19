'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, Mail, Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { MailboxTabs } from '@/components/shared/mailbox-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/client';
import { formatRelative } from '@/lib/time';

export interface MailboxProfile {
  id: string;
  email: string;
  profileText: string;
  learnedNotes: string;
  learnedNotesUpdatedAt: string;
}

interface Draft {
  profileText: string;
  learnedNotes: string;
}

/**
 * "About you" and the learned preferences, per mailbox.
 *
 * Each mailbox keeps its own: a work address and a personal one want
 * different instructions, and nothing written here is shared between them.
 */
export function ProfileEditor({
  mailboxes,
  defaultId,
  geminiConfigured,
}: {
  mailboxes: MailboxProfile[];
  defaultId: string | null;
  geminiConfigured: boolean;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(defaultId ?? mailboxes[0]?.id ?? null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      mailboxes.map((m) => [m.id, { profileText: m.profileText, learnedNotes: m.learnedNotes }]),
    ),
  );
  const [saved, setSaved] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      mailboxes.map((m) => [m.id, { profileText: m.profileText, learnedNotes: m.learnedNotes }]),
    ),
  );
  const [busy, setBusy] = useState<'profile' | 'notes' | 'regen' | null>(null);

  // Re-seed when a mailbox is connected or disconnected: the page refreshes
  // without remounting, so stale drafts would otherwise shadow the new props.
  const ids = mailboxes.map((m) => m.id).join(',');
  const [knownIds, setKnownIds] = useState(ids);
  if (ids !== knownIds) {
    const seed = Object.fromEntries(
      mailboxes.map((m) => [m.id, { profileText: m.profileText, learnedNotes: m.learnedNotes }]),
    );
    setKnownIds(ids);
    setDrafts(seed);
    setSaved(seed);
    if (!mailboxes.some((m) => m.id === activeId)) setActiveId(mailboxes[0]?.id ?? null);
  }

  if (mailboxes.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">About you</CardTitle>
          <CardDescription className="mt-1">
            Each mailbox gets its own profile and its own learned preferences.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Mail}
            title="No mailbox connected"
            description="Connect a mailbox from Settings, then write a profile for it here."
            className="py-6"
          />
        </CardContent>
      </Card>
    );
  }

  const active = mailboxes.find((m) => m.id === activeId) ?? mailboxes[0];
  const draft = drafts[active.id] ?? { profileText: '', learnedNotes: '' };
  const current = saved[active.id] ?? { profileText: '', learnedNotes: '' };

  function setDraft(patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [active.id]: { ...draft, ...patch } }));
  }

  async function save(field: keyof Draft) {
    setBusy(field === 'profileText' ? 'profile' : 'notes');
    try {
      await api(`/api/settings?accountId=${encodeURIComponent(active.id)}`, {
        method: 'PATCH',
        json: { [field]: draft[field] },
      });
      setSaved((prev) => ({ ...prev, [active.id]: { ...current, [field]: draft[field] } }));
      toast.success(`Saved for ${active.email}.`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy('regen');
    try {
      const data = await api<{ notes: string; costUsd: number }>('/api/rules/learn', {
        method: 'POST',
        json: { accountId: active.id },
      });
      setDraft({ learnedNotes: data.notes });
      setSaved((prev) => ({ ...prev, [active.id]: { ...current, learnedNotes: data.notes } }));
      toast.success(`Learned preferences updated for ${active.email}.`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <MailboxTabs mailboxes={mailboxes} activeId={active.id} onSelect={setActiveId} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">About you</CardTitle>
            <CardDescription className="mt-1">
              Sent with every batch for <strong>{active.email}</strong>, and only that mailbox. Who
              you are there, what matters, what you never want to see. This is the single most
              useful thing you can write.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={draft.profileText}
              onChange={(e) => setDraft({ profileText: e.target.value })}
              rows={8}
              maxLength={4000}
              placeholder={
                'Example: this is my work address for a small tech consultancy. Anything from clients, my accountant or HMRC is important. Order confirmations can be archived. I never read retail promotions or social notifications.'
              }
            />
            <div className="flex items-center justify-between">
              <span className="tnum text-xs text-muted-foreground">
                {draft.profileText.length}/4000
              </span>
              <Button
                size="sm"
                disabled={busy !== null || draft.profileText === current.profileText}
                onClick={() => save('profileText')}
              >
                {busy === 'profile' ? <Loader2 className="animate-spin" /> : <Save />}
                Save
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Learned preferences</CardTitle>
            <CardDescription className="mt-1">
              Distilled from your corrections on <strong>{active.email}</strong>, one line per
              preference, and sent with that mailbox&apos;s batches. Edit or delete any line.
              {active.learnedNotesUpdatedAt
                ? ` Last updated ${formatRelative(active.learnedNotesUpdatedAt)}.`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={draft.learnedNotes}
              onChange={(e) => setDraft({ learnedNotes: e.target.value })}
              rows={8}
              maxLength={4000}
              placeholder="Nothing learned yet. After a few reviews on this mailbox, regenerate to see what the AI has picked up."
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !geminiConfigured}
                title={geminiConfigured ? undefined : 'Needs GEMINI_API_KEY'}
                onClick={regenerate}
              >
                {busy === 'regen' ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Regenerate from reviews
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || draft.learnedNotes === current.learnedNotes}
                onClick={() => save('learnedNotes')}
              >
                {busy === 'notes' ? <Loader2 className="animate-spin" /> : <Save />}
                Save
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
