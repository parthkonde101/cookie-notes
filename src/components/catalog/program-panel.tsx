'use client';

import { useProgramTransition } from '@/components/catalog/program-transition';
import { cn } from '@/lib/utils';

/**
 * The region the programme selector swaps, and the only thing that animates
 * during a switch.
 *
 * ## Outgoing: a transition, not a keyframe
 *
 * While the RSC payload is in flight the shelf that is still on screen dims and
 * settles back 6px. That is a plain CSS `transition` on `opacity` and
 * `transform`, so it starts the instant the class changes — the press gets an
 * answer in the next frame instead of when the server replies. It is also
 * reversible: if the payload lands early the properties animate straight back,
 * with no half-finished keyframe to abandon.
 *
 * `pointer-events-none` while pending stops a second click landing on content
 * that is about to be replaced.
 *
 * ## Incoming: handled by the children, not here
 *
 * This component deliberately does **not** fade the new shelf in. The arriving
 * content animates itself, card by card, via `animate-catalog-enter` — and
 * stacking a container fade on top of that would mean two opacity animations
 * multiplying into a muddy double-fade. One job each.
 *
 * ## Cost
 *
 * Only `opacity` and `transform` are touched, both compositor properties, so
 * nothing here triggers layout or paint. `will-change` is deliberately absent:
 * the animation is 200ms and promoting a full-page container to its own layer
 * for that long costs more memory than it saves.
 */
export interface ProgramPanelProps {
  id?: string;
  /** Accessible name, e.g. "B.Tech catalogue". */
  label?: string;
  className?: string;
  children: React.ReactNode;
}

export function ProgramPanel({ id, label, className, children }: ProgramPanelProps) {
  const transition = useProgramTransition();
  const isPending = transition?.isPending ?? false;

  return (
    <div
      id={id}
      role="tabpanel"
      aria-label={label}
      // Exposed for tests and for anyone debugging the transition in devtools.
      data-pending={isPending ? 'true' : undefined}
      // `aria-busy` is the accessible half of the dimming: a screen reader is
      // told the region is updating rather than being left to infer it.
      aria-busy={isPending || undefined}
      className={cn(
        'transition-[opacity,transform] duration-200 ease-in-out',
        /*
         * Reduced motion keeps the fade and drops the movement. Removing the
         * transition outright would leave someone who asked for less motion
         * with no acknowledgement of their press at all — an opacity change is
         * not motion, and it is the part doing the communicating here.
         */
        'motion-reduce:transition-[opacity] motion-reduce:duration-150',
        isPending
          ? 'pointer-events-none translate-y-1.5 opacity-45 motion-reduce:translate-y-0'
          : 'translate-y-0 opacity-100',
        className,
      )}
    >
      {children}
    </div>
  );
}
