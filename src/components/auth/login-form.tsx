'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/feedback';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ConflictDetails {
  device?: string;
  ipAddress?: string | null;
  lastActiveLabel?: string;
  startedLabel?: string;
}

const REASON_MESSAGES: Record<string, string> = {
  expired: 'Your session expired after a period of inactivity. Please sign in again.',
  superseded: 'You were signed out because this account was used on another device.',
  terminated: 'This session was ended by an administrator.',
  disabled: 'This account has been disabled. Contact support if you think that is a mistake.',
};

export function LoginForm({ reason, next }: { reason?: string; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(reason ? REASON_MESSAGES[reason] ?? null : null);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState<ConflictDetails | null>(null);
  const [forcing, setForcing] = useState(false);

  async function submit(force: boolean) {
    setError(null);
    if (force) setForcing(true);
    else setPending(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, force }),
      });

      const data = await response.json().catch(() => ({}) as Record<string, unknown>);

      if (response.status === 409 && data.code === 'session_conflict') {
        setConflict((data.details ?? {}) as ConflictDetails);
        return;
      }

      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not sign you in.');
        return;
      }

      setConflict(null);
      const target = next && next.startsWith('/') ? next : (data.redirectTo as string) || '/';
      router.replace(target);
      router.refresh();
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
      setForcing(false);
    }
  }

  return (
    <>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        {error && <Alert variant="error">{error}</Alert>}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@college.edu"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(error)}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••••"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(error)}
          />
        </div>

        <Button type="submit" className="w-full" size="lg" loading={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link href="/register" className="font-medium text-foreground underline-offset-4 hover:underline">
            Create an account
          </Link>
        </p>
      </form>

      <Dialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>This account is already active on another device</DialogTitle>
            <DialogDescription>
              Cookie Notes allows one active session per account. Continuing here will sign
              the other device out.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-3 rounded-md border border-border bg-muted/40 p-3.5 text-sm">
            <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">{conflict?.device ?? 'Unknown device'}</p>
              <p className="text-xs text-muted-foreground">
                {conflict?.ipAddress ? `IP ${conflict.ipAddress} · ` : ''}
                active {conflict?.lastActiveLabel ?? 'recently'}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConflict(null)} disabled={forcing}>
              Cancel
            </Button>
            <Button onClick={() => void submit(true)} disabled={forcing}>
              {forcing && <Loader2 className="size-4 animate-spin" />}
              Sign out that device and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
