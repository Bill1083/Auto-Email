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

type Editable = Omit<AppSettings, 'profileText' | 'learnedNotes' | 'learnedNotesUpdatedAt'>;

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
  const [form, setForm] = useState<Editable>(settings);
  const [saving, setSaving] = useState(false);

  const num = (key: keyof Editable) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value === '' ? 0 : Number(e.target.value) });
  const text = (key: keyof Editable) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const patch: Partial<Editable> = {};
      for (const key of Object.keys(form) as (keyof Editable)[]) {
        if (form[key] !== settings[key]) (patch as Record<string, unknown>)[key] = form[key];
      }
      if (Object.keys(patch).length === 0) {
        toast.info('Nothing changed.');
        return;
      }
      await api('/api/settings', { method: 'PATCH', json: patch });
      toast.success('Settings saved.');
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
          <CardDescription className="mt-1">How much, how often, and in which order.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Daily cap (emails per mailbox)" hint="Rule-decided emails count too. Raise it to clear the backlog faster.">
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
          <Field label="Backlog order">
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={form.backlogOrder}
              onChange={(e) => setForm({ ...form, backlogOrder: e.target.value as Editable['backlogOrder'] })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </Field>
          <Field label="Backlog search" hint="Gmail search syntax. Defines which existing mail is in scope. Reset the backlog after changing it.">
            <Input value={form.backlogQuery} onChange={text('backlogQuery')} className="font-mono text-xs sm:col-span-2" />
          </Field>
          <div className="sm:col-span-2 lg:col-span-3">
            <Toggle
              label="Dry run"
              hint="Decide and log everything, but change nothing in Gmail. Turn off once you trust the results."
              checked={form.dryRun}
              onChange={(v) => setForm({ ...form, dryRun: v })}
            />
          </div>
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
          <CardDescription className="mt-1">How your reviews turn into rules and preferences.</CardDescription>
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
              hint="One Gemini call a week distils your recent reviews into the preference list."
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
          Save settings
        </Button>
      </div>
    </form>
  );
}
