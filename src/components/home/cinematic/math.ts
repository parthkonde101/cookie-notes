export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 0 before `a`, 1 after `b`, eased in between. */
export function smoothstep(a: number, b: number, v: number) {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function smootherstep(t: number) {
  const x = clamp(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Fades in across `inside`, out across `outside`. Pass an `outside` of [2, 2] for "never leaves". */
export function windowed(
  p: number,
  inside: readonly [number, number],
  outside: readonly [number, number],
) {
  return smoothstep(inside[0], inside[1], p) * (1 - smoothstep(outside[0], outside[1], p));
}

/** Small seeded generator, so procedural textures are identical on every render. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
