'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  Activity,
  BookMarked,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { AccountSwitcher } from '@/components/account-switcher';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/client';
import type { AccountDto } from '@/lib/serialize';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/review', label: 'Review', icon: ListChecks },
  { href: '/activity', label: 'Activity', icon: Activity },
  { href: '/rules', label: 'Rules', icon: BookMarked },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The server has no idea which theme is active, so the icon renders only
  // after hydration to avoid a mismatch.
  useEffect(() => setMounted(true), []);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle colour theme"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {mounted && resolvedTheme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

function LogoutButton({ identity }: { identity: string | null }) {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Sign out"
      title={identity ? `Signed in as ${identity} · sign out` : 'Sign out'}
      onClick={async () => {
        try {
          await api('/api/auth/logout', { method: 'POST' });
          router.replace('/login');
          router.refresh();
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }}
    >
      <LogOut />
    </Button>
  );
}

export function AppShell({
  accounts,
  selectedId,
  reviewCount,
  identity,
  children,
}: {
  accounts: AccountDto[];
  selectedId: string;
  reviewCount: number;
  identity: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Mail className="size-4" />
            </span>
            <span className="text-base">
              Auto<span className="text-primary">Mail</span>
            </span>
          </Link>

          <nav className="ml-4 hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  isActive(pathname, item.href)
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                {item.label}
                {item.href === '/review' && reviewCount > 0 ? (
                  <span className="tnum rounded-full bg-warning/20 px-1.5 text-[11px] font-semibold text-warning">
                    {reviewCount > 999 ? '999+' : reviewCount}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <AccountSwitcher accounts={accounts} selectedId={selectedId} />
            <ThemeToggle />
            <LogoutButton identity={identity} />
          </div>
        </div>
      </header>

      {/* The bottom padding clears the mobile tab bar. */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-4 sm:pt-6 md:pb-10">
        {children}
      </main>

      {/* Mobile tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur md:hidden">
        <div className="mx-auto grid max-w-md grid-cols-5 pb-[env(safe-area-inset-bottom)]">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex flex-col items-center gap-1 px-2 py-2.5 text-[11px] font-medium transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className="size-5" />
                {item.label}
                {item.href === '/review' && reviewCount > 0 ? (
                  <span className="absolute right-3 top-1.5 size-2 rounded-full bg-warning" />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
