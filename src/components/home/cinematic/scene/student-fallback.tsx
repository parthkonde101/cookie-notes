'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CUES } from '@/components/home/cinematic/story-config';
import { lerp, smoothstep, windowed } from '@/components/home/cinematic/math';
import { useStory } from '@/components/home/cinematic/story-state';
import { Limb, RoundBox, SHADOWS } from '@/components/home/cinematic/scene/parts';

/**
 * A college student, in a hoodie, leaning in toward a laptop.
 *
 * Stylised, not realistic: soft forms, no fine detail the camera never gets
 * close to. What it does have is the right proportions, a seated posture that
 * makes sense (hips on the seat, thighs under the desk, forearms reaching the
 * keyboard, head tipped toward the screen) and a face worth seeing from the
 * side in the last frame.
 */

const HOODIE = '#d8c6a5';
const HOODIE_SHADE = '#bfa985';
const SKIN = '#c58e69';
const SKIN_SHADE = '#b57d59';
const HAIR = '#241a14';
const PANTS = '#2b2c34';
const SOLE = '#f3eee3';
const SHOE = '#d9d2c4';

/** Where the student's hips are on the seat. Everything is placed from here. */
const HIPS_Z = 1.02;

/** The hoodie torso, turned on a lathe: waist, belly, chest, shoulders. */
function useTorsoGeometry() {
  const geometry = useMemo(() => {
    const profile = [
      [0.0, 0.0],
      [0.15, 0.0],
      [0.164, 0.07],
      [0.172, 0.18],
      [0.184, 0.32],
      [0.172, 0.42],
      [0.11, 0.49],
      [0.0, 0.51],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    return new THREE.LatheGeometry(profile, 32);
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

export function ProceduralStudent() {
  const story = useStory();
  const torsoGeometry = useTorsoGeometry();
  const torso = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const fingers = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const p = story.smooth;
    const t = clock.elapsedTime;

    // Looks at whatever the camera is looking at: the book, then the pile.
    const yaw =
      0.5 * windowed(p, CUES.lookBook, CUES.lookBookEnd) -
      0.5 * windowed(p, CUES.lookNotes, CUES.lookReset);
    // Leans a little closer once Cookie Notes is on the screen.
    const lean = smoothstep(CUES.screenShelf[0], CUES.screenShelf[1], p);
    // Breathing and head sway, like the camera's drift, stand down while
    // "There's a simpler way." is on screen: the whole frame holds.
    const idle = 1 - windowed(p, CUES.driftOff[0], CUES.driftOff[1]);

    if (head.current) {
      head.current.rotation.y = lerp(head.current.rotation.y, yaw, 0.08);
      head.current.rotation.x = 0.2 + lean * 0.04 + Math.sin(t * 0.7) * 0.01 * idle;
    }
    if (torso.current) {
      torso.current.rotation.y = lerp(torso.current.rotation.y, yaw * 0.22, 0.06);
      torso.current.rotation.x = -0.14 - lean * 0.04;
      torso.current.scale.set(1.12, 1 + Math.sin(t * 1.15) * 0.006 * idle, 0.78);
    }

    // Light typing while the laptop is the thing being looked at — and again
    // once Cookie Notes is up, not before.
    const typing =
      windowed(p, [0.1, 0.18], [0.3, 0.36]) * 0.5 +
      smoothstep(CUES.screenShelf[1], CUES.screenShelf[1] + 0.04, p) * 0.6;
    fingers.current.forEach((finger, i) => {
      if (finger) finger.rotation.x = -0.1 + Math.sin(t * 8 + i * 1.7) * 0.12 * typing;
    });
  });

  return (
    <group>
      {/* Legs: thighs under the desk, shins down to the floor. */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <Limb from={[s * 0.1, -0.2, HIPS_Z]} to={[s * 0.12, -0.2, 0.52]} r0={0.085} r1={0.07} color={PANTS} roughness={0.95} />
          <Limb from={[s * 0.12, -0.2, 0.52]} to={[s * 0.12, -0.67, 0.58]} r0={0.065} r1={0.05} color={PANTS} roughness={0.95} />
          {/* Sneaker: sole and upper. */}
          <RoundBox size={[0.105, 0.03, 0.27]} radius={0.012} position={[s * 0.12, -0.725, 0.5]}>
            <meshStandardMaterial color={SOLE} roughness={0.7} />
          </RoundBox>
          <RoundBox size={[0.095, 0.06, 0.2]} radius={0.025} position={[s * 0.12, -0.685, 0.53]}>
            <meshStandardMaterial color={SHOE} roughness={0.8} />
          </RoundBox>
        </group>
      ))}

      {/* Hips. */}
      <mesh position={[0, -0.2, HIPS_Z]} scale={[1.2, 0.8, 1]} {...SHADOWS}>
        <sphereGeometry args={[0.16, 24, 18]} />
        <meshStandardMaterial color={PANTS} roughness={0.95} />
      </mesh>

      {/* Torso, leaning toward the desk. */}
      <group ref={torso} position={[0, -0.12, HIPS_Z]} rotation={[-0.14, 0, 0]} scale={[1.12, 1, 0.78]}>
        <mesh geometry={torsoGeometry} {...SHADOWS}>
          <meshStandardMaterial color={HOODIE} roughness={0.92} />
        </mesh>
        {/* The hem and the hood bunched behind the neck. */}
        <mesh position={[0, 0.012, 0]} rotation={[Math.PI / 2, 0, 0]} {...SHADOWS}>
          <torusGeometry args={[0.155, 0.022, 10, 32]} />
          <meshStandardMaterial color={HOODIE_SHADE} roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.5, 0.075]} rotation={[1.15, 0, 0]} {...SHADOWS}>
          <torusGeometry args={[0.1, 0.045, 14, 28]} />
          <meshStandardMaterial color={HOODIE_SHADE} roughness={0.95} />
        </mesh>
      </group>

      {/* Neck. */}
      <mesh position={[0, 0.43, 0.94]} rotation={[0.18, 0, 0]} {...SHADOWS}>
        <cylinderGeometry args={[0.046, 0.052, 0.12, 16]} />
        <meshStandardMaterial color={SKIN_SHADE} roughness={0.8} />
      </mesh>

      {/* Arms: shoulder → elbow → wrist, and hands resting on the keys. */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <Limb from={[s * 0.205, 0.335, 0.96]} to={[s * 0.265, 0.08, 0.8]} r0={0.066} r1={0.056} color={HOODIE} roughness={0.92} />
          <Limb from={[s * 0.265, 0.08, 0.8]} to={[s * 0.145, 0.055, 0.4]} r0={0.056} r1={0.042} color={HOODIE} roughness={0.92} />
          {/* The cuff. */}
          <mesh position={[s * 0.15, 0.056, 0.42]} rotation={[Math.PI / 2 - 0.05, 0, s * 0.3]} {...SHADOWS}>
            <torusGeometry args={[0.042, 0.014, 10, 20]} />
            <meshStandardMaterial color={HOODIE_SHADE} roughness={0.95} />
          </mesh>
          {/* Hand: a flattened palm and four fingers. */}
          <group position={[s * 0.135, 0.046, 0.35]} rotation={[0, s * -0.1, 0]}>
            <mesh scale={[1.25, 0.55, 1.5]} {...SHADOWS}>
              <sphereGeometry args={[0.034, 16, 12]} />
              <meshStandardMaterial color={SKIN} roughness={0.8} />
            </mesh>
            {[0, 1, 2, 3].map((i) => (
              <mesh
                key={i}
                ref={(el) => {
                  fingers.current[(s > 0 ? 4 : 0) + i] = el;
                }}
                position={[(i - 1.5) * 0.016, -0.004, -0.05]}
                rotation={[Math.PI / 2 - 0.1, 0, 0]}
                {...SHADOWS}
              >
                <capsuleGeometry args={[0.0075, 0.04, 4, 8]} />
                <meshStandardMaterial color={SKIN} roughness={0.8} />
              </mesh>
            ))}
          </group>
        </group>
      ))}

      {/* Head, tipped toward the screen. */}
      <group ref={head} position={[0, 0.635, 0.9]} rotation={[0.2, 0, 0]}>
        <mesh scale={[0.95, 1.06, 1]} {...SHADOWS}>
          <sphereGeometry args={[0.112, 32, 24]} />
          <meshStandardMaterial color={SKIN} roughness={0.78} />
        </mesh>
        {/* Jaw and chin. */}
        <mesh position={[0, -0.07, -0.03]} scale={[0.95, 0.75, 0.95]} {...SHADOWS}>
          <sphereGeometry args={[0.08, 24, 18]} />
          <meshStandardMaterial color={SKIN} roughness={0.78} />
        </mesh>
        {/* Nose, eyes, brows. */}
        <mesh position={[0, -0.018, -0.112]} scale={[0.9, 1.2, 1.4]} {...SHADOWS}>
          <sphereGeometry args={[0.016, 12, 10]} />
          <meshStandardMaterial color={SKIN_SHADE} roughness={0.8} />
        </mesh>
        {[-1, 1].map((s) => (
          <group key={s}>
            <mesh position={[s * 0.038, 0.012, -0.102]} scale={[1, 1.2, 0.6]}>
              <sphereGeometry args={[0.0085, 10, 8]} />
              <meshStandardMaterial color="#1b1411" roughness={0.4} />
            </mesh>
            <mesh position={[s * 0.04, 0.036, -0.104]} rotation={[0, 0, s * -0.12 + Math.PI / 2]}>
              <capsuleGeometry args={[0.004, 0.026, 3, 6]} />
              <meshStandardMaterial color={HAIR} roughness={0.9} />
            </mesh>
            {/* Ear. */}
            <mesh position={[s * 0.108, -0.008, 0.002]} scale={[0.5, 1, 0.8]} {...SHADOWS}>
              <sphereGeometry args={[0.024, 12, 10]} />
              <meshStandardMaterial color={SKIN_SHADE} roughness={0.8} />
            </mesh>
            {/* Sideburn. */}
            <mesh position={[s * 0.099, 0.012, -0.03]} scale={[0.5, 1.3, 0.7]} {...SHADOWS}>
              <sphereGeometry args={[0.02, 10, 8]} />
              <meshStandardMaterial color={HAIR} roughness={0.95} />
            </mesh>
          </group>
        ))}
        {/* Hair: a cap over the top and back, a fringe, and the nape. */}
        <mesh position={[0, 0.014, 0.014]} rotation={[0.42, 0, 0]} {...SHADOWS}>
          <sphereGeometry args={[0.122, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.6]} />
          <meshStandardMaterial color={HAIR} roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.082, -0.088]} rotation={[0.2, 0, 0]} scale={[1.55, 0.5, 0.65]} {...SHADOWS}>
          <sphereGeometry args={[0.055, 16, 12]} />
          <meshStandardMaterial color={HAIR} roughness={0.9} />
        </mesh>
        <mesh position={[0, -0.055, 0.075]} scale={[1.05, 0.8, 0.7]} {...SHADOWS}>
          <sphereGeometry args={[0.085, 18, 14]} />
          <meshStandardMaterial color={HAIR} roughness={0.95} />
        </mesh>
      </group>
    </group>
  );
}
