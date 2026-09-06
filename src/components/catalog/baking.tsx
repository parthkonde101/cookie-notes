'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthModal } from '@/components/auth/auth-modal';
import { cn } from '@/lib/utils';

/**
 * A cookie in the oven.
 *
 * Drawn rather than illustrated — an inline SVG disc with three chips and two
 * wisps of heat — so it inherits the current text colour, works in either
 * theme, costs no network request, and stays legible at 36px. The motion lives
 * in `globals.css` (`.baking*`), which is also where it is switched off for
 * `prefers-reduced-motion`.
 *
 * Marked `aria-hidden`: the state is announced by the "Being Baked" text beside
 * it, never by the animation alone.
 */
export function BakingCookie() {
  return (
    <span className="baking" aria-hidden>
      <span className="baking-wisp" />
      <span className="baking-wisp" />
      <svg viewBox="0 0 24 24" className="baking-cookie size-6 text-primary" fill="none">
        <circle cx="12" cy="13" r="8.25" fill="currentColor" opacity="0.18" />
        <circle
          cx="12"
          cy="13"
          r="8.25"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.85"
        />
        <circle cx="9.4" cy="11.2" r="1.15" fill="currentColor" />
        <circle cx="14.4" cy="11.9" r="0.95" fill="currentColor" />
        <circle cx="11.6" cy="15.6" r="1.05" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * "Notify me" for a unit that is still baking.
 *
 * Signing in is the existing modal, not a new flow: a signed-out visitor who
 * clicks gets the same auth dialog the rest of the catalogue uses, and lands
 * back where they were. Nothing is subscribed until someone has actually
 * clicked while signed in — opening or viewing a unit never subscribes anyone.
 *
 * The button is optimistic and reversible: it flips immediately, reverts if the
 * server disagrees, and clicking again unsubscribes.
 */
export function NotifyMeButton({
  unitId,
  unitLabel,
  subscribed: initial,
}: {
  unitId: string;
  /** Human label for the accessible name, e.g. "Unit 3 — Neural Networks". */
  unitLabel: string;
  subscribed: boolean;
}) {
  const router = useRouter();
  const { requestAuth } = useAuthModal();
  const [subscribed, setSubscribed] = useState(initial);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !subscribed;
    const previous = subscribed;
    setSubscribed(next);

    startTransition(async () => {
      try {
        const response = await fetch(`/api/units/${unitId}/subscribe`, {
          method: next ? 'POST' : 'DELETE',
          cache: 'no-store',
        });

        if (response.status === 401) {
          setSubscribed(previous);
          // Straight into the existing sign-in modal, returning to this page.
          requestAuth(window.location.pathname);
          return;
        }

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          setSubscribed(previous);
          toast.error(data.error ?? 'That did not work. Please try again.');
          return;
        }

        toast.success(next ? 'We will email you when these notes are ready.' : 'Reminder removed.');
        router.refresh();
      } catch {
        setSubscribed(previous);
        toast.error('That did not work. Please try again.');
      }
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={subscribed}
      aria-label={
        subscribed
          ? `Stop notifying me when ${unitLabel} is ready`
          : `Notify me when ${unitLabel} is ready`
      }
      className={cn(
        'relative z-10 inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5',
        'text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:opacity-60',
        subscribed
          ? 'border-primary/45 bg-primary/12 text-primary'
          : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
      )}
    >
      {subscribed ? (
        <Check aria-hidden className="size-3.5 shrink-0" />
      ) : pending ? (
        <BellRing aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <Bell aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{subscribed ? "You'll be notified" : 'Notify me'}</span>
    </button>
  );
}
