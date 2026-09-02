'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

/**
 * Mirrors the server-side rules in lib/auth/password.ts. The server is still the
 * authority — this only saves the student a round-trip.
 */
function evaluate(password: string, email: string) {
  return [
    { label: 'At least 10 characters', ok: password.length >= 10 },
    { label: 'Upper and lowercase letters', ok: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { label: 'A number', ok: /[0-9]/.test(password) },
    { label: 'A symbol', ok: /[^A-Za-z0-9]/.test(password) },
    {
      label: 'Does not contain your email name',
      ok: (() => {
        const local = email.split('@')[0]?.toLowerCase();
        if (!local || local.length <= 2) return true;
        return !password.toLowerCase().includes(local);
      })(),
    },
  ];
}

export function RegisterForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    college: '',
    program: '',
    semester: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const rules = useMemo(() => evaluate(form.password, form.email), [form.password, form.email]);
  const strength = rules.filter((rule) => rule.ok).length;

  function update(key: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: event.target.value }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setPending(true);
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          semester: form.semester ? Number(form.semester) : undefined,
        }),
      });
      const data = await response.json().catch(() => ({}) as Record<string, unknown>);

      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not create your account.');
        return;
      }

      router.replace((data.redirectTo as string) ?? '/');
      router.refresh();
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      {error && <Alert variant="error">{error}</Alert>}

      <div className="space-y-2">
        <Label htmlFor="name">Full name</Label>
        <Input id="name" required autoComplete="name" value={form.name} onChange={update('name')} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@college.edu"
          value={form.email}
          onChange={update('email')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            autoComplete="new-password"
            value={form.password}
            onChange={update('password')}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <Input
            id="confirmPassword"
            type="password"
            required
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={update('confirmPassword')}
          />
        </div>
      </div>

      {form.password.length > 0 && (
        <div className="space-y-2.5 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex gap-1" aria-hidden>
            {[0, 1, 2, 3, 4].map((index) => (
              <span
                key={index}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  index < strength
                    ? strength >= 5
                      ? 'bg-success'
                      : strength >= 3
                        ? 'bg-warning'
                        : 'bg-destructive'
                    : 'bg-border',
                )}
              />
            ))}
          </div>
          <ul className="space-y-1">
            {rules.map((rule) => (
              <li
                key={rule.label}
                className={cn(
                  'flex items-center gap-2 text-xs',
                  rule.ok ? 'text-success' : 'text-muted-foreground',
                )}
              >
                {rule.ok ? <Check className="size-3" /> : <X className="size-3" />}
                {rule.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="group rounded-md border border-border px-3.5 py-3">
        <summary className="cursor-pointer list-none text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          Optional: tell us about your course
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="college">College</Label>
            <Input id="college" value={form.college} onChange={update('college')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="program">Programme</Label>
            <Input
              id="program"
              placeholder="B.Tech CSE"
              value={form.program}
              onChange={update('program')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="semester">Semester</Label>
            <Select id="semester" value={form.semester} onChange={update('semester')}>
              <option value="">Select</option>
              {Array.from({ length: 8 }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  Semester {value}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </details>

      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
