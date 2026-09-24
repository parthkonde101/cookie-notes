'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  PROGRAMS,
  PROGRAM_COOKIE,
  PROGRAM_COOKIE_MAX_AGE,
  PROGRAM_PARAM,
  type Program,
} from '@/lib/program';
import { cn } from '@/lib/utils';

/**
 * The shelf switch: B.Tech or Polytechnic.
 *
 * ## What it actually does
 *
 * Switching does two things, in this order:
 *
 * 1. Writes the choice to a cookie, synchronously, so a refresh or a visit to
 *    any other page already knows the answer before React has run.
 * 2. Calls `router.replace` inside a transition. That is an RSC navigation, not
 *    a page load: Next re-renders the server component tree and swaps the shelf
 *    in place, so scroll position, the header and the rest of the document
 *    survive. `scroll: false` stops it jumping to the top.
 *
 * `replace` rather than `push` on purpose. Flipping between the two shelves is
 * a filter, not a journey; stacking six of them in history so Back walks
 * through each one would be a nuisance. The URL still carries `?program=`, so a
 * copied link opens the shelf it was copied from.
 *
 * ## Why the active program is not local state
 *
 * `active` is a prop, resolved on the server from the URL and the cookie. The
 * component never disagrees with what is rendered below it, because it does not
 * hold its own opinion — during the transition the *pending* choice is shown
 * optimistically, and when the server tree arrives the prop confirms it. That
 * also means Back/Forward, a pasted link and a refresh all put the indicator in
 * the right place with no effect to synchronise.
 *
 * ## Access
 *
 * None of this is authorisation. Every student can read both shelves; this
 * chooses which one is drawn. Nothing here touches entitlements, and the
 * cookie it writes is never read by anything that decides access.
 */

/** Where the indicator sits, in pixels, measured from the live buttons. */
interface Indicator {
  left: number;
  width: number;
}

export interface ProgramSelectorProps {
  /** The program the server rendered the catalogue for. */
  active: Program;
  /** The id of the region this switches, for `aria-controls`. */
  controls?: string;
  /**
   * Which cookie remembers the choice. The admin Notes screen passes
   * `ADMIN_PROGRAM_COOKIE` so an afternoon spent filing Polytechnic PDFs does
   * not switch the public catalogue underneath the admin, and vice versa.
   */
  cookieName?: string;
  /** Accessible name for the group. Defaults to "Programme". */
  label?: string;
  className?: string;
}

export function ProgramSelector({
  active,
  controls,
  cookieName = PROGRAM_COOKIE,
  label = 'Programme',
  className,
}: ProgramSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const listRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<Program, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<Indicator | null>(null);

  // What the user last clicked, shown immediately so the indicator moves on
  // press rather than when the server responds. Cleared the moment the prop
  // catches up, after which `active` is the only source of truth again.
  const [pending, setPending] = useState<Program | null>(null);
  const shown = pending ?? active;

  useEffect(() => {
    if (pending === active) setPending(null);
  }, [pending, active]);

  /**
   * Measures the active button and parks the indicator over it.
   *
   * Measured rather than computed from a column count so the pill hugs each
   * label — "B.Tech" and "Polytechnic" are very different widths, and two equal
   * halves would leave the shorter one swimming. Layout effect so the first
   * paint already has it in place instead of showing it jump.
   */
  const measure = useCallback(() => {
    const list = listRef.current;
    const button = buttonRefs.current.get(shown);
    if (!list || !button) return;
    setIndicator({ left: button.offsetLeft, width: button.offsetWidth });
  }, [shown]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Fonts landing late and the container changing width both move the labels
  // under the indicator. Re-measure rather than assume the first reading holds.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [measure]);

  const select = useCallback(
    (program: Program) => {
      if (program === active && pending === null) return;
      setPending(program);

      // Written before navigating so it is already true if the user refreshes
      // mid-transition, and so every other page agrees without being told.
      // `SameSite=Lax` keeps it off cross-site requests; there is nothing
      // sensitive in it either way.
      document.cookie = `${cookieName}=${program}; path=/; max-age=${PROGRAM_COOKIE_MAX_AGE}; SameSite=Lax`;

      const params = new URLSearchParams(window.location.search);
      params.set(PROGRAM_PARAM, program);
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [active, cookieName, pending, pathname, router],
  );

  /** Left/Right walk the options, as a tablist is expected to. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const index = PROGRAMS.findIndex((option) => option.value === shown);
      const next = PROGRAMS[(index + delta + PROGRAMS.length) % PROGRAMS.length];
      buttonRefs.current.get(next.value)?.focus();
      select(next.value);
    },
    [select, shown],
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        /*
         * A squared segmented control, not a capsule.
         *
         * `rounded-xl` on the frame and `rounded-lg` on the indicator inside it
         * keeps the two corner radii concentric — a pill inside a box reads as
         * two unrelated shapes. The frame sits on `card`, one step above the
         * page, with a real border and a shadow, so it carries weight as a
         * primary control rather than floating as a filter chip.
         */
        'relative inline-flex items-center rounded-xl border border-border bg-card p-1.5',
        'shadow-[0_1px_2px_rgba(0,0,0,0.30),0_8px_24px_-12px_rgba(0,0,0,0.55)]',
        className,
      )}
    >
      {/*
       * The sliding indicator. It is a sibling of the buttons rather than a
       * background on the active one, which is what lets it animate between
       * them — a background cannot be transitioned across two elements.
       *
       * Cookie brown, the accent this theme reserves for primary actions and
       * active states. Its label flips to `primary-foreground` (near-black
       * brown), which is the pairing the palette is built around — ~7:1 rather
       * than the ~2.4:1 white on this hue would give.
       *
       * Hidden until the first measurement so it never flashes at the origin.
       * `motion-reduce` drops the travel for anyone who has asked for less
       * movement; it still lands in the right place, just instantly.
       */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-1.5 rounded-lg bg-primary',
          'shadow-[0_1px_2px_rgba(0,0,0,0.35)]',
          'transition-[transform,width,opacity] duration-300 ease-out motion-reduce:transition-none',
          indicator ? 'opacity-100' : 'opacity-0',
        )}
        style={
          indicator
            ? { width: indicator.width, transform: `translateX(${indicator.left}px)`, left: 0 }
            : undefined
        }
      />

      {PROGRAMS.map((option) => {
        const isActive = option.value === shown;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttonRefs.current.set(option.value, node);
              else buttonRefs.current.delete(option.value);
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={controls}
            // Only the active option is in the tab order; arrows move between
            // them. That is the roving-tabindex pattern a tablist expects.
            tabIndex={isActive ? 0 : -1}
            onClick={() => select(option.value)}
            className={cn(
              /*
               * Sized to be pressed, and to look deliberate: the padding steps
               * up at `sm` so two labels still sit side by side at 320px
               * without wrapping or overflowing.
               */
              'relative z-10 rounded-lg px-5 py-2.5 text-[0.9375rem] font-semibold whitespace-nowrap',
              'sm:px-8 sm:py-3 sm:text-base',
              'transition-colors duration-200 motion-reduce:transition-none',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
              isActive
                ? 'text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}

      {/*
       * Announced, not drawn. Sighted users see the shelf change; a screen
       * reader would otherwise get nothing between the press and the new
       * content arriving.
       */}
      <span aria-live="polite" className="sr-only">
        {isPending ? 'Loading the catalogue…' : null}
      </span>
    </div>
  );
}
