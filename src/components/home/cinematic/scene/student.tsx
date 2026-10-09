'use client';

import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CUES, SIT_BACK } from '@/components/home/cinematic/story-config';
import { lerp, smoothstep, windowed } from '@/components/home/cinematic/math';
import { useStory } from '@/components/home/cinematic/story-state';
import { prefetchStudent } from '@/components/home/cinematic/student-asset';
import { ProceduralStudent } from '@/components/home/cinematic/scene/student-fallback';
import {
  aim,
  captureRest,
  collectBones,
  curlFinger,
  limbLengths,
  orientHand,
  palmNormal,
  rebuildHierarchy,
  resetToRest,
  rotateAbout,
  solveLimb,
  type Bones,
  type HandBones,
  type Rest,
} from '@/components/home/cinematic/scene/student-rig';

/**
 * A college student in a blazer, working at a laptop.
 *
 * The character is a real modelled-and-rigged asset (see public/home/student.glb,
 * credit in the site footer), posed from code on every frame: seated with the
 * hips on the chair, the spine leaning to the screen, the hands on the keys, the
 * head turning to whatever the camera is looking at. The skeleton does the work,
 * so the shoulders, the elbows and the neck all bend the way a body does.
 */


/* Where things are in the room (the same numbers the desk, chair and laptop use). */
const HIPS = new THREE.Vector3(0, -0.27, 0.76);
const FLOOR_Y = -0.742;
const MODEL_SCALE = 1.0;
/** Half the width of the pair of hands on the keyboard, and where the wrists sit. */
const WRIST = { x: 0.115, y: 0.05, z: 0.38 } as const;
/** Where a wrist rests, on the desk just in front of the laptop, once the hands come off the keys. */
const TABLE_REST = { x: 0.22, y: 0.035, z: 0.54 } as const;
const FOOT = { x: 0.15, z: 0.4 } as const;

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

type Side = 'L' | 'R';
const SIDES: Side[] = ['L', 'R'];
const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;

interface Arm {
  side: Side;
  /** +1 on the +x side of the room, -1 on the other. */
  sx: 1 | -1;
  shoulder: THREE.Bone;
  upper: THREE.Bone;
  fore: THREE.Bone;
  hand: HandBones;
  fingers: THREE.Bone[][];
  lengths: [number, number];
  /** Which way the palm normal must be flipped so it points out of the palm. */
  inward: 1 | -1;
}

interface Leg {
  sx: 1 | -1;
  thigh: THREE.Bone;
  shin: THREE.Bone;
  foot: THREE.Bone;
  toe: THREE.Bone;
  lengths: [number, number];
  /** Rest-pose direction from ankle to ball of the foot, turned to face forward. */
  toeDir: THREE.Vector3;
  ankleHeight: number;
}

interface Figure {
  scene: THREE.Group;
  /** Where the model's pelvis was put on the seat, before it slides back. */
  baseZ: number;
  bones: Bones;
  rest: Rest[];
  spine: THREE.Bone[];
  neck: THREE.Bone[];
  head: THREE.Bone;
  arms: Arm[];
  legs: Leg[];
  dispose: () => void;
}

function worldSide(bone: THREE.Bone): 1 | -1 {
  return bone.getWorldPosition(new THREE.Vector3()).x >= 0 ? 1 : -1;
}

/** Reads the downloaded model into a scene graph (not yet posed). */
function parseStudent(): Promise<GLTF> {
  return prefetchStudent().then(
    (data) =>
      new Promise<GLTF>((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.parse(data, '', resolve, reject);
      }),
  );
}

// Reading the model starts the moment this code arrives, while the canvas and
// the renderer are still being set up, instead of after they are ready. A parsed
// scene can only be built into one figure, so each is handed out once; any later
// mount parses afresh.
let preparsed: Promise<GLTF> | null = null;
if (typeof window !== 'undefined') {
  preparsed = parseStudent();
  preparsed.catch(() => {});
}

function takeParsedStudent(): Promise<GLTF> {
  const parsed = preparsed ?? parseStudent();
  preparsed = null;
  return parsed;
}

