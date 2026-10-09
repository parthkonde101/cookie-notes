'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/feedback';
import { purposeOf } from '@/components/auth/college-email-form';

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * "Verify my current email", for a student who is already on a college address.
 *
 * Two steps: ask for a code, then enter it. There is no address field, because
 * there is nothing to choose — the code goes to the address the account already
 * has, and that address does not change. The server takes the account from the
 * session and the address from the account; nothing here names either.
 *
 * `initialSentAt` lets a student who closed the tab mid-flow come back to the
 * code step instead of starting over, as long as the code is still alive.
 */
export function CurrentEmailForm({
  email,
  initialSentAt,
  nextHref = '/',
  onUseDifferent,
}: {
  email: string;
  /** When the live code was sent (ISO), if there is one. */
  initialSentAt: string | null;
  nextHref?: string;
  /** For a student who mistyped this address when signing up: change it instead. */
  onUseDifferent?: () => void;
}) {
  const router = useRouter();
  const purpose = purposeOf(nextHref);
  const codeRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'send' | 'code'>(initialSentAt ? 'code' : 'send');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const [done, setDone] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // Worked out after mount, not during render: the server's clock and the
  // browser's differ, and a countdown rendered from either would not match.
  useEffect(() => {
    if (!initialSentAt) return;
    const elapsed = Math.floor((Date.now() - Date.parse(initialSentAt)) / 1000);
    setCooldown(Math.max(0, RESEND_COOLDOWN_SECONDS - elapsed));
  }, [initialSentAt]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/auth/verify-current-email', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not send the code.');
        return;
      }
      setStep('code');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
      setResending(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/auth/verify-current-email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'That code did not work.');
        setCode('');
        codeRef.current?.focus();
        return;
      }
      setDone(true);
      // The gate lifts server-side the moment the timestamp is written; the
      // refresh is what lets the rest of the app notice.
      setTimeout(() => {
        router.replace(nextHref);
        router.refresh();
      }, 1200);
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2 className="size-8 text-success" aria-hidden />
        <div>
          <p className="font-medium">Email verified</p>
          <p className="mt-1 text-sm text-muted-foreground">{purpose.back}</p>
        </div>
      </div>
    );
  }

  if (step === 'send') {
    return (
      <form className="space-y-5" onSubmit={send}>
        <header className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">Verify your MIT-WPU email</h1>
          <p className="text-sm text-muted-foreground">{purpose.reason}</p>
        </header>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">We will send a 6-digit code to</p>
          <p className="break-all text-sm font-medium">{email}</p>
          <p className="text-xs text-muted-foreground">
            This is the address you already sign in with. It will not change.
          </p>
        </div>

        <Button type="submit" className="w-full" size="lg" loading={pending}>
          {pending ? 'Sending…' : 'Verify my current email'}
        </Button>

        {onUseDifferent && (
          <p className="text-center text-sm text-muted-foreground">
            Not your address?{' '}
            <button
              type="button"
              onClick={onUseDifferent}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Use a different MIT-WPU email
            </button>
          </p>
        )}
      </form>
    );
  }

  return (
    <form className="space-y-5" onSubmit={confirm}>
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Verify your MIT-WPU email</h1>
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit code sent to{' '}
          <span className="break-all font-medium text-foreground">{email}</span>. It expires in 10
          minutes.
        </p>
      </header>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="space-y-2">
        <Label htmlFor="currentCode">Verification code</Label>
        <Input
          ref={codeRef}
          id="currentCode"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={7}
          required
          placeholder="123456"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/[^\d\s-]/g, ''))}
          aria-invalid={Boolean(error)}
          className="text-center font-mono text-lg tracking-[0.4em]"
        />
      </div>

      <Button type="submit" className="w-full" size="lg" loading={pending} disabled={code.length < 6}>
        {pending ? 'Verifying…' : 'Verify email'}
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <button
          type="button"
          onClick={() => {
            setResending(true);
            void send();
          }}
          disabled={cooldown > 0 || resending || pending}
          className="font-medium text-foreground underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:font-normal disabled:text-muted-foreground disabled:no-underline"
        >
          {cooldown > 0 ? `Resend code in ${cooldown}s` : resending ? 'Sending…' : 'Resend code'}
        </button>
        {onUseDifferent && (
          <button
            type="button"
            onClick={onUseDifferent}
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Wrong address?
          </button>
        )}
      </div>
    </form>
  );
}
