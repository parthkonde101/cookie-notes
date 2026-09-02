'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Cookie, Loader2, MonitorSmartphone } from 'lucide-react';
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
import { cn } from '@/lib/utils';

/**
 * The sign-in gate for the public catalogue.
 *
 * Browsing never requires an account. When a visitor tries to open a note we
 * show this instead of bouncing them to a separate page, and on success we send
 * them straight to the note they wanted — so the catalogue never feels like it
 * pushed them out of the way.
 *
 * The form itself is the whole message: there is no copy explaining why it
 * appeared, and nothing about access, pricing or what the note is.
 */

export interface RequestAuthOptions {
  /** Which tab to open on. */
  mode?: 'signin' | 'register';
}

interface AuthModalState {
  /** Opens the modal. `redirectTo` is where to land after signing in. */
  requestAuth: (redirectTo: string, options?: RequestAuthOptions) => void;
}

const AuthModalContext = createContext<AuthModalState | null>(null);

export function useAuthModal(): AuthModalState {
  const context = useContext(AuthModalContext);
  if (!context) {
    throw new Error('useAuthModal must be used inside <AuthModalProvider>');
  }
  return context;
}

type Mode = 'signin' | 'register';

interface ConflictDetails {
  device?: string;
  ipAddress?: string | null;
  lastActiveLabel?: string;
}

export function AuthModalProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('signin');
  const [target, setTarget] = useState<{ redirectTo: string } | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState<ConflictDetails | null>(null);

  const requestAuth = useCallback((redirectTo: string, options: RequestAuthOptions = {}) => {
    setTarget({ redirectTo });
    setError(null);
    setConflict(null);
    setMode(options.mode ?? 'signin');
    setOpen(true);
  }, []);

  const value = useMemo(() => ({ requestAuth }), [requestAuth]);

  function reset() {
    setPassword('');
    setConfirmPassword('');
    setError(null);
    setConflict(null);
  }

  async function submit(force = false) {
    setError(null);
    setPending(true);

    try {
      const endpoint = mode === 'signin' ? '/api/auth/login' : '/api/auth/register';
      const payload =
        mode === 'signin'
          ? { email, password, force }
          : { name, email, password, confirmPassword };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.status === 409 && data.code === 'session_conflict') {
        setConflict((data.details ?? {}) as ConflictDetails);
        return;
      }

      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'That did not work. Please try again.');
        return;
      }

      setOpen(false);
      reset();
      router.replace(target?.redirectTo ?? '/');
      router.refresh();
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthModalContext.Provider value={value}>
      {children}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent
          className="max-w-md"
          /*
           * The sign-in view has no description by design, so the default
           * aria-describedby would point at a node that is never rendered.
           */
          {...(conflict ? {} : { 'aria-describedby': undefined })}
        >
          {conflict ? (
            <>
              <DialogHeader>
                <DialogTitle>This account is already active on another device</DialogTitle>
                <DialogDescription>
                  Cookie Notes allows one active session per account. Continuing here signs the
                  other device out.
                </DialogDescription>
              </DialogHeader>

              <div className="flex gap-3 rounded-md border border-border bg-muted/40 p-3.5 text-sm">
                <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="font-medium">{conflict.device ?? 'Unknown device'}</p>
                  <p className="text-xs text-muted-foreground">
                    {conflict.ipAddress ? `IP ${conflict.ipAddress} · ` : ''}
                    active {conflict.lastActiveLabel ?? 'recently'}
                  </p>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setConflict(null)} disabled={pending}>
                  Back
                </Button>
                <Button onClick={() => void submit(true)} disabled={pending}>
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Sign out that device and continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-primary/12 text-primary">
                  <Cookie className="size-4" />
                </div>
                <DialogTitle>{mode === 'signin' ? 'Sign in' : 'Create account'}</DialogTitle>
              </DialogHeader>

              {/* Mode switch */}
              <div
                role="tablist"
                aria-label="Authentication mode"
                className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/40 p-1"
              >
                {(['signin', 'register'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={mode === value}
                    onClick={() => {
                      setMode(value);
                      setError(null);
                    }}
                    className={cn(
                      'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                      mode === value
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {value === 'signin' ? 'Sign in' : 'Create account'}
                  </button>
                ))}
              </div>

              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(false);
                }}
              >
                {error && <Alert variant="error">{error}</Alert>}

                {mode === 'register' && (
                  <div className="space-y-2">
                    <Label htmlFor="auth-name">Full name</Label>
                    <Input
                      id="auth-name"
                      autoComplete="name"
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="auth-email">Email</Label>
                  <Input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@college.edu"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="auth-password">Password</Label>
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  {mode === 'register' && (
                    <p className="text-xs text-muted-foreground">
                      At least 10 characters with upper and lowercase letters, a number and a
                      symbol.
                    </p>
                  )}
                </div>

                {mode === 'register' && (
                  <div className="space-y-2">
                    <Label htmlFor="auth-confirm">Confirm password</Label>
                    <Input
                      id="auth-confirm"
                      type="password"
                      autoComplete="new-password"
                      required
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                    />
                  </div>
                )}

                <Button type="submit" className="w-full" size="lg" loading={pending}>
                  {mode === 'signin' ? 'Sign in' : 'Create account'}
                </Button>

                {mode === 'signin' && (
                  <p className="text-center text-xs text-muted-foreground">
                    <Link
                      href="/forgot-password"
                      className="underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Forgot your password?
                    </Link>
                  </p>
                )}
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AuthModalContext.Provider>
  );
}
