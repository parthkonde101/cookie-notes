import * as THREE from 'three';
import { SHOTS } from '@/components/home/cinematic/story-config';
import { lerp, smootherstep } from '@/components/home/cinematic/math';

/**
 * Three splines — where the camera is, where it is looking, and (for narrow
 * screens) where the subject really is — built once from the shot list. All
 * three are sampled with the same parameter, so they always travel together.
 */
const positionKeys = SHOTS.map((s) => new THREE.Vector3(...s.position));
const targetKeys = SHOTS.map((s) => new THREE.Vector3(...s.target));
const focusKeys = SHOTS.map((s) => new THREE.Vector3(...(s.focus ?? s.target)));

const positions = new THREE.CatmullRomCurve3(positionKeys, false, 'centripetal');
const targets = new THREE.CatmullRomCurve3(targetKeys, false, 'centripetal');
const focuses = new THREE.CatmullRomCurve3(focusKeys, false, 'centripetal');

/**
 * Below these distances, two neighbouring keys are a HOLD (or a drift so small
 * it is one), and the curve between them is not used: the camera goes in a
 * straight line, eased. A Catmull-Rom segment takes its tangents from the keys
 * either side, so between two near-identical keys it bows out and back — the
 * look-at, or on a phone the focus point, swings while the camera is supposed
 * to be standing still. A straight line cannot overshoot, and nothing is lost
 * at the ends: every key is a rest, so there is no speed to match across it.
 */
const STRAIGHT_BELOW = { position: 0.5, target: 0.15, focus: 0.15 };

const straight = (keys: THREE.Vector3[], limit: number) =>
  keys.slice(0, -1).map((key, i) => key.distanceTo(keys[i + 1]) <= limit);

const STRAIGHT_POSITION = straight(positionKeys, STRAIGHT_BELOW.position);
const STRAIGHT_TARGET = straight(targetKeys, STRAIGHT_BELOW.target);
const STRAIGHT_FOCUS = straight(focusKeys, STRAIGHT_BELOW.focus);

export interface CameraSample {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** The same path, aimed at the subject itself — for narrow screens. */
  focus: THREE.Vector3;
  fov: number;
  /** How far down the frame to carry the subject on a narrow screen (a fraction of its height). */
  lift: number;
  /** How far back to stand on a narrow screen, relative to the standard compensation. */
  fit: number;
}

const out: CameraSample = {
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
  focus: new THREE.Vector3(),
  fov: 38,
  lift: 0,
  fit: 1,
};

function pointOn(
  curve: THREE.CatmullRomCurve3,
  keys: THREE.Vector3[],
  isStraight: boolean[],
  i: number,
  u: number,
  eased: number,
  into: THREE.Vector3,
) {
  if (isStraight[i]) into.lerpVectors(keys[i], keys[i + 1], eased);
  else curve.getPoint(u, into);
}

/**
 * Where the camera is at `progress`. Within each pair of shots the move is
 * eased by that shot's `dwell`: 0 passes through at constant speed, 1 settles
 * completely, so the camera rests where the story is speaking. Every shot in
 * the film is `dwell: 1`, so every move starts and stops at rest, with no
 * lurch at a keyframe.
 */
export function sampleCamera(progress: number): CameraSample {
  const last = SHOTS.length - 1;
  let i = 0;
  while (i < last - 1 && progress >= SHOTS[i + 1].at) i += 1;

  const a = SHOTS[i];
  const b = SHOTS[i + 1];
  const span = Math.max(1e-6, b.at - a.at);
  const s = Math.min(1, Math.max(0, (progress - a.at) / span));
  const dwell = a.dwell ?? 0.75;
  const eased = lerp(s, smootherstep(s), dwell);
  const u = (i + eased) / last;

  pointOn(positions, positionKeys, STRAIGHT_POSITION, i, u, eased, out.position);
  pointOn(targets, targetKeys, STRAIGHT_TARGET, i, u, eased, out.target);
  pointOn(focuses, focusKeys, STRAIGHT_FOCUS, i, u, eased, out.focus);
  out.fov = lerp(a.fov, b.fov, eased);
  out.lift = lerp(a.lift ?? 0, b.lift ?? 0, eased);
  out.fit = lerp(a.fit ?? 1, b.fit ?? 1, eased);
  return out;
}
