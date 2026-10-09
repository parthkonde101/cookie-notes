'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { ThreeElements } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Vec3 } from '@/components/home/cinematic/story-config';
import { smoothstep } from '@/components/home/cinematic/math';
import { useStory } from '@/components/home/cinematic/story-state';

/** Small building blocks shared by every object in the room. */

export const SHADOWS = { castShadow: true, receiveShadow: true } as const;

type MeshProps = ThreeElements['mesh'];

/** A box with softened edges — nothing in a room is a perfect cuboid. */
export function RoundBox({
  size,
  radius = 0.01,
  children,
  ...mesh
}: { size: Vec3; radius?: number } & MeshProps) {
  const [w, h, d] = size;
  const geometry = useMemo(() => new RoundedBoxGeometry(w, h, d, 4, radius), [w, h, d, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} {...SHADOWS} {...mesh}>
      {children}
    </mesh>
  );
}

/**
 * A rounded tube between two points, thicker at one end — an arm, a leg, a lamp
 * arm. `r0` is the radius at `from`, `r1` at `to`.
 */
export function Limb({
  from,
  to,
  r0,
  r1 = r0,
  color,
  roughness = 0.85,
  metalness = 0,
}: {
  from: Vec3;
  to: Vec3;
  r0: number;
  r1?: number;
  color: string;
  roughness?: number;
  metalness?: number;
}) {
  const { position, quaternion, length } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.normalize(),
    );
    return { position: a.clone().add(b).multiplyScalar(0.5), quaternion: q, length: len };
  }, [from, to]);

  return (
    <group position={position} quaternion={quaternion}>
      {/* Cylinder: top radius first. Local +y points from `from` toward `to`. */}
      <mesh {...SHADOWS}>
        <cylinderGeometry args={[r1, r0, length, 20, 1]} />
        <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
      </mesh>
      <mesh position={[0, -length / 2, 0]} {...SHADOWS}>
        <sphereGeometry args={[r0, 18, 14]} />
        <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
      </mesh>
      <mesh position={[0, length / 2, 0]} {...SHADOWS}>
        <sphereGeometry args={[r1, 18, 14]} />
        <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
      </mesh>
    </group>
  );
}

/**
 * Wraps part of the scene so it can arrive and leave on the scroll: it grows
 * in (dropping from slightly above, settling with a small turn) across
 * `appear`, and shrinks away across `vanish`. Outside those windows it costs
 * nothing.
 */
export function Pop({
  children,
  position,
  rotation,
  appear,
  vanish,
  drop = 0.18,
  turn = 0,
  rise = 0,
  tilt = 0,
}: {
  children: React.ReactNode;
  position: Vec3;
  rotation?: Vec3;
  appear?: readonly [number, number];
  vanish?: readonly [number, number];
  drop?: number;
  /** Radians the piece is still rotated by when it begins to arrive. */
  turn?: number;
  /** How far the piece lifts as it leaves. It never turns on the way out. */
  rise?: number;
  /** Radians it is still tipped by when it begins to arrive; it settles flat. */
  tilt?: number;
}) {
  const ref = useRef<THREE.Group>(null);
  const story = useStory();
  const baseRotationY = rotation?.[1] ?? 0;

  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const p = story.smooth;
    const a = appear ? smoothstep(appear[0], appear[1], p) : 1;
    const gone = vanish ? smoothstep(vanish[0], vanish[1], p) : 0;
    const v = a * (1 - gone);
    g.visible = v > 0.003;
    g.scale.setScalar(Math.max(v, 0.0001));
    g.position.y = position[1] + (1 - a) * drop + gone * rise;
    g.rotation.y = baseRotationY + (1 - a) * turn;
    g.rotation.x = (1 - a) * tilt;
    g.rotation.z = (1 - a) * tilt * -0.6;
  });

  return (
    <group ref={ref} position={position} rotation={rotation}>
      {children}
    </group>
  );
}
