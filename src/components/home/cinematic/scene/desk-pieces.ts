import type { Vec3 } from '@/components/home/cinematic/story-config';
import {
  overlaps,
  settle,
  type Body,
  type Resting,
} from '@/components/home/cinematic/scene/desk-layout';

/**
 * The loose things on the desk, and where each one lies. The data here is only
 * a footprint on the desk and an arrival order; how high each piece sits is
 * worked out from what is underneath it (see `desk-layout.ts`), so papers lie
 * over papers and nothing passes through anything else.
 */

export type Piece =
  | { kind: 'sheet'; position: Vec3; rotationY: number; seed: number }
  | { kind: 'notebook'; position: Vec3; rotationY: number; color: string; size: Vec3 }
  | { kind: 'sticky'; position: Vec3; rotationY: number; color: string; seed: number }
  | { kind: 'pen'; position: Vec3; rotationY: number; color: string }
  | { kind: 'stack'; position: Vec3; rotationY: number };

/** Already on the desk from the start — the notes that get passed around. */
export const BASE: Piece[] = [
  { kind: 'sheet', position: [0.7, 0.003, 0.26], rotationY: -0.02, seed: 101 },
  { kind: 'sheet', position: [0.81, 0.007, 0.22], rotationY: -0.3, seed: 102 },
  { kind: 'sheet', position: [0.6, 0.011, 0.24], rotationY: 0.32, seed: 103 },
  {
    kind: 'notebook',
    position: [0.94, 0.02, -0.02],
    rotationY: 0.25,
    color: '#3b5878',
    size: [0.22, 0.035, 0.3],
  },
  { kind: 'pen', position: [0.56, 0.012, 0.36], rotationY: 0.6, color: '#1c3f7a' },
];

/**
 * Arrive one after another while "Or do you refer to the notes taken in
 * class?" is on screen. Ordered so the desk fills the way a real one does: a
 * few loose sheets, a notebook, more sheets, then everything at once.
 */
export const BUILD: Piece[] = [
  { kind: 'sheet', position: [0.87, 0.003, 0.29], rotationY: 1.35, seed: 201 },
  { kind: 'sheet', position: [1.24, 0.004, 0.18], rotationY: 0.25, seed: 202 },
  {
    kind: 'notebook',
    position: [1.18, 0.025, 0.08],
    rotationY: -0.4,
    color: '#8a4b3a',
    size: [0.2, 0.04, 0.28],
  },
  { kind: 'sticky', position: [0.6, 0.016, 0.04], rotationY: 0.5, color: '#f5d66b', seed: 300 },
  { kind: 'sheet', position: [1.15, 0.003, -0.26], rotationY: 1.1, seed: 203 },
  { kind: 'pen', position: [0.98, 0.012, 0.31], rotationY: -1.0, color: '#7a1f1f' },
  { kind: 'sheet', position: [0.78, 0.01, -0.44], rotationY: -0.5, seed: 204 },
  { kind: 'sticky', position: [1.0, 0.02, 0.22], rotationY: -0.5, color: '#f0a1b5', seed: 301 },
  {
    kind: 'notebook',
    position: [0.5, 0.02, 0.24],
    rotationY: 0.5,
    color: '#496b4f',
    size: [0.18, 0.034, 0.25],
  },
  { kind: 'sheet', position: [1.22, 0.009, -0.34], rotationY: 0.12, seed: 205 },
  { kind: 'sticky', position: [0.42, 0.014, -0.16], rotationY: 0.9, color: '#9fd6a8', seed: 302 },
  { kind: 'sheet', position: [0.3, 0.012, -0.38], rotationY: 1.2, seed: 206 },
  { kind: 'stack', position: [1.26, 0.06, -0.42], rotationY: 0.0 },
  { kind: 'sheet', position: [0.9, 0.004, -0.4], rotationY: -0.15, seed: 207 },
  { kind: 'sticky', position: [1.1, 0.02, -0.11], rotationY: 0.1, color: '#f5d66b', seed: 303 },
  { kind: 'sheet', position: [0.66, 0.015, -0.45], rotationY: -0.05, seed: 208 },
  { kind: 'pen', position: [0.96, 0.012, -0.24], rotationY: 0.3, color: '#202020' },
  { kind: 'sheet', position: [0.48, 0.017, -0.4], rotationY: -1.1, seed: 209 },
  { kind: 'sticky', position: [0.88, 0.02, 0.44], rotationY: 0.0, color: '#8fc6ee', seed: 304 },
  { kind: 'sheet', position: [0.9, 0.016, -0.5], rotationY: 1.35, seed: 210 },
];

/** Thickness of each kind of piece, in metres. */
const THICKNESS = { sheet: 0.0016, sticky: 0.0008, pen: 0.0116, stack: 0.121 } as const;

/** What a piece covers on the desk, for working out what rests on what. */
export function bodyOf(piece: Piece): Body {
  const common = { x: piece.position[0], z: piece.position[2], rot: piece.rotationY };
  switch (piece.kind) {
    case 'sheet':
      return { ...common, hx: 0.15, hz: 0.21, height: THICKNESS.sheet };
    case 'sticky':
      return { ...common, hx: 0.0375, hz: 0.0375, height: THICKNESS.sticky };
    case 'pen':
      return { ...common, hx: 0.07, hz: 0.007, height: THICKNESS.pen };
    case 'notebook':
      return { ...common, hx: piece.size[0] / 2, hz: piece.size[2] / 2, height: piece.size[1] };
    case 'stack':
      return { ...common, hx: 0.15, hz: 0.2, height: THICKNESS.stack };
  }
}

export const ALL_PIECES: Piece[] = [...BASE, ...BUILD];

/** Where each piece comes to rest, in arrival order: the underside, the top, and what it is on. */
export const PLACED: Resting[] = settle(ALL_PIECES.map(bodyOf));

/**
 * Pieces with something lying on top of them. A covered sheet is kept flat,
 * so the sheet above can never pass through it; only the top of a pile curls.
 */
export const COVERED: boolean[] = ALL_PIECES.map((piece, i) =>
  ALL_PIECES.some(
    (_, j) =>
      j > i &&
      PLACED[j].base >= PLACED[i].top - 1e-6 &&
      overlaps(bodyOf(ALL_PIECES[j]), bodyOf(piece)),
  ),
);

/** The height at which a piece's own origin goes, given how its model is built. */
export function originY(piece: Piece, rest: Resting): number {
  switch (piece.kind) {
    case 'sheet':
      return rest.base + 0.0004;
    case 'sticky':
      return rest.base + 0.0006;
    case 'pen':
      return rest.base + 0.0058;
    case 'notebook':
      return rest.base + piece.size[1] / 2;
    case 'stack':
      return rest.base + 0.05;
  }
}
