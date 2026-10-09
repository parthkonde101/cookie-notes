import * as THREE from 'three';

/** Small helpers shared by every procedural texture in the scene. */

export type Ctx = CanvasRenderingContext2D;
export type PageSource = CanvasImageSource & { width: number; height: number };

export function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return [c, ctx];
}

export function texture(
  c: HTMLCanvasElement,
  opts?: { repeat?: boolean; anisotropy?: number; linear?: boolean },
) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts?.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts?.anisotropy ?? 4;
  if (opts?.repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.needsUpdate = true;
  return t;
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
