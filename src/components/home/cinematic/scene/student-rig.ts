import * as THREE from 'three';

/**
 * Posing a skinned character from code.
 *
 * The student is one skinned mesh on a Rigify deform skeleton. The export keeps
 * only the deform bones, which leaves the arms, the shoulders and every face
 * bone as loose siblings of the skeleton root — turn the spine and they would
 * stay behind. `rebuildHierarchy` puts the chain back together (keeping every
 * bone exactly where it is, so the rest pose does not change), and the rest of
 * this file turns bones in world space: aim a bone at a point, spin it about an
 * axis, or solve a two-bone limb so a hand or a foot lands where it is wanted.
 */

export type Bones = Record<string, THREE.Bone>;

/** glTF loading strips dots from node names: `DEF-spine.001` is `DEF-spine001`. */
export const boneKey = (name: string) => name.replace(/\./g, '');

export function collectBones(root: THREE.Object3D): Bones {
  const bones: Bones = {};
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones[boneKey(o.name)] = o as THREE.Bone;
  });
  return bones;
}

/**
 * Hangs the loose deform bones back on the skeleton: legs on the hips, shoulders
 * on the chest, arms on their shoulders, everything on the face on the head.
 * `attach` keeps each bone's world transform, so nothing visibly moves.
 */
export function rebuildHierarchy(root: THREE.Object3D, bones: Bones) {
  root.updateMatrixWorld(true);
  const hips = bones['DEF-spine'];
  const chest = bones['DEF-spine003'];
  const head = bones['DEF-spine006'];

  const parentFor = (name: string): THREE.Object3D => {
    if (/^DEF-(pelvis|thigh)/.test(name)) return hips;
    if (/^DEF-(shoulder|breast)/.test(name)) return chest;
    const arm = /^DEF-upper_arm(L|R)$/.exec(name);
    if (arm) return bones[`DEF-shoulder${arm[1]}`];
    return head;
  };

  for (const [name, bone] of Object.entries(bones)) {
    if (name === 'DEF-spine') continue;
    if (bone.parent && (bone.parent as THREE.Bone).isBone) continue;
    parentFor(name).attach(bone);
  }
  root.updateMatrixWorld(true);
}

export interface Rest {
  bone: THREE.Bone;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export function captureRest(bones: Bones): Rest[] {
  return Object.values(bones).map((bone) => ({
    bone,
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
  }));
}

export function resetToRest(rest: Rest[]) {
  for (const r of rest) {
    r.bone.position.copy(r.position);
    r.bone.quaternion.copy(r.quaternion);
  }
}

/* ------------------------------------------------------------------ */
/* World-space bone turns                                              */
/* ------------------------------------------------------------------ */

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const D0 = new THREE.Vector3();
const D1 = new THREE.Vector3();
const QD = new THREE.Quaternion();
const QB = new THREE.Quaternion();
const QP = new THREE.Quaternion();

/** Applies a world-space rotation to `bone`, expressed through its local rotation. */
function turn(bone: THREE.Bone, delta: THREE.Quaternion) {
  bone.getWorldQuaternion(QB);
  if (bone.parent) bone.parent.getWorldQuaternion(QP);
  else QP.identity();
  bone.quaternion.copy(QP).invert().multiply(delta).multiply(QB);
  bone.updateMatrixWorld(true);
}

/** Spins `bone` about a world-space axis (through the bone's own joint). */
export function rotateAbout(bone: THREE.Bone, axis: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-6) return;
  turn(bone, QD.setFromAxisAngle(axis, angle));
}

/** Turns `bone` so the line from it to `tip` points at `target`. */
export function aim(bone: THREE.Bone, tip: THREE.Object3D, target: THREE.Vector3) {
  bone.getWorldPosition(A);
  tip.getWorldPosition(B);
  D0.subVectors(B, A).normalize();
  D1.subVectors(target, A).normalize();
  turn(bone, QD.setFromUnitVectors(D0, D1));
}

const P = new THREE.Vector3();
const M = new THREE.Vector3();
const ELBOW = new THREE.Vector3();
const REACHED = new THREE.Vector3();
const U = new THREE.Vector3();

/**
 * Two-bone limb: puts `tip` (a wrist, an ankle) on `target`, bending the middle
 * joint (elbow, knee) toward `pole`. If the target is out of reach the limb
 * straightens and falls short rather than stretching.
 */
