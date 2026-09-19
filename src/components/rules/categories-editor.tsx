'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/client';
import type { CategoryDto } from '@/lib/serialize';
import { ACTIONS } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Draft {
  key: string | null;
  name: string;
  description: string;
  labelName: string;
  defaultAction: string;
  allowTrash: boolean;
}

const EMPTY: Draft = { key: null, name: '', description: '', labelName: '', defaultAction: 'KEEP', allowTrash: false };

export function CategoriesEditor({ categories, labelPrefix }: { categories: CategoryDto[]; labelPrefix: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  async function mutate(key: string, request: () => Promise<unknown>, success?: string) {
    setBusy(key);
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

  async function saveDraft() {
    if (!draft) return;
    const body = {
      name: draft.name,
      description: draft.description,
      labelName: draft.labelName || null,
      defaultAction: draft.defaultAction,
      allowTrash: draft.allowTrash,
    };
    await mutate(
      draft.key ?? 'new',
      () =>
        draft.key
          ? api(`/api/categories/${draft.key}`, { method: 'PATCH', json: body })
          : api('/api/categories', { method: 'POST', json: body }),
      draft.key ? 'Category updated.' : 'Category added.',
    );
    setDraft(null);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Categories</CardTitle>
            <CardDescription className="mt-1">
              The closed list the AI chooses from. Each becomes a Gmail label under <code>{labelPrefix}/</code>.
              &ldquo;Allow trash&rdquo; is the safety rail: the AI can never trash a category without it.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setDraft({ ...EMPTY })}>
            <Plus />
            Add category
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="pb-2 pr-3 font-medium">Category</th>
                <th className="pb-2 pr-3 font-medium">Label</th>
                <th className="pb-2 pr-3 font-medium">Default action</th>
                <th className="pb-2 pr-3 font-medium">Allow trash</th>
                <th className="pb-2 pr-3 font-medium">Auto-trash</th>
                <th className="pb-2 pr-3 font-medium">On</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {categories.map((category) => (
                <tr key={category.key} className={cn(!category.enabled && 'opacity-60')}>
                  <td className="py-2 pr-3">
                    <p className="font-medium">
                      {category.name}
                      {!category.builtIn ? <Badge variant="outline" className="ml-2">custom</Badge> : null}
                    </p>
                    <p className="max-w-md text-xs text-muted-foreground">{category.description}</p>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {category.labelName ? `${labelPrefix}/${category.labelName}` : <span className="text-muted-foreground">none</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      className="h-8 rounded-md border bg-background px-2 text-xs"
                      value={category.defaultAction}
                      disabled={busy === category.key}
                      onChange={(e) =>
                        mutate(category.key, () =>
                          api(`/api/categories/${category.key}`, { method: 'PATCH', json: { defaultAction: e.target.value } }),
                        )
                      }
                    >
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {a.charAt(0) + a.slice(1).toLowerCase()}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <Switch
                      checked={category.allowTrash}
                      disabled={busy === category.key}
                      onCheckedChange={(v) =>
                        mutate(category.key, () =>
                          api(`/api/categories/${category.key}`, { method: 'PATCH', json: { allowTrash: v } }),
                        )
                      }
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <Switch
                      checked={category.autoTrash}
                      disabled={busy === category.key || !category.allowTrash}
                      onCheckedChange={(v) =>
                        mutate(category.key, () =>
                          api(`/api/categories/${category.key}`, { method: 'PATCH', json: { autoTrash: v } }),
                        )
                      }
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <Switch
                      checked={category.enabled}
                      disabled={busy === category.key || category.key === 'OTHER'}
                      onCheckedChange={(v) =>
                        mutate(category.key, () =>
                          api(`/api/categories/${category.key}`, { method: 'PATCH', json: { enabled: v } }),
                        )
                      }
                    />
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground"
                      aria-label="Edit"
                      onClick={() =>
                        setDraft({
                          key: category.key,
                          name: category.name,
                          description: category.description,
                          labelName: category.labelName ?? '',
                          defaultAction: category.defaultAction,
                          allowTrash: category.allowTrash,
                        })
                      }
                    >
                      <Pencil />
                    </Button>
                    {!category.builtIn ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-danger"
                        aria-label="Delete"
                        disabled={busy === category.key}
                        onClick={() =>
                          mutate(category.key, () => api(`/api/categories/${category.key}`, { method: 'DELETE' }), 'Category deleted.')
                        }
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tags className="size-4" />
              {draft?.key ? 'Edit category' : 'New category'}
            </DialogTitle>
            <DialogDescription>
              The description is what the AI reads to decide whether an email belongs here, so write it for the model.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={40} />
              </div>
              <div className="space-y-1.5">
                <Label>Description for the AI</Label>
                <Textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
                  maxLength={500}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Gmail label (blank = no label)</Label>
                <Input
                  value={draft.labelName}
                  onChange={(e) => setDraft({ ...draft, labelName: e.target.value })}
                  placeholder={draft.name}
                  maxLength={40}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Default action</Label>
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={draft.defaultAction}
                    onChange={(e) => setDraft({ ...draft, defaultAction: e.target.value })}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a.charAt(0) + a.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <Switch checked={draft.allowTrash} onCheckedChange={(v) => setDraft({ ...draft, allowTrash: v })} />
                  Allow trash
                </label>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={saveDraft} disabled={!draft || draft.name.length < 2 || draft.description.length < 10 || busy !== null}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
