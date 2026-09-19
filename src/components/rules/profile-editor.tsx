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

export function ProfileEditor({
  profileText,
  learnedNotes,
  learnedNotesUpdatedAt,
  geminiConfigured,
}: {
  profileText: string;
  learnedNotes: string;
  learnedNotesUpdatedAt: string;
  geminiConfigured: boolean;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState(profileText);
  const [notes, setNotes] = useState(learnedNotes);
  const [saving, setSaving] = useState<'profile' | 'notes' | 'regen' | null>(null);

  async function save(field: 'profileText' | 'learnedNotes', value: string) {
    setSaving(field === 'profileText' ? 'profile' : 'notes');
    try {
      await api('/api/settings', { method: 'PATCH', json: { [field]: value } });
      toast.success('Saved.');
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(null);
    }
  }

  async function regenerate() {
    setSaving('regen');
    try {
      const data = await api<{ notes: string; costUsd: number }>('/api/rules/learn', { method: 'POST' });
      setNotes(data.notes);
      toast.success('Learned preferences updated.');
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">About you</CardTitle>
          <CardDescription className="mt-1">
            Sent with every batch. Who you are, what you care about, what you never want to see. This is
            the single most useful thing you can write.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            rows={8}
            maxLength={4000}
            placeholder={
              'Example: I run a small tech consultancy and trade futures with a prop firm. Anything from clients, my accountant, HMRC, my broker or the prop firm is important. Order confirmations can be archived. I never read retail promotions or social notifications.'
            }
          />
          <div className="flex items-center justify-between">
            <span className="tnum text-xs text-muted-foreground">{profile.length}/4000</span>
            <Button size="sm" disabled={saving !== null || profile === profileText} onClick={() => save('profileText', profile)}>
              {saving === 'profile' ? <Loader2 className="animate-spin" /> : <Save />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Learned preferences</CardTitle>
          <CardDescription className="mt-1">
            Distilled from your corrections, one line per preference, and sent with every batch. Edit or
            delete any line; regenerate to fold in recent reviews.
            {learnedNotesUpdatedAt ? ` Last updated ${formatRelative(learnedNotesUpdatedAt)}.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={8}
            maxLength={4000}
            placeholder="Nothing learned yet. After a few reviews, regenerate to see what the AI has picked up."
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={saving !== null || !geminiConfigured}
              title={geminiConfigured ? undefined : 'Needs GEMINI_API_KEY'}
              onClick={regenerate}
            >
              {saving === 'regen' ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Regenerate from reviews
            </Button>
            <Button size="sm" disabled={saving !== null || notes === learnedNotes} onClick={() => save('learnedNotes', notes)}>
              {saving === 'notes' ? <Loader2 className="animate-spin" /> : <Save />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
