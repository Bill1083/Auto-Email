'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { KeyRound, Loader2, Mail, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/client';

interface Methods {
  google: boolean;
  password: boolean;
  sessionConfigured: boolean;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path fill="#4285F4" d="M21.6 12.23c0-.68-.06-1.36-.18-2.02H12v3.83h5.4a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.9-1.75 2.97-4.33 2.97-7.33Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.44l-3.23-2.5c-.9.6-2.04.96-3.39.96-2.6 0-4.8-1.76-5.6-4.12H3.07v2.58A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.52H3.07a10 10 0 0 0 0 8.96L6.4 13.9Z" />
      <path fill="#EA4335" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.87A9.98 9.98 0 0 0 12 2a10 10 0 0 0-8.93 5.52L6.4 10.1c.8-2.36 3-4.12 5.6-4.12Z" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [methods, setMethods] = useState<Methods | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get('error'));

  const rawNext = params.get('next');
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  useEffect(() => {
    api<Methods>('/api/auth/methods')
      .then(setMethods)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', json: { password } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (!methods) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking sign-in options…
      </p>
    );
  }

  if (!methods.sessionConfigured || (!methods.google && !methods.password)) {
    return (
      <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
        <p className="font-medium">The dashboard is locked.</p>
        <p className="text-muted-foreground">
          On the server, set <code>SESSION_SECRET</code> plus either <code>GOOGLE_CLIENT_ID</code>,{' '}
          <code>GOOGLE_CLIENT_SECRET</code> and <code>DASHBOARD_ALLOWED_EMAILS</code> for Google sign-in, or{' '}
          <code>DASHBOARD_PASSWORD</code> for a password. Then restart.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {methods.google ? (
        <Button asChild className="w-full" variant={methods.password ? 'default' : 'default'}>
          <a href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}>
            <GoogleMark />
            Sign in with Google
          </a>
        </Button>
      ) : null}

      {methods.google && methods.password ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}

      {methods.password ? (
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="password">Dashboard password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" variant={methods.google ? 'outline' : 'default'} className="w-full" disabled={busy || password.length === 0}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
            {busy ? 'Signing in…' : 'Sign in with password'}
          </Button>
        </form>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {methods.google
            ? 'Only the Google accounts listed on the server can sign in. Mailboxes are connected separately, once each, from Settings.'
            : 'Google sign-in can be enabled by setting DASHBOARD_ALLOWED_EMAILS on the server.'}
        </span>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-5 pt-6">
          <div className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Mail className="size-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold leading-tight">AutoMail</h1>
              <p className="text-xs text-muted-foreground">Private email triage dashboard</p>
            </div>
          </div>
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
