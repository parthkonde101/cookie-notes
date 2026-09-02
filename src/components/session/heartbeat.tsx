'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const INTERVAL_MS = 60_000;

/**
 * Keeps the current session marked as active while the tab is in use, and reacts
 * when the server says the session is gone.
 *
 * This is what makes "34 students studying right now" a real number: activity is
 * measured from these pings, not from how many accounts exist. It is also how a
 * student learns quickly that their account was signed in somewhere else.
 */
export function SessionHeartbeat() {
  const router = useRouter();
  const stopped = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    async function ping() {
      if (stopped.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

      try {
        const response = await fetch('/api/session/heartbeat', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
        });

        if (response.status === 401) {
          stopped.current = true;
          const data = (await response.json().catch(() => ({}))) as { status?: string };
          const reason = data.status && data.status !== 'anonymous' ? data.status : 'expired';
          router.replace(`/login?reason=${encodeURIComponent(reason)}`);
          router.refresh();
        }
      } catch {
        // Offline or a transient failure: try again on the next tick.
      }
    }

    void ping();
    timer = setInterval(() => void ping(), INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void ping();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return null;
}
