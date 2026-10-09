'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CUES } from '@/components/home/cinematic/story-config';
import { windowed } from '@/components/home/cinematic/math';
import { useStory } from '@/components/home/cinematic/story-state';
import { SHADOWS } from '@/components/home/cinematic/scene/parts';
import { steamTexture } from '@/components/home/cinematic/scene/desk-textures';

/**
 * What stays on the desk once it is clear: a mug of coffee on a cork coaster,
 * and a small cactus-like plant in a terracotta pot. The mug is turned on a
 * lathe and has a real handle and a coffee surface.
 */

const lathe = (profile: [number, number][], segments = 48) =>
  new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );

/* ------------------------------------------------------------------ */
/* The mug                                                             */
/* ------------------------------------------------------------------ */

const MUG_PROFILE: [number, number][] = [
  [0.0, 0.0],
  [0.034, 0.0],
  [0.0395, 0.004],
  [0.0425, 0.016],
  [0.0452, 0.055],
  [0.0462, 0.094],
  [0.0452, 0.1],
  [0.0418, 0.1],
  [0.0405, 0.094],
  [0.0398, 0.02],
  [0.034, 0.008],
  [0.0, 0.008],
];

function Mug() {
  const story = useStory();
  const body = useMemo(() => lathe(MUG_PROFILE, 56), []);
  const handle = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.0445, 0.086, 0),
      new THREE.Vector3(0.066, 0.089, 0),
      new THREE.Vector3(0.0815, 0.066, 0),
      new THREE.Vector3(0.0705, 0.04, 0),
      new THREE.Vector3(0.0435, 0.031, 0),
    ]);
    return new THREE.TubeGeometry(curve, 28, 0.0068, 10, false);
  }, []);
  const steam = useMemo(() => steamTexture(), []);
  useEffect(
    () => () => {
      body.dispose();
      handle.dispose();
      steam.dispose();
    },
    [body, handle, steam],
  );

  const puffs = useRef<(THREE.Sprite | null)[]>([]);
  const clock = useRef(0);
  useFrame((_, delta) => {
    // Steam drifts up and thins out; it slows to almost nothing while the scene holds still.
    const calm = windowed(story.smooth, CUES.driftOff[0], CUES.driftOff[1]);
    clock.current += delta * (1 - calm * 0.85);
    puffs.current.forEach((puff, i) => {
      if (!puff) return;
      const t = (clock.current * 0.22 + i / 4) % 1;
      puff.position.set(
        Math.sin(t * 6 + i) * 0.008,
        0.1 + t * 0.12,
        Math.cos(t * 5 + i * 2) * 0.006,
      );
      const s = 0.03 + t * 0.05;
      puff.scale.set(s, s * 2, 1);
      (puff.material as THREE.SpriteMaterial).opacity = Math.sin(t * Math.PI) * 0.16;
    });
  });

  return (
    <group position={[0.62, 0, -0.12]} rotation={[0, 0.5, 0]}>
      {/* Cork coaster. */}
      <mesh position={[0, 0.003, 0]} {...SHADOWS}>
        <cylinderGeometry args={[0.058, 0.058, 0.006, 40]} />
        <meshStandardMaterial color="#b08a5c" roughness={0.95} />
      </mesh>
      <group position={[0, 0.006, 0]}>
        <mesh geometry={body} {...SHADOWS}>
          <meshPhysicalMaterial
            color="#efe6d6"
            roughness={0.28}
            clearcoat={0.7}
            clearcoatRoughness={0.18}
          />
        </mesh>
        {/* A caramel band near the rim. */}
        <mesh position={[0, 0.078, 0]}>
          <cylinderGeometry args={[0.0472, 0.0472, 0.009, 56, 1, true]} />
          <meshStandardMaterial color="#d29f60" roughness={0.4} side={THREE.DoubleSide} />
        </mesh>
        <mesh geometry={handle} {...SHADOWS}>
          <meshPhysicalMaterial
            color="#efe6d6"
            roughness={0.28}
            clearcoat={0.7}
            clearcoatRoughness={0.18}
          />
        </mesh>
        {/* Coffee, with a lighter ring of crema. */}
        <mesh position={[0, 0.084, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.0402, 40]} />
          <meshStandardMaterial color="#2e1b10" roughness={0.12} metalness={0.05} />
        </mesh>
        <mesh position={[0, 0.0842, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.026, 0.0385, 40]} />
          <meshStandardMaterial
            color="#6a4528"
            roughness={0.3}
            transparent
            opacity={0.55}
            depthWrite={false}
          />
        </mesh>
        {[0, 1, 2, 3].map((i) => (
          <sprite
            key={i}
            ref={(el) => {
              puffs.current[i] = el;
            }}
          >
            <spriteMaterial
              map={steam}
              transparent
              opacity={0}
              depthWrite={false}
              color="#f4efe6"
            />
          </sprite>
        ))}
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* The plant                                                           */
/* ------------------------------------------------------------------ */

/** A small cactus-like plant in a terracotta pot: a cluster of thick, rounded leaves. */
function Plant() {
  return (
    <group position={[-0.62, 0, -0.4]}>
      <mesh position={[0, 0.05, 0]} {...SHADOWS}>
        <cylinderGeometry args={[0.055, 0.04, 0.1, 22]} />
        <meshStandardMaterial color="#b8714a" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.098, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.05, 18]} />
        <meshStandardMaterial color="#2f2218" roughness={1} />
      </mesh>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <mesh
          key={i}
          position={[Math.cos(i * 0.9) * 0.032, 0.15 + (i % 3) * 0.022, Math.sin(i * 0.9) * 0.032]}
          rotation={[Math.sin(i * 1.3) * 0.5, i * 0.9, Math.cos(i * 0.9) * 0.55]}
          scale={[0.55, 1, 0.3]}
          {...SHADOWS}
        >
          <sphereGeometry args={[0.04, 14, 10]} />
          <meshStandardMaterial color={i % 2 ? '#5f8a55' : '#6c9a5f'} roughness={0.75} />
        </mesh>
      ))}
    </group>
  );
}

export function Keepsakes() {
  return (
    <group>
      <Mug />
      <Plant />
    </group>
  );
}
