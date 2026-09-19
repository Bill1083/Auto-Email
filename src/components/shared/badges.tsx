import { Archive, Bot, CircleUser, Inbox, ScrollText, Trash2, TriangleAlert, Wand2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const ACTION_LABEL: Record<string, string> = {
  KEEP: 'Keep',
  ARCHIVE: 'Archive',
  TRASH: 'Trash',
  ATTENTION: 'Attention',
};

const ACTION_VARIANT: Record<string, 'default' | 'secondary' | 'danger' | 'warning'> = {
  KEEP: 'default',
  ARCHIVE: 'secondary',
  TRASH: 'danger',
  ATTENTION: 'warning',
};

const ACTION_ICON = {
  KEEP: Inbox,
  ARCHIVE: Archive,
  TRASH: Trash2,
  ATTENTION: TriangleAlert,
} as const;

export function ActionBadge({
  action,
  className,
  compact = false,
}: {
  action: string;
  className?: string;
  compact?: boolean;
}) {
  const Icon = ACTION_ICON[action as keyof typeof ACTION_ICON];
  return (
    <Badge variant={ACTION_VARIANT[action] ?? 'outline'} className={cn('whitespace-nowrap', className)}>
      {Icon ? <Icon className="size-3" /> : null}
      {compact ? null : ACTION_LABEL[action] ?? action}
    </Badge>
  );
}

/** Human name for a category key, falling back to a readable version of the key. */
export function categoryName(key: string, names?: Record<string, string>): string {
  if (names?.[key]) return names[key];
  return key
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function CategoryBadge({
  category,
  names,
  className,
}: {
  category: string;
  names?: Record<string, string>;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap font-medium', className)}>
      {categoryName(category, names)}
    </Badge>
  );
}

const STATUS_LABEL: Record<string, { label: string; variant: 'secondary' | 'warning' | 'danger' | 'success' | 'outline' }> = {
  DRY_RUN: { label: 'Dry run', variant: 'outline' },
  PENDING_REVIEW: { label: 'Awaiting review', variant: 'warning' },
  APPLIED: { label: 'Applied', variant: 'secondary' },
  TRASHED: { label: 'Trashed', variant: 'danger' },
  REVERTED: { label: 'Undone', variant: 'outline' },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const entry = STATUS_LABEL[status] ?? { label: status, variant: 'outline' as const };
  return (
    <Badge variant={entry.variant} className={cn('whitespace-nowrap', className)}>
      {entry.label}
    </Badge>
  );
}

export function DecidedByBadge({ decidedBy, className }: { decidedBy: string; className?: string }) {
  const map = {
    rule: { label: 'Rule', icon: ScrollText },
    ai: { label: 'AI', icon: Bot },
    user: { label: 'You', icon: CircleUser },
    fallback: { label: 'Unclassified', icon: Wand2 },
  } as const;
  const entry = map[decidedBy as keyof typeof map] ?? { label: decidedBy, icon: Bot };
  const Icon = entry.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}>
      <Icon className="size-3" />
      {entry.label}
    </span>
  );
}

/** A small meter; the number does the talking, the bar gives the glance. */
export function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const tone = clamped >= 80 ? 'bg-success' : clamped >= 60 ? 'bg-warning' : 'bg-danger';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} title={`Confidence ${clamped}%`}>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${clamped}%` }} />
      </span>
      <span className="tnum text-xs text-muted-foreground">{clamped}</span>
    </span>
  );
}
