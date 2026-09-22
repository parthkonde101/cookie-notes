'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/feedback';

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Moving an existing account to a verified college address.
 *
 * Two steps in one screen: propose the address, then enter the code sent to it.
 * There is no skip — the account cannot read notes until this is done — but
 * there is also no penalty for stopping: the original address keeps working for
 * signing in, and coming back later resumes from wherever they left off.
 *
 * The step is derived from what the server already knows (`initialPending`), so
 * closing the tab mid-flow and returning lands on the code entry rather than
 * starting over.
 *
 * `nextHref` is where to land once verified — the note they were trying to open,
 * when they arrived from the access dialog. It is validated server-side before
 * it reaches this component.
 */
export function CollegeEmailForm({
  initialPending,
  nextHref = '/',
}: {
  initialPending: string | null;
  nextHref?: string;
}) {
  const router = useRouter();
  const codeRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'email' | 'code'>(initialPending ? 'code' : 'email');
  const [email, setEmail] = useState(initialPending ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const [done, setDone] = useState(false);
  const [cooldown, setCooldown] = useState(initialPending ? RESEND_COOLDOWN_SECONDS : 0);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function request(event?: React.FormEvent) {
    event?.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await fetch('/api/auth/college-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not send the code.');
        return;
      }
      setStep('code');
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice(null);
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
    setNotice(null);
    setPending(true);
    try {
      const response = await fetch('/api/auth/college-email', {
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
          <p className="mt-1 text-sm text-muted-foreground">Taking you back to your notes…</p>
        </div>
      </div>
    );
  }

  if (step === 'email') {
    return (
      <form className="space-y-5" onSubmit={request}>
        <header className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">Update your college email</h1>
          <p className="text-sm text-muted-foreground">
            Verify your MIT-WPU email address to continue.
          </p>
        </header>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="space-y-2">
          <Label htmlFor="collegeEmail">MIT-WPU Email</Label>
          <Input
            id="collegeEmail"
            type="email"
            required
            autoComplete="email"
            autoFocus
            placeholder="you@mitwpu.edu.in"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby="college-email-hint"
          />
          <p id="college-email-hint" className="text-xs text-muted-foreground">
            Must end in <span className="font-medium text-foreground">@mitwpu.edu.in</span>.
          </p>
        </div>

        <Button type="submit" className="w-full" size="lg" loading={pending} disabled={!email}>
          {pending ? 'Sending…' : 'Send verification code'}
        </Button>
      </form>
    );
  }

  return (
    <form className="space-y-5" onSubmit={confirm}>
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Verify your MIT-WPU email</h1>
        {/* Address, instruction and expiry in one line — everything needed to
            finish, and nothing else. */}
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit code sent to{' '}
          <span className="break-all font-medium text-foreground">{email}</span>. It expires in 10
          minutes.
        </p>
      </header>

      {error && <Alert variant="error">{error}</Alert>}
      {notice && <Alert variant="info">{notice}</Alert>}

      <div className="space-y-2">
        <Label htmlFor="collegeCode">Verification code</Label>
        <Input
          ref={codeRef}
          id="collegeCode"
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
            void request();
          }}
          disabled={cooldown > 0 || resending || pending}
          className="font-medium text-foreground underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:font-normal disabled:text-muted-foreground disabled:no-underline"
        >
          {cooldown > 0 ? `Resend code in ${cooldown}s` : resending ? 'Sending…' : 'Resend code'}
        </button>
        <button
          type="button"
          onClick={() => {
            setStep('email');
            setCode('');
            setError(null);
          }}
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Use a different address
        </button>
      </div>
    </form>
  );
}
