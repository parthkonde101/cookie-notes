import { SETTLE, STOPS } from '@/components/home/cinematic/story-config';

/**
 * Where the film should come to rest when the viewer stops scrolling.
 *
 * `target` is where the scrollbar is, `anchor` where this scroll began. A small
 * nudge goes back to the nearest stop; a real push carries on to the next stop
 * in the direction of travel — and a viewer who is already sitting on a stop
 * stays there. Returns null when there is nowhere better to be.
 */
export function pickStop(target: number, anchor: number): number | null {
  const stops = STOPS as readonly number[];
  const nearest = stops.reduce(
    (best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best),
    stops[0],
  );
  if (Math.abs(nearest - target) < 0.003) return null;

  const push = target - anchor;
  if (Math.abs(push) < SETTLE.minPush) return nearest;

  if (push > 0) {
    const ahead = stops.find((s) => s > target + 0.003);
    return ahead ?? stops[stops.length - 1];
  }
  const behind = [...stops].reverse().find((s) => s < target - 0.003);
  return behind ?? stops[0];
}

/** How long a glide takes: a short hop is brisk, the longest is slow and easy to follow. */
export function glideDuration(distance: number) {
  return SETTLE.glideMin + SETTLE.glideExtra * Math.min(1, Math.abs(distance) / 0.2);
}

export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
