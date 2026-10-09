import { cn } from '@/lib/utils';

/**
 * A continuously scrolling, seamlessly looping row — generic enough for
 * anything that wants this effect later (a logo strip, a stat ticker), not
 * just testimonials.
 *
 * The technique: render `children` twice, back to back, inside a track
 * animated from `translateX(0)` to `translateX(-50%)`. Because the two
 * copies are identical, the moment the first scrolls fully offscreen is the
 * exact moment the second reaches the start — no jump, no reset, no gap.
 *
 * The second copy is `aria-hidden`: a screen reader should encounter each
 * item once, not twice. Hover pauses the track via a plain CSS
 * `group-hover`, so nothing here needs JavaScript. `motion-reduce` drops the
 * animation entirely — the content stays, laid out as a plain wrapped row,
 * which is what the parent's `flex-wrap` (via `pauseOnHover` off) falls back
 * to.
 */
export function Marquee({
  children,
  className,
  /** Applied to the gap between every item, including the seam between the
   * two copies — so the loop point is spaced exactly like every other gap. */
  gapClassName = 'gap-4 sm:gap-5',
}: {
  children: React.ReactNode;
  className?: string;
  gapClassName?: string;
}) {
  return (
    <div
      className={cn(
        'group/marquee overflow-hidden',
        '[mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)]',
        // Reduced motion: nothing is moving, so a fade-to-transparent edge
        // would just look like clipped content rather than an animation cue.
        // A native horizontal scroll replaces the loop instead of wrapping —
        // simpler than reflowing fixed-width cards into a wrapped grid.
        'motion-reduce:overflow-x-auto motion-reduce:[mask-image:none]',
        className,
      )}
    >
      <div
        className={cn(
          'flex w-max animate-marquee motion-reduce:animate-none',
          'group-hover/marquee:[animation-play-state:paused]',
          gapClassName,
        )}
      >
        <div className={cn('flex shrink-0 items-stretch', gapClassName)}>{children}</div>
        <div
          aria-hidden="true"
          className={cn('flex shrink-0 items-stretch motion-reduce:hidden', gapClassName)}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
