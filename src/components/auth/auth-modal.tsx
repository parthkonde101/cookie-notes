'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Cookie, Loader2, MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/feedback';
import { RegisterForm } from '@/components/auth/register-form';
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

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
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
    setError(null);
    setConflict(null);
  }

  /** Sign-in only. Registration is `RegisterForm`, which posts for itself. */
  async function submit(force = false) {
    setError(null);
    setPending(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, force, rememberMe }),
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

              {/* The register tab is the registration form itself. It used to
                  be a paragraph about what signing up involves and a button to
                  go and do it — a step that told the student nothing the form
                  does not, and put a page between them and the fields. The form
                  is the real one, imported rather than rebuilt, so there is
                  still only one registration form in the app. */}
              {mode === 'register' ? (
                // The form carries its own "already have an account?" line, and
                // the tabs above are the other way back, so nothing is added
                // around it here.
                <RegisterForm />
              ) : (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit(false);
                  }}
                >
                  {error && <Alert variant="error">{error}</Alert>}

                  <div className="space-y-2">
                    <Label htmlFor="auth-email">Email</Label>
                    <Input
                      id="auth-email"
                      type="email"
                      autoComplete="email"
                      required
                      placeholder="you@mitwpu.edu.in"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="auth-password">Password</Label>
                    <Input
                      id="auth-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>

                  <label
                    htmlFor="auth-remember"
                    className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground/90"
                  >
                    <input
                      id="auth-remember"
                      type="checkbox"
                      checked={rememberMe}
                      disabled={pending}
                      onChange={(event) => setRememberMe(event.target.checked)}
                      className="size-4 shrink-0 accent-primary"
                    />
                    Keep me signed in
                  </label>

                  <Button type="submit" className="w-full" size="lg" loading={pending}>
                    Sign in
                  </Button>

                  <p className="text-center text-xs text-muted-foreground">
                    <Link
                      href="/forgot-password"
                      className="underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Forgot your password?
                    </Link>
                  </p>
                </form>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </AuthModalContext.Provider>
  );
}
