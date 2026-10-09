/**
 * Where things rest on the desk.
 *
 * Every loose object on the desk is a flat footprint with a thickness. Placing
 * them in the order they arrive, each one is lowered until it lands on whatever
 * it actually overlaps — the desk, a sheet, a notebook — so papers lie over
 * papers, a pen lies across a page, and nothing sinks into, or floats above,
 * anything else. Pure maths, so it can be checked without a renderer.
 */

export interface Body {
  /** Centre on the desk, and the turn about the vertical. */
  x: number;
  z: number;
  rot: number;
  /** Half the footprint along the body's own x and z. */
  hx: number;
  hz: number;
  /** Thickness. */
  height: number;
}

export interface Resting {
  /** Height of the underside above the desk. */
  base: number;
  /** Height of the top surface. */
  top: number;
  /** 0 on the desk itself, 1 on something that is on the desk, and so on. */
  level: number;
  /** Indices of the bodies it rests on. */
  on: number[];
}

/** Do two footprints overlap? Separating-axis test, a little forgiving at the corners. */
export function overlaps(a: Body, b: Body, slack = 0.92): boolean {
  const axes = (r: number): [number, number][] => [
    [Math.cos(r), -Math.sin(r)],
    [Math.sin(r), Math.cos(r)],
  ];
  const radius = (body: Body, ax: [number, number]) => {
    const [ux, uz] = axes(body.rot)[0];
    const [vx, vz] = axes(body.rot)[1];
    return (
      body.hx * slack * Math.abs(ux * ax[0] + uz * ax[1]) +
      body.hz * slack * Math.abs(vx * ax[0] + vz * ax[1])
    );
  };
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const ax of [...axes(a.rot), ...axes(b.rot)]) {
    const gap = Math.abs(dx * ax[0] + dz * ax[1]);
    if (gap > radius(a, ax) + radius(b, ax)) return false;
  }
  return true;
}

/** Lowers each body, in order, onto the highest thing under it. */
export function settle(bodies: Body[]): Resting[] {
  const placed: Resting[] = [];
  bodies.forEach((body, i) => {
    let base = 0;
    let level = 0;
    const on: number[] = [];
    for (let j = 0; j < i; j += 1) {
      if (!overlaps(body, bodies[j])) continue;
      if (placed[j].top > base + 1e-6) {
        base = placed[j].top;
        level = placed[j].level + 1;
        on.length = 0;
      }
      if (Math.abs(placed[j].top - base) < 1e-6) on.push(j);
    }
    placed.push({ base, top: base + body.height, level, on });
  });
  return placed;
}
