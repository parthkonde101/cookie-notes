'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  PROGRAM_COOKIE,
  PROGRAM_COOKIE_MAX_AGE,
  PROGRAM_PARAM,
  type Program,
} from '@/lib/program';

/**
 * Shared state for a programme switch, so the shelf can react to the click
 * before the server has answered.
 *
 * ## The problem this solves
 *
 * `useTransition`'s pending flag lived inside the selector, where nothing else
 * could see it. So between the press and the RSC payload arriving, the page did
 * nothing at all — the old shelf just sat there — and then the new one replaced
 * it in a single frame. Two separate complaints ("slow", "abrupt") with one
 * cause: no feedback during the wait, no continuity at the swap.
 *
 * Hoisting the transition into a provider lets the selector and the shelf share
 * one pending flag. The selector marks the pressed option immediately; the
 * shelf dims and settles back a few pixels. Neither waits for the server.
 *
 * ## What this is not
 *
 * It holds no catalogue data and renders no catalogue markup. The shelf is
 * still server-rendered and arrives as `children`; this only carries a boolean
 * and a callback. Nothing here duplicates what the server sends, and the
 * navigation is the same `router.replace` inside the same `startTransition`.
 */

interface ProgramTransitionValue {
  /** The programme the server rendered. */
  active: Program;
  /** What the user last pressed — `active` once the server has caught up. */
  shown: Program;
  /** True while the RSC payload for a switch is in flight. */
  isPending: boolean;
  select: (program: Program) => void;
}

const ProgramTransitionContext = createContext<ProgramTransitionValue | null>(null);

/**
 * Read the surrounding transition, or `null` when there is none.
 *
 * Nullable on purpose. The admin Notes screen uses the selector without this
 * provider, and it keeps working exactly as before — the selector falls back to
 * its own internal transition rather than requiring every caller to be wrapped.
 */
export function useProgramTransition(): ProgramTransitionValue | null {
  return useContext(ProgramTransitionContext);
}

export interface ProgramTransitionProviderProps {
  /** The programme the server resolved for this render. */
  active: Program;
  /** Which cookie remembers the choice. */
  cookieName?: string;
  children: React.ReactNode;
}

export function ProgramTransitionProvider({
  active,
  cookieName = PROGRAM_COOKIE,
  children,
}: ProgramTransitionProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  // What the user last pressed, shown optimistically so the indicator moves on
  // press rather than on response. Cleared the moment the prop catches up,
  // after which `active` is the only source of truth again.
  const [pending, setPending] = useState<Program | null>(null);
  const shown = pending ?? active;

  useEffect(() => {
    if (pending === active) setPending(null);
  }, [pending, active]);

  const select = useCallback(
    (program: Program) => {
      if (program === active && pending === null) return;
      setPending(program);

      // Written before navigating so it is already true if the user refreshes
      // mid-transition, and so every other page agrees without being told.
      document.cookie = `${cookieName}=${program}; path=/; max-age=${PROGRAM_COOKIE_MAX_AGE}; SameSite=Lax`;

      const params = new URLSearchParams(window.location.search);
      params.set(PROGRAM_PARAM, program);
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [active, cookieName, pending, pathname, router],
  );

  const value = useMemo<ProgramTransitionValue>(
    () => ({ active, shown, isPending, select }),
    [active, shown, isPending, select],
  );

  return (
    <ProgramTransitionContext.Provider value={value}>{children}</ProgramTransitionContext.Provider>
  );
}