/** Loads the model and turns it into something that can be posed. */
function useFigure(): { figure: Figure | null; failed: boolean } {
  const [state, setState] = useState<{ figure: Figure | null; failed: boolean }>({
    figure: null,
    failed: false,
  });

  useEffect(() => {
    let cancelled = false;
    let built: Figure | null = null;
    const fail = () => {
      if (!cancelled) setState({ figure: null, failed: true });
    };

    takeParsedStudent()
      .then((gltf) => {
        if (cancelled) return;
        try {
          built = buildFigure(gltf.scene);
          setState({ figure: built, failed: false });
        } catch {
          fail();
        }
      })
      .catch(fail);

    return () => {
      cancelled = true;
      built?.dispose();
    };
  }, []);

  return state;
}

function buildFigure(model: THREE.Group): Figure {
  const bones = collectBones(model);
  const need = (name: string) => {
    const bone = bones[name];
    if (!bone) throw new Error(`student model is missing ${name}`);
    return bone;
  };

  // Facing: the asset looks down +z, the room's student looks down -z.
  model.rotation.y = Math.PI;
  model.scale.setScalar(MODEL_SCALE);

  rebuildHierarchy(model, bones);

  const skinned: THREE.SkinnedMesh[] = [];
  const disposables: { dispose: () => void }[] = [];
  model.traverse((o) => {
    if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mesh = o as THREE.SkinnedMesh;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The pose changes the bounds every frame; the student is always in view anyway.
    mesh.frustumCulled = false;
    const material = mesh.material as THREE.MeshStandardMaterial;
    // The glow map is black; keep the GPU from carrying it.
    material.emissiveMap?.dispose();
    material.emissiveMap = null;
    material.emissive.set(0x000000);
    skinned.push(mesh);
    disposables.push(mesh.geometry, material);
    for (const key of ['map', 'normalMap', 'metalnessMap', 'roughnessMap'] as const) {
      const texture = material[key];
      if (texture) disposables.push(texture);
    }
  });

  // Put the pelvis where the chair is, and the feet will fall out of the legs.
  model.updateMatrixWorld(true);
  const pelvis = new THREE.Vector3();
  need('DEF-spine').getWorldPosition(pelvis);
  model.position.add(HIPS).sub(pelvis);
  model.updateMatrixWorld(true);

  const rest = captureRest(bones);

  const arms: Arm[] = SIDES.map((side) => {
    const shoulder = need(`DEF-shoulder${side}`);
    const upper = need(`DEF-upper_arm${side}`);
    const fore = need(`DEF-forearm${side}`);
    const hand = need(`DEF-hand${side}`);
    const finger = (name: string, n: number) => need(`DEF-f_${name}0${n}${side}`);
    return {
      side,
      sx: worldSide(hand),
      shoulder,
      upper,
      fore,
      hand: {
        hand,
        middle: finger('middle', 1),
        index: finger('index', 1),
        pinky: finger('pinky', 1),
      },
      fingers: FINGERS.map((name) => [finger(name, 1), finger(name, 2), finger(name, 3)]),
      lengths: limbLengths(upper, fore, hand),
      inward: 1,
    } satisfies Arm;
  });

  // The rest pose is arms-down with palms toward the thighs, so the palm normal
  // (knuckle line × finger direction) points toward the body: sign it that way.
  const normal = new THREE.Vector3();
  for (const arm of arms) {
    palmNormal(arm.hand, 1, normal);
    const towardBody = -arm.sx * normal.x;
    arm.inward = towardBody >= 0 ? 1 : -1;
  }

  const legs: Leg[] = SIDES.map((side) => {
    const thigh = need(`DEF-thigh${side}`);
    const shin = need(`DEF-shin${side}`);
    const foot = need(`DEF-foot${side}`);
    const toe = need(`DEF-toe${side}`);
    const ankle = foot.getWorldPosition(new THREE.Vector3());
    const ball = toe.getWorldPosition(new THREE.Vector3());
    const v = ball.clone().sub(ankle);
    return {
      sx: worldSide(foot),
      thigh,
      shin,
      foot,
      toe,
      lengths: limbLengths(thigh, shin, foot),
      toeDir: new THREE.Vector3(0, v.y, -Math.hypot(v.x, v.z)),
      ankleHeight: ankle.y - (model.position.y + -0.0137 * MODEL_SCALE),
    };
  });

  return {
    scene: model,
    baseZ: model.position.z,
    bones,
    rest,
    spine: ['DEF-spine001', 'DEF-spine002', 'DEF-spine003'].map(need),
    neck: ['DEF-spine004', 'DEF-spine005'].map(need),
    head: need('DEF-spine006'),
    arms,
    legs,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

const target = new THREE.Vector3();
const pole = new THREE.Vector3();
const forward = new THREE.Vector3();
const palm = new THREE.Vector3();
const knuckles = new THREE.Vector3();
const tmp = new THREE.Vector3();

/** Everything that changes from frame to frame. */
interface Pose {
  /** How far the body leans toward the screen, radians. */
  lean: number;
  /** Radians the head and upper body are turned toward the book or the notes. */
  yaw: number;
  /** How much the head is dropped toward the screen, radians. */
  nod: number;
  /** Radians the upper back and shoulders round forward, as a person slumps in a chair. */
  slump: number;
  /** How far the whole body has slid back with the chair, metres. */
  slide: number;
  /** 0–1: how hard the hands are working. */
  typing: number;
  /** 0–1: hands off the keys and resting on the desk, sat back. */
  away: number;
  /** 0–1: stands the small idle motion (breath, sway) down. */
  idle: number;
  time: number;
}

function applyPose(figure: Figure, pose: Pose) {
  resetToRest(figure.rest);
  figure.scene.position.z = figure.baseZ + pose.slide;

  // Legs: thighs forward along the seat, shins down, feet flat on the floor.
  for (const leg of figure.legs) {
    target.set(leg.sx * FOOT.x, FLOOR_Y + leg.ankleHeight, FOOT.z);
    pole.set(leg.sx * 0.12, 1, -0.5);
    solveLimb(leg.thigh, leg.shin, leg.foot, leg.lengths, target, pole);
    leg.foot.getWorldPosition(target);
    target.add(forward.copy(leg.toeDir));
    aim(leg.foot, leg.toe, target);
  }

  // Spine: lean into the screen, share the turn, breathe.
  const [low, mid, chest] = figure.spine;
  const breath = Math.sin(pose.time * 1.15) * 0.0045 * pose.idle;
  // The torso leans as one piece from the lower back, so leaning back does not arch the chest;
  // the slump then rounds the upper back and shoulders a little.
  rotateAbout(low, RIGHT, -pose.lean * 0.7);
  rotateAbout(mid, RIGHT, -pose.lean * 0.25 + breath);
  rotateAbout(chest, RIGHT, -pose.lean * 0.05 - pose.slump + breath * 0.5);
  rotateAbout(low, UP, pose.yaw * 0.05);
  rotateAbout(mid, UP, pose.yaw * 0.08);
  rotateAbout(chest, UP, pose.yaw * 0.1);

  // Arms: wrists to the keyboard whatever the spine is doing; hands flat over the keys.
  for (const arm of figure.arms) {
    // Rounded shoulders: the collarbones swing forward, bringing the arms closer to the desk.
    rotateAbout(arm.shoulder, UP, arm.sx * pose.slump * 3);
    const sway = Math.sin(pose.time * 8 + arm.sx) * 0.004 * pose.typing;
    const off = pose.away;
    target.set(
      arm.sx * lerp(WRIST.x, TABLE_REST.x, off),
      lerp(WRIST.y + sway, TABLE_REST.y, off),
      lerp(WRIST.z, TABLE_REST.z, off),
    );
    pole.set(arm.sx * lerp(0.45, 0.9, off), lerp(-1, -0.5, off), lerp(0.15, 0.8, off));
    solveLimb(arm.upper, arm.fore, arm.hand.hand, arm.lengths, target, pole);

    forward.set(arm.sx * -0.05, lerp(-0.2, -0.08, off), -1);
    palm.set(0, -1, 0);
    orientHand(arm.hand, forward, palm, arm.inward);

    // Fingers curl over the keys; the touch typist's ripple rides on top.
    palmNormal(arm.hand, arm.inward, palm);
    arm.hand.index.getWorldPosition(knuckles);
    arm.hand.pinky.getWorldPosition(tmp);
    knuckles.sub(tmp).normalize();
    arm.fingers.forEach((joints, i) => {
      const ripple = Math.sin(pose.time * 8 + i * 1.7 + arm.sx) * 0.16 * pose.typing;
      curlFinger(joints, knuckles, palm, [
        lerp(-0.22 + ripple, 0.12, off),
        lerp(-0.28 + ripple * 0.6, 0.2, off),
        lerp(-0.12, 0.14, off),
      ]);
    });
  }

  // Neck and head: tipped to the screen, turned to the book or the pile.
  const sway = Math.sin(pose.time * 0.7) * 0.012 * pose.idle;
  const [lower, upper] = figure.neck;
  rotateAbout(lower, RIGHT, -pose.nod * 0.3 + sway * 0.4);
  rotateAbout(upper, RIGHT, -pose.nod * 0.3 + sway * 0.3);
  rotateAbout(figure.head, RIGHT, -pose.nod * 0.4 + sway * 0.3);
  rotateAbout(lower, UP, pose.yaw * 0.25);
  rotateAbout(upper, UP, pose.yaw * 0.3);
  rotateAbout(figure.head, UP, pose.yaw * 0.45);
}

function Seated({ figure }: { figure: Figure }) {
  const story = useStory();
  const smoothed = useRef({ yaw: 0 });

  useEffect(() => {
    applyPose(figure, {
      lean: 0.3,
      yaw: 0,
      nod: 0.14,
      slump: 0,
      slide: 0,
      typing: 0,
      away: 0,
      idle: 1,
      time: 0,
    });
  }, [figure]);

  useFrame(({ clock }, delta) => {
    const p = story.smooth;

    // Looks at whatever the camera is looking at: the book, then the pile.
    const wanted =
      0.5 * windowed(p, CUES.lookBook, CUES.lookBookEnd) -
      0.5 * windowed(p, CUES.lookNotes, CUES.lookReset);
    smoothed.current.yaw += (wanted - smoothed.current.yaw) * (1 - Math.exp(-delta * 5));

    // Sits easy: upright against the chair, leaning in a little once Cookie
    // Notes is on the screen — and, as the notes rise toward him, sitting back
    // with his hands off the keys, so they have the room.
    const away = smoothstep(CUES.sitBack[0], CUES.sitBack[1], p);
    // Once Cookie Notes is on the screen he eases back a touch instead of leaning in.
    const lean = lerp(
      0.3 - smoothstep(CUES.screenShelf[0], CUES.screenShelf[1], p) * 0.06,
      -SIT_BACK.recline,
      away,
    );

    // Light typing while the laptop is the thing being looked at — and again
    // once Cookie Notes is up, not before.
    const typing =
      windowed(p, [0.1, 0.18], [0.3, 0.36]) * 0.5 +
      smoothstep(CUES.screenShelf[1], CUES.screenShelf[1] + 0.04, p) * 0.6 * (1 - away);

    // Breathing and head sway, like the camera's drift, stand down while
    // "There's a simpler way." is on screen: the whole frame holds.
    const idle = 1 - windowed(p, CUES.driftOff[0], CUES.driftOff[1]);

    applyPose(figure, {
      lean,
      yaw: smoothed.current.yaw,
      nod: lerp(0.14, 0.3, away),
      slump: away * 0.08,
      slide: away * SIT_BACK.slide,
      typing,
      away,
      idle,
      time: clock.elapsedTime,
    });
  });

  return <primitive object={figure.scene} />;
}

export function Student({ onSettled }: { onSettled?: () => void }) {
  const { figure, failed } = useFigure();
  const settled = Boolean(figure) || failed;

  // Tells the scene the character is in place (or has been replaced by the
  // stand-in), so the room is not shown before the person at the desk.
  useEffect(() => {
    if (settled) onSettled?.();
  }, [settled, onSettled]);

  // If the model cannot load, the room still has someone at the desk.
  if (failed) return <ProceduralStudent />;
  if (!figure) return null;
  return <Seated figure={figure} />;
}
