'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Eraser } from 'lucide-react';
import { toast } from 'sonner';

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
import { api, errorMessage } from '@/lib/client';

/**
 * Clears history for the mailbox selected in the top right, or for every
 * mailbox on "All accounts".
 */
export function DangerZone({ accountId, email }: { accountId: string | null; email: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const target = email ?? 'every mailbox';

  async function clearHistory() {
    setBusy(true);
    try {
      await api('/api/settings/reset', {
        method: 'POST',
        json: { what: 'history', confirm: 'CLEAR', ...(accountId ? { accountId } : {}) },
      });
      toast.success(`History cleared for ${target}. The next run starts from scratch.`);
      setOpen(false);
      setConfirm('');
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-danger/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Danger zone</CardTitle>
        <CardDescription className="mt-1">
          Clearing the history forgets every decision, run, cost record and backlog snapshot for{' '}
          <strong>{target}</strong>. Accounts, rules, categories and settings stay. Nothing in Gmail changes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" className="border-danger/40 text-danger hover:bg-danger/10" onClick={() => setOpen(true)}>
          <Eraser />
          Clear history
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear the history for {target}?</DialogTitle>
            <DialogDescription>
              Already-processed emails will be treated as new by the next run, so they can be classified again.
              Type CLEAR to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="CLEAR" autoFocus />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={confirm !== 'CLEAR' || busy} onClick={clearHistory}>
              Clear history
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