export function solveLimb(
  root: THREE.Bone,
  mid: THREE.Bone,
  tip: THREE.Bone,
  lengths: readonly [number, number],
  target: THREE.Vector3,
  pole: THREE.Vector3,
) {
  const [l1, l2] = lengths;
  root.getWorldPosition(P);
  U.subVectors(target, P);
  const reach = Math.min(Math.max(U.length(), Math.abs(l1 - l2) + 1e-3), (l1 + l2) * 0.999);
  U.normalize();

  const along = (l1 * l1 + reach * reach - l2 * l2) / (2 * reach);
  const off = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  M.copy(pole).addScaledVector(U, -pole.dot(U)).normalize();
  ELBOW.copy(P).addScaledVector(U, along).addScaledVector(M, off);
  REACHED.copy(P).addScaledVector(U, reach);

  aim(root, mid, ELBOW);
  aim(mid, tip, REACHED);
}

export function limbLengths(root: THREE.Bone, mid: THREE.Bone, tip: THREE.Bone): [number, number] {
  root.getWorldPosition(A);
  mid.getWorldPosition(B);
  const l1 = A.distanceTo(B);
  tip.getWorldPosition(A);
  return [l1, B.distanceTo(A)];
}

/* ------------------------------------------------------------------ */
/* Hands                                                               */
/* ------------------------------------------------------------------ */

export interface HandBones {
  hand: THREE.Bone;
  middle: THREE.Bone;
  index: THREE.Bone;
  pinky: THREE.Bone;
}

const FWD = new THREE.Vector3();
const ACR = new THREE.Vector3();
const NRM = new THREE.Vector3();
const FROM = new THREE.Matrix4();
const TO = new THREE.Matrix4();
const QH = new THREE.Quaternion();
const QHF = new THREE.Quaternion();
const WRIST = new THREE.Vector3();

function basis(out: THREE.Matrix4, forward: THREE.Vector3, normal: THREE.Vector3) {
  const f = forward.clone().normalize();
  const n = normal.clone().addScaledVector(f, -normal.dot(f)).normalize();
  const side = new THREE.Vector3().crossVectors(f, n).normalize();
  return out.makeBasis(f, n, side);
}

/**
 * Turns a hand so the fingers point along `forward` with the palm facing `palm`.
 * It reads the hand's own current shape (wrist, middle knuckle, the knuckle
 * line), so it does not care how the bone axes happen to be named.
 */
export function orientHand(
  hand: HandBones,
  forward: THREE.Vector3,
  palm: THREE.Vector3,
  inward: 1 | -1,
) {
  hand.hand.getWorldPosition(WRIST);
  hand.middle.getWorldPosition(FWD);
  FWD.sub(WRIST);
  hand.index.getWorldPosition(ACR);
  hand.pinky.getWorldPosition(NRM);
  ACR.sub(NRM);
  // Palm normal: across the knuckles × along the fingers, signed so it points
  // out of the palm (inward is toward the body's centre line in the rest pose).
  NRM.crossVectors(ACR, FWD).normalize().multiplyScalar(inward);

  basis(FROM, FWD, NRM);
  basis(TO, forward, palm);
  QH.setFromRotationMatrix(TO).multiply(QHF.setFromRotationMatrix(FROM).invert());
  turn(hand.hand, QH);
}

/** Palm normal of a hand as it stands now, signed like `orientHand`. */
export function palmNormal(hand: HandBones, inward: 1 | -1, out: THREE.Vector3) {
  hand.hand.getWorldPosition(WRIST);
  hand.middle.getWorldPosition(FWD);
  FWD.sub(WRIST);
  hand.index.getWorldPosition(ACR);
  hand.pinky.getWorldPosition(NRM);
  ACR.sub(NRM);
  return out.crossVectors(ACR, FWD).normalize().multiplyScalar(inward);
}

/**
 * Curls a finger: bends each joint about the knuckle line, toward the palm.
 * `joints` runs from the base of the finger to its last segment.
 */
export function curlFinger(
  joints: THREE.Bone[],
  knuckleAxis: THREE.Vector3,
  palm: THREE.Vector3,
  angles: readonly number[],
) {
  // Which way about the axis moves the fingertip toward the palm? Read once,
  // from the finger's whole length, so every joint bends the same way.
  joints[0].getWorldPosition(A);
  joints[joints.length - 1].getWorldPosition(B);
  B.sub(A);
  const sign = Math.sign(D0.crossVectors(knuckleAxis, B).dot(palm)) || 1;
  joints.forEach((joint, i) => rotateAbout(joint, knuckleAxis, sign * (angles[i] ?? 0)));
}
