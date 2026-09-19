'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

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

/**
 * "About you" and the learned preferences for the mailbox selected in the
 * top-right switcher. The parent keys this component by mailbox id, so
 * switching mailbox starts it fresh and a draft can never be saved into the
 * wrong mailbox.
 */
export function ProfileEditor({
  mailbox,
  geminiConfigured,
}: {
  mailbox: MailboxProfile;
  geminiConfigured: boolean;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState(mailbox.profileText);
  const [notes, setNotes] = useState(mailbox.learnedNotes);
  const [savedProfile, setSavedProfile] = useState(mailbox.profileText);
  const [savedNotes, setSavedNotes] = useState(mailbox.learnedNotes);
  const [busy, setBusy] = useState<'profile' | 'notes' | 'regen' | null>(null);

  const endpoint = `/api/settings?accountId=${encodeURIComponent(mailbox.id)}`;

  async function saveProfile() {
    setBusy('profile');
    try {
      await api(endpoint, { method: 'PATCH', json: { profileText: profile } });
      setSavedProfile(profile);
      toast.success(`Saved for ${mailbox.email}.`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveNotes() {
    setBusy('notes');
    try {
      await api(endpoint, { method: 'PATCH', json: { learnedNotes: notes } });
      setSavedNotes(notes);
      toast.success(`Saved for ${mailbox.email}.`);
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
        json: { accountId: mailbox.id },
      });
      setNotes(data.notes);
      setSavedNotes(data.notes);
      toast.success(`Learned preferences updated for ${mailbox.email}.`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">About you</CardTitle>
          <CardDescription className="mt-1">
            Sent with every batch for <strong>{mailbox.email}</strong>, and only that mailbox. Who you
            are there, what matters, what you never want to see. This is the single most useful thing
            you can write.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            rows={8}
            maxLength={4000}
            placeholder={
              'Example: this is my work address for a small tech consultancy. Anything from clients, my accountant or HMRC is important. Order confirmations can be archived. I never read retail promotions or social notifications.'
            }
          />
          <div className="flex items-center justify-between">
            <span className="tnum text-xs text-muted-foreground">{profile.length}/4000</span>
            <Button size="sm" disabled={busy !== null || profile === savedProfile} onClick={saveProfile}>
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
            Distilled from your corrections on <strong>{mailbox.email}</strong>, one line per
            preference, and sent with that mailbox&apos;s batches. Edit or delete any line.
            {mailbox.learnedNotesUpdatedAt
              ? ` Last updated ${formatRelative(mailbox.learnedNotesUpdatedAt)}.`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
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
            <Button size="sm" disabled={busy !== null || notes === savedNotes} onClick={saveNotes}>
              {busy === 'notes' ? <Loader2 className="animate-spin" /> : <Save />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
