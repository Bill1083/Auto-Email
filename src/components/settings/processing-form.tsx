'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/client';
import type { AppSettings } from '@/lib/settings';

/**
 * The settings shared by the whole install. Anything that belongs to one
 * mailbox — the profile, learned preferences, dry run, the backlog scope and
 * the per-mailbox cap — is edited in the per-mailbox card instead.
 */
type Editable = Omit<
  AppSettings,
  'profileText' | 'learnedNotes' | 'learnedNotesUpdatedAt' | 'dryRun' | 'backlogOrder' | 'backlogQuery'
>;

const GLOBAL_FIELDS: (keyof Editable)[] = [
  'dailyLimit',
  'maxPerRun',
  'aiBatchSize',
  'maxBodyChars',
  'runTimes',
  'newMailPollMinutes',
  'labelPrefix',
  'geminiModel',
  'priceInputPerM',
  'priceOutputPerM',
  'autoTrashMinConfidence',
  'moveReviewOutOfInbox',
  'starAttention',
  'autoPromoteRules',
  'suggestionThreshold',
  'learnedNotesAuto',
];

function pickGlobal(settings: AppSettings): Editable {
  const out = {} as Editable;
  for (const key of GLOBAL_FIELDS) {
    (out as Record<string, unknown>)[key] = settings[key];
  }
  return out;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border px-3 py-2.5">
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

export function ProcessingForm({ settings, timezone }: { settings: AppSettings; timezone: string }) {
  const router = useRouter();
  const [form, setForm] = useState<Editable>(() => pickGlobal(settings));
  const [saving, setSaving] = useState(false);

  const saved = pickGlobal(settings);

  const num = (key: keyof Editable) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value === '' ? 0 : Number(e.target.value) });
  const text = (key: keyof Editable) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const patch: Partial<Editable> = {};
      for (const key of GLOBAL_FIELDS) {
        if (form[key] !== saved[key]) (patch as Record<string, unknown>)[key] = form[key];
      }
      if (Object.keys(patch).length === 0) {
        toast.info('Nothing changed.');
        return;
      }
      // No accountId: these are the shared settings.
      await api('/api/settings?accountId=all', { method: 'PATCH', json: patch });
      toast.success('Shared settings saved.');
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Processing</CardTitle>
          <CardDescription className="mt-1">
            Shared by every mailbox. Dry run, the backlog scope and a mailbox&apos;s own cap are set
            per mailbox below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Default daily cap"
            hint="Emails per mailbox per day, unless that mailbox sets its own. Rule-decided emails count too."
          >
            <Input type="number" min={0} max={5000} value={form.dailyLimit} onChange={num('dailyLimit')} />
          </Field>
          <Field label="Max per run" hint="0 = whatever is left of the daily cap.">
            <Input type="number" min={0} max={5000} value={form.maxPerRun} onChange={num('maxPerRun')} />
          </Field>
          <Field label="Emails per Gemini request" hint="Your profile and rules are paid for once per request.">
            <Input type="number" min={1} max={50} value={form.aiBatchSize} onChange={num('aiBatchSize')} />
          </Field>
          <Field label="Run times" hint={`24h clock in ${timezone}, comma separated. Blank = only manual and cron runs.`}>
            <Input value={form.runTimes} onChange={text('runTimes')} placeholder="07:00,19:00" />
          </Field>
          <Field label="Poll for new mail every (minutes)" hint="0 = only at the run times. The backlog is never touched by polling.">
            <Input type="number" min={0} max={1440} value={form.newMailPollMinutes} onChange={num('newMailPollMinutes')} />
          </Field>
          <Field label="Body characters sent to the model" hint="Longer excerpts cost more tokens and rarely change the decision.">
            <Input type="number" min={200} max={20000} step={100} value={form.maxBodyChars} onChange={num('maxBodyChars')} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">In the mailbox</CardTitle>
          <CardDescription className="mt-1">What the actions do inside Gmail.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Label prefix" hint="Category labels are created as Prefix/Name. Changing it creates new labels; old ones stay.">
            <Input value={form.labelPrefix} onChange={text('labelPrefix')} maxLength={40} />
          </Field>
          <Field label="Auto-trash confidence floor" hint="Auto-trash rules and categories only fire at or above this confidence; below it, the email waits for you.">
            <Input type="number" min={0} max={100} value={form.autoTrashMinConfidence} onChange={num('autoTrashMinConfidence')} />
          </Field>
          <Toggle
            label="Move proposed deletions out of the inbox"
            hint="They sit under the Review label until you confirm or rescue them, so the inbox is clean immediately."
            checked={form.moveReviewOutOfInbox}
            onChange={(v) => setForm({ ...form, moveReviewOutOfInbox: v })}
          />
          <Toggle
            label="Star emails that need attention"
            hint="Attention items get the Attention label and a star, so they stand out on your phone too."
            checked={form.starAttention}
            onChange={(v) => setForm({ ...form, starAttention: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Learning</CardTitle>
          <CardDescription className="mt-1">
            How your reviews turn into rules and preferences. Each mailbox learns from its own
            corrections only.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Suggest a rule after N consistent reviews of a sender">
            <Input type="number" min={1} max={50} value={form.suggestionThreshold} onChange={num('suggestionThreshold')} />
          </Field>
          <div className="space-y-3">
            <Toggle
              label="Create suggested rules automatically"
              hint="Off: suggestions wait for you on the Rules page. On: they become rules after each run."
              checked={form.autoPromoteRules}
              onChange={(v) => setForm({ ...form, autoPromoteRules: v })}
            />
            <Toggle
              label="Refresh learned preferences weekly"
              hint="One Gemini call a week per mailbox, distilling its recent reviews into its own preference list."
              checked={form.learnedNotesAuto}
              onChange={(v) => setForm({ ...form, learnedNotesAuto: v })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Model and prices</CardTitle>
          <CardDescription className="mt-1">
            Costs on the dashboard are the real token counts Gemini reports, multiplied by these prices.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Gemini model" hint="e.g. gemini-2.5-flash or gemini-2.5-flash-lite.">
            <Input value={form.geminiModel} onChange={text('geminiModel')} className="font-mono text-xs" />
          </Field>
          <Field label="Input price (USD per 1M tokens)">
            <Input type="number" min={0} step={0.01} value={form.priceInputPerM} onChange={num('priceInputPerM')} />
          </Field>
          <Field label="Output price (USD per 1M tokens)">
            <Input type="number" min={0} step={0.01} value={form.priceOutputPerM} onChange={num('priceOutputPerM')} />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save shared settings
        </Button>
      </div>
    </form>
  );
}
