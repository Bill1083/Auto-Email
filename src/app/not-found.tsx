import Link from 'next/link';
import { Compass } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function NotFound() {
  return (
    <Card className="mx-auto mt-8 max-w-lg">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Compass className="size-5" />
        </span>
        <h2 className="text-lg font-semibold">No such page</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          That route does not exist. The overview, the review queue and your rules are
          all one tap away.
        </p>
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/">Overview</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/review">Review</Link>
          </Button>
          <Button asChild>
            <Link href="/rules">Rules</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
