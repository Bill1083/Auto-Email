'use client';

import { useEffect } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Route-level error boundary. Next.js renders this in place of the page when a
 * server or client render throws.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[automail] render error:', error);
  }, [error]);

  return (
    <Card className="mx-auto mt-8 max-w-lg border-destructive/40">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <TriangleAlert className="size-5" />
        </span>
        <h2 className="text-lg font-semibold">Something broke on this page</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          The rest of the app is unaffected. If this keeps happening, check the
          server logs — the failure is recorded there with a stack trace.
        </p>
        {error.digest ? (
          <p className="font-mono text-xs text-muted-foreground">
            digest: {error.digest}
          </p>
        ) : null}
        <Button onClick={reset} className="mt-1">
          <RotateCcw />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
