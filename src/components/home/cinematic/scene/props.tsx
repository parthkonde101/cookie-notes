'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CUES, LIGHT, SIT_BACK } from '@/components/home/cinematic/story-config';
import { lerp, smoothstep } from '@/components/home/cinematic/math';
import { useStory } from '@/components/home/cinematic/story-state';
import { Limb, RoundBox, SHADOWS } from '@/components/home/cinematic/scene/parts';
import { wallTexture, woodTexture } from '@/components/home/cinematic/scene/textures';

/** The static furniture. The student, the laptop, the book and the clutter live in their own files. */

/** Where the student's hips are on the seat; the chair is built around it. */
const SEAT_Z = 0.66;

/* ------------------------------------------------------------------ */
/* Room                                                                */
/* ------------------------------------------------------------------ */

const SHELF_BOOKS: [number, number, string][] = [
  [0.05, 0.26, '#4a2c24'],
  [0.07, 0.3, '#2c3a3e'],
  [0.04, 0.24, '#6a5434'],
  [0.06, 0.28, '#3a2c3c'],
  [0.05, 0.22, '#55402a'],
  [0.07, 0.3, '#28323a'],
  [0.05, 0.26, '#5a3a2c'],
];

export function Room() {
  const wall = useMemo(() => wallTexture(), []);
  useEffect(() => () => wall.dispose(), [wall]);

  return (
    <>
      {/* Floor and a rug under the chair. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.75, 0]} receiveShadow>
        <circleGeometry args={[8, 64]} />
        <meshStandardMaterial color="#1c1611" roughness={0.9} />
      </mesh>
      <mesh position={[0, -0.742, 0.55]} receiveShadow>
        <cylinderGeometry args={[1.35, 1.35, 0.012, 48]} />
        <meshStandardMaterial color="#3a2b21" roughness={1} />
      </mesh>

      {/* The wall, with a shelf of books in the dim — depth, not content. */}
      <mesh position={[0, 1.6, -2.5]} receiveShadow>
        <planeGeometry args={[16, 6.5]} />
        <meshStandardMaterial map={wall} roughness={1} />
      </mesh>
      <group position={[-1.9, 0.95, -2.38]}>
        <RoundBox size={[1.5, 0.035, 0.26]} radius={0.01} position={[0, 0, 0]}>
          <meshStandardMaterial color="#3a2a1d" roughness={0.8} />
        </RoundBox>
        {SHELF_BOOKS.map(([w, h, color], i) => (
          <RoundBox
            key={i}
            size={[w, h, 0.2]}
            radius={0.005}
            position={[
              -0.62 + SHELF_BOOKS.slice(0, i).reduce((x, [bw]) => x + bw + 0.012, 0),
              0.018 + h / 2,
              0,
            ]}
          >
            <meshStandardMaterial color={color} roughness={0.85} />
          </RoundBox>
        ))}
      </group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Desk and chair                                                      */
/* ------------------------------------------------------------------ */

export function Desk() {
  const wood = useMemo(() => {
    const t = woodTexture();
    t.repeat.set(2.4, 1);
    return t;
  }, []);
  useEffect(() => () => wood.dispose(), [wood]);

  const timber = <meshStandardMaterial color="#5e3b24" roughness={0.7} />;

  return (
    <group>
      <RoundBox size={[3.1, 0.06, 1.285]} radius={0.02} position={[0, -0.03, -0.0825]}>
        <meshStandardMaterial
          map={wood}
          bumpMap={wood}
          bumpScale={0.6}
          roughness={0.5}
          metalness={0.02}
        />
      </RoundBox>
      {/* Left legs. */}
      {([-1.42, -1.42] as number[]).map((x, i) => (
        <RoundBox
          key={i}
          size={[0.07, 0.69, 0.07]}
          radius={0.015}
          position={[x, -0.405, i === 0 ? -0.62 : 0.48]}
        >
          {timber}
        </RoundBox>
      ))}
      {/* A drawer pedestal on the right. */}
      <RoundBox size={[0.52, 0.64, 1.06]} radius={0.015} position={[1.2, -0.38, -0.09]}>
        {timber}
      </RoundBox>
      {[0, 1].map((i) => (
        <group key={i} position={[1.2, -0.2 - i * 0.26, 0.45]}>
          <RoundBox size={[0.44, 0.22, 0.015]} radius={0.008}>
            <meshStandardMaterial color="#6a4429" roughness={0.65} />
          </RoundBox>
          <mesh position={[0, 0, 0.016]} rotation={[0, 0, Math.PI / 2]} {...SHADOWS}>
            <capsuleGeometry args={[0.006, 0.1, 4, 8]} />
            <meshStandardMaterial color="#c9a15a" metalness={0.8} roughness={0.35} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function Chair() {
  const story = useStory();
  const root = useRef<THREE.Group>(null);
  const back = useRef<THREE.Group>(null);
  useFrame(() => {
    const away = smoothstep(CUES.sitBack[0], CUES.sitBack[1], story.smooth);
    if (back.current) back.current.rotation.x = lerp(0.04, SIT_BACK.recline, away);
    // He sits back and the chair rolls back with him.
    if (root.current) root.current.position.z = away * SIT_BACK.slide;
  });

  const fabric = <meshStandardMaterial color="#56665a" roughness={0.95} />;
  const metal = <meshStandardMaterial color="#1d1b1a" metalness={0.6} roughness={0.4} />;

  return (
    <group ref={root}>
      {/* Seat and a curved back. */}
      <RoundBox size={[0.58, 0.09, 0.56]} radius={0.04} position={[0, -0.357, SEAT_Z]}>
        {fabric}
      </RoundBox>
      {/* The back reclines about the rear of the seat as the student sits back. */}
      <group ref={back} position={[0, -0.32, SEAT_Z + 0.26]}>
        <RoundBox size={[0.52, 0.46, 0.08]} radius={0.045} position={[0, 0.27, 0]}>
          {fabric}
        </RoundBox>
      </group>
      {/* Arms. */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <RoundBox
            size={[0.05, 0.03, 0.34]}
            radius={0.012}
            position={[s * 0.33, -0.15, SEAT_Z + 0.02]}
          >
            {metal}
          </RoundBox>
          <mesh position={[s * 0.33, -0.24, SEAT_Z + 0.09]} {...SHADOWS}>
            <cylinderGeometry args={[0.014, 0.014, 0.18, 10]} />
            {metal}
          </mesh>
        </group>
      ))}
      {/* Gas lift and a five-star base on castors. */}
      <mesh position={[0, -0.57, SEAT_Z]} {...SHADOWS}>
        <cylinderGeometry args={[0.032, 0.036, 0.32, 14]} />
        {metal}
      </mesh>
      {[0, 1, 2, 3, 4].map((i) => (
        <group
          key={i}
          position={[0, -0.72, SEAT_Z]}
          rotation={[0, -((i / 5) * Math.PI * 2 + 0.3), 0]}
        >
          <RoundBox size={[0.27, 0.03, 0.045]} radius={0.012} position={[0.135, 0, 0]}>
            {metal}
          </RoundBox>
          <mesh position={[0.26, -0.025, 0]} {...SHADOWS}>
            <sphereGeometry args={[0.028, 12, 10]} />
            <meshStandardMaterial color="#111" roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Lamp                                                                */
/* ------------------------------------------------------------------ */

/** The one real light source in the room. Its warmth and strength follow the story. */
export function Lamp({ shadows }: { shadows: boolean }) {
  const story = useStory();
  const spot = useRef<THREE.SpotLight>(null);
  const fill = useRef<THREE.PointLight>(null);

  const shade = useMemo(() => {
    // A domed metal shade, open at the bottom: a short lathe.
    const profile = [
      [0.04, 0.0],
      [0.06, 0.03],
      [0.1, 0.07],
      [0.145, 0.12],
      [0.16, 0.14],
    ].map(([r, y]) => new THREE.Vector2(r, -y));
    return new THREE.LatheGeometry(profile, 36);
  }, []);
  useEffect(() => () => shade.dispose(), [shade]);

  useFrame(() => {
    const clarity = smoothstep(CUES.clarity[0], CUES.clarity[1], story.smooth);
    if (spot.current) spot.current.intensity = lerp(LIGHT.lamp[0], LIGHT.lamp[1], clarity);
    if (fill.current) fill.current.intensity = lerp(0.65, 0.9, clarity);
  });

  return (
    <group position={[-1.25, 0, -0.45]}>
      <mesh position={[0, 0.016, 0]} {...SHADOWS}>
        <cylinderGeometry args={[0.12, 0.135, 0.032, 32]} />
        <meshStandardMaterial color="#26221f" metalness={0.55} roughness={0.45} />
      </mesh>
      <Limb
        from={[0, 0.02, 0]}
        to={[0.1, 0.55, 0.05]}
        r0={0.011}
        color="#2c2825"
        roughness={0.45}
        metalness={0.5}
      />
      <Limb
        from={[0.1, 0.55, 0.05]}
        to={[0.42, 0.74, 0.22]}
        r0={0.011}
        color="#2c2825"
        roughness={0.45}
        metalness={0.5}
      />
      <mesh position={[0.1, 0.55, 0.05]} {...SHADOWS}>
        <sphereGeometry args={[0.022, 14, 12]} />
        <meshStandardMaterial color="#c9a15a" metalness={0.8} roughness={0.35} />
      </mesh>
      <group position={[0.42, 0.74, 0.22]} rotation={[0.42, 0, -0.55]}>
        <mesh geometry={shade} {...SHADOWS}>
          <meshStandardMaterial
            color="#c9a15a"
            metalness={0.7}
            roughness={0.32}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* The warm inside of the shade, and the bulb. */}
        <mesh position={[0, -0.075, 0]} rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[0.15, 0.13, 32, 1, true]} />
          <meshBasicMaterial color="#ffcf94" toneMapped={false} side={THREE.BackSide} />
        </mesh>
        <mesh position={[0, -0.11, 0]}>
          <sphereGeometry args={[0.03, 14, 12]} />
          <meshBasicMaterial color="#ffe3bd" toneMapped={false} />
        </mesh>
        <spotLight
          ref={spot}
          position={[0, -0.12, 0]}
          color="#ffb877"
          intensity={LIGHT.lamp[0]}
          angle={0.95}
          penumbra={0.85}
          distance={5}
          decay={2}
          castShadow={shadows}
          shadow-mapSize={[1024, 1024]}
          shadow-bias={-0.0005}
          shadow-normalBias={0.02}
        />
        <pointLight
          ref={fill}
          position={[0, -0.15, 0]}
          color="#ffbf85"
          intensity={0.65}
          distance={3.5}
          decay={2}
        />
      </group>
    </group>
  );
}

/* The mug, the plant and the laptop are built in their own files. */
export { Keepsakes } from '@/components/home/cinematic/scene/keepsakes';
export { Laptop, LID_TILT, SCREEN_CENTER } from '@/components/home/cinematic/scene/macbook';
