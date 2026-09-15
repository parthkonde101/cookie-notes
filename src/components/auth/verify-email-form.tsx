'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/feedback';

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * The last step of signing up: prove you can read the mailbox.
 *
 * One plain text input rather than six boxes. Six separate inputs look neat and
 * are miserable in practice — they fight password managers, paste, screen
 * readers and backspace. A single `inputMode="numeric"` field with
 * `autoComplete="one-time-code"` gets the numeric keypad on a phone and lets
 * iOS and Android fill the code from the notification.
 *
 * Nothing here signs anybody in. A verified address means the student may now
 * use the sign-in form; the password is still required.
 */
export function VerifyEmailForm({ email }: { email: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'That code did not work.');
        setCode('');
        inputRef.current?.focus();
        return;
      }

      setVerified(true);
      // A beat on the confirmation, then the sign-in form — where the password
      // is still required.
      setTimeout(() => router.replace('/login?verified=1'), 1200);
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not send a new code.');
        return;
      }
      setNotice('If that address is waiting to be verified, a new code is on its way.');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setResending(false);
    }
  }

  if (verified) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2 className="size-8 text-success" aria-hidden />
        <div>
          <p className="font-medium">Email verified</p>
          <p className="mt-1 text-sm text-muted-foreground">Taking you to sign in…</p>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      {error && <Alert variant="error">{error}</Alert>}
      {notice && <Alert variant="info">{notice}</Alert>}

      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3.5">
        <MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 text-sm text-muted-foreground">
          We sent a 6-digit code to{' '}
          <span className="break-all font-medium text-foreground">{email}</span>. It expires in 10
          minutes.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="code">Verification code</Label>
        <Input
          ref={inputRef}
          id="code"
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
          onClick={resend}
          disabled={cooldown > 0 || resending}
          className="font-medium text-foreground underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:font-normal disabled:text-muted-foreground disabled:no-underline"
        >
          {cooldown > 0 ? `Resend code in ${cooldown}s` : resending ? 'Sending…' : 'Resend code'}
        </button>
        <Link
          href="/login"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    </form>
  );
}
