'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Lightbulb, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { ActionBadge, CategoryBadge, categoryName } from '@/components/shared/badges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/client';
import type { CategoryNudge, RuleSuggestion } from '@/lib/pipeline/learning';
import { formatRelative } from '@/lib/time';

export function SuggestionsList({
  suggestions,
  nudges,
  threshold,
  names,
}: {
  suggestions: RuleSuggestion[];
  nudges: CategoryNudge[];
  threshold: number;
  names: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, request: () => Promise<unknown>, success: string) {
    setBusy(key);
    try {
      await request();
      toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (suggestions.length === 0 && nudges.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Suggested rules</CardTitle>
          <CardDescription className="mt-1">
            After you correct or confirm the same sender {threshold} times, a rule is suggested here. Nothing yet.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-primary" />
          Suggested rules
        </CardTitle>
        <CardDescription className="mt-1">
          Learned from how you reviewed decisions. Accepting one makes it a rule; dismissing hides it for good.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {nudges.map((nudge) => (
          <div key={nudge.category} className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              You confirmed <strong>{nudge.confirmed}</strong> deletions in{' '}
              <strong>{categoryName(nudge.category, names)}</strong> with no rescues in the last 90 days. Trash that
              category automatically from now on?
            </span>
            <Button
              size="sm"
              disabled={busy === `nudge:${nudge.category}`}
              onClick={() =>
                act(
                  `nudge:${nudge.category}`,
                  () => api(`/api/categories/${nudge.category}`, { method: 'PATCH', json: { autoTrash: true } }),
                  `${categoryName(nudge.category, names)} is now auto-trashed above the confidence floor.`,
                )
              }
            >
              <Check />
              Enable auto-trash
            </Button>
          </div>
        ))}
        {suggestions.map((s) => (
          <div key={s.key} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-mono">{s.pattern}</span> → <ActionBadge action={s.action} className="align-middle" />{' '}
              <CategoryBadge category={s.category} names={names} className="align-middle" />
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {s.evidence.total} reviewed ({s.evidence.confirmed} confirmed, {s.evidence.corrected} corrected) · last{' '}
                {formatRelative(s.evidence.lastAt)} · e.g. &ldquo;{s.evidence.sampleSubject}&rdquo;
                {s.autoApply ? ' · would trash without review' : ''}
              </span>
            </span>
            <Button
              size="sm"
              disabled={busy === s.key}
              onClick={() =>
                act(
                  s.key,
                  () => api('/api/rules/suggestions', { method: 'POST', json: { key: s.key, decision: 'accept' } }),
                  'Rule created.',
                )
              }
            >
              {busy === s.key ? <Loader2 className="animate-spin" /> : <Check />}
              Accept
            </Button>
            {s.autoApply ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === s.key}
                title="Create the rule but keep asking before trashing"
                onClick={() =>
                  act(
                    s.key,
                    () => api('/api/rules/suggestions', { method: 'POST', json: { key: s.key, decision: 'accept', autoApply: false } }),
                    'Rule created (review first).',
                  )
                }
              >
                Accept, review first
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === s.key}
              onClick={() =>
                act(
                  s.key,
                  () => api('/api/rules/suggestions', { method: 'POST', json: { key: s.key, decision: 'dismiss' } }),
                  'Dismissed.',
                )
              }
            >
              <X />
              Dismiss
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
