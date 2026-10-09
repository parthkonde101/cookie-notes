'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CUES } from '@/components/home/cinematic/story-config';
import { smoothstep } from '@/components/home/cinematic/math';
import { useStory } from '@/components/home/cinematic/story-state';
import { RoundBox, SHADOWS } from '@/components/home/cinematic/scene/parts';
import {
  glareTexture,
  grilleTexture,
  keyboardTextures,
} from '@/components/home/cinematic/scene/desk-textures';
import {
  readerScreen,
  shelfScreen,
  slidesScreen,
  type PageSource,
} from '@/components/home/cinematic/scene/textures';

/**
 * The laptop: a thin aluminium notebook in the MacBook idiom — a unibody with
 * softened edges, a full keyboard with legends, a glass trackpad, speaker
 * grilles either side of the keys, a hairline hinge gap, ports on both sides,
 * and a display with slim bezels, a notch and a camera.
 *
 * It is scaled about the middle of its screen, so the screen stays where the
 * camera and the pages expect it and the keyboard comes toward the chair.
 */
const LAPTOP_SCALE = 0.9;
const LAPTOP_Z = 0.1605;
/** Where the middle of the laptop screen is, in the world — pages rise from here. */
export const SCREEN_CENTER = new THREE.Vector3(0, 0.19, -0.082);
export const LID_TILT = -0.32;

const ALUMINIUM = { color: '#d8d2c7', metalness: 0.85, roughness: 0.3 } as const;
const DARK = { color: '#161618', metalness: 0.2, roughness: 0.5 } as const;

/** A rounded-rectangle panel, for the display glass. */
function usePanel(w: number, h: number, r: number) {
  const geometry = useMemo(() => {
    const s = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    s.lineTo(x + w, y + h - r);
    s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    s.lineTo(x + r, y + h);
    s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(x, y + r);
    s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    const g = new THREE.ShapeGeometry(s, 8);
    // ShapeGeometry's UVs are in metres; the screens need them in 0–1.
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i += 1)
      uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
    return g;
  }, [w, h, r]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/** The notch: square at the top, rounded where it hangs into the display. */
function useNotch(w: number, h: number, r: number) {
  const geometry = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, h / 2);
    s.lineTo(-w / 2, -h / 2 + r);
    s.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, false);
    s.lineTo(w / 2 - r, -h / 2);
    s.absarc(w / 2 - r, -h / 2 + r, r, Math.PI * 1.5, Math.PI * 2, false);
    s.lineTo(w / 2, h / 2);
    s.closePath();
    return new THREE.ShapeGeometry(s, 6);
  }, [w, h, r]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

export function Laptop({ page }: { page: PageSource | null }) {
  const story = useStory();
  const slides = useMemo(() => slidesScreen(), []);
  const shelf = useMemo(() => shelfScreen(), []);
  const reader = useMemo(() => readerScreen(page ?? undefined), [page]);
  const keys = useMemo(() => keyboardTextures(), []);
  const grille = useMemo(() => grilleTexture(), []);
  const glare = useMemo(() => glareTexture(), []);
  useEffect(() => () => slides.dispose(), [slides]);
  useEffect(() => () => shelf.dispose(), [shelf]);
  useEffect(() => () => reader.dispose(), [reader]);
  useEffect(
    () => () => {
      keys.colour.dispose();
      keys.bump.dispose();
    },
    [keys],
  );
  useEffect(() => () => grille.dispose(), [grille]);
  useEffect(() => () => glare.dispose(), [glare]);

  const bezel = usePanel(0.63, 0.41, 0.012);
  const glass = usePanel(0.612, 0.3825, 0.006);
  const notch = useNotch(0.062, 0.0125, 0.005);

  const slidesMat = useRef<THREE.MeshBasicMaterial>(null);
  const shelfMat = useRef<THREE.MeshBasicMaterial>(null);
  const readerMat = useRef<THREE.MeshBasicMaterial>(null);
  const shelfPlane = useRef<THREE.Mesh>(null);
  const readerPlane = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const p = story.smooth;
    const toShelf = smoothstep(CUES.screenShelf[0], CUES.screenShelf[1], p);
    const toReader = smoothstep(CUES.screenReader[0], CUES.screenReader[1], p);
    if (slidesMat.current) slidesMat.current.opacity = 1 - toShelf;
    if (shelfMat.current) shelfMat.current.opacity = toShelf * (1 - toReader);
    if (readerMat.current) readerMat.current.opacity = toReader;
    if (shelfPlane.current) shelfPlane.current.visible = toShelf > 0.003 && toReader < 0.997;
    if (readerPlane.current) readerPlane.current.visible = toReader > 0.003;
  });

  return (
    <group position={[0, 0, LAPTOP_Z]} scale={LAPTOP_SCALE}>
      {/* Unibody base. */}
      <RoundBox size={[0.64, 0.022, 0.44]} radius={0.01} position={[0, 0.011, 0]}>
        <meshStandardMaterial {...ALUMINIUM} />
      </RoundBox>

      {/* Keyboard well: a dark surround, then the keys, standing a little proud of it. */}
      <RoundBox size={[0.586, 0.0012, 0.262]} radius={0.006} position={[0, 0.0221, -0.035]}>
        <meshStandardMaterial {...DARK} />
      </RoundBox>
      <mesh position={[0, 0.0229, -0.035]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.57, 0.2443]} />
        <meshStandardMaterial
          map={keys.colour}
          bumpMap={keys.bump}
          bumpScale={1.2}
          roughness={0.5}
          metalness={0.1}
        />
      </mesh>

      {/* Speaker grilles either side of the keys. */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.3085, 0.0223, -0.035]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.019, 0.25]} />
          <meshStandardMaterial map={grille} transparent depthWrite={false} roughness={0.8} />
        </mesh>
      ))}

      {/* Glass trackpad: a faint border, a slightly darker pane. */}
      <RoundBox size={[0.216, 0.0006, 0.131]} radius={0.004} position={[0, 0.0222, 0.143]}>
        <meshStandardMaterial color="#a39d92" metalness={0.5} roughness={0.5} />
      </RoundBox>
      <RoundBox size={[0.21, 0.0009, 0.125]} radius={0.004} position={[0, 0.0224, 0.143]}>
        <meshStandardMaterial color="#c9c3b8" metalness={0.35} roughness={0.22} />
      </RoundBox>

      {/* Ports: two on the left, a charging port and a headphone jack on the right. */}
      {[-0.02, -0.052].map((z) => (
        <RoundBox
          key={z}
          size={[0.0024, 0.0042, 0.0135]}
          radius={0.0012}
          position={[-0.3195, 0.011, z]}
        >
          <meshStandardMaterial color="#0b0b0c" roughness={0.6} />
        </RoundBox>
      ))}
      <RoundBox size={[0.0024, 0.0034, 0.011]} radius={0.001} position={[0.3195, 0.011, -0.02]}>
        <meshStandardMaterial color="#0b0b0c" roughness={0.6} />
      </RoundBox>
      <mesh position={[0.3202, 0.011, -0.05]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.0017, 0.0017, 0.0016, 12]} />
        <meshStandardMaterial color="#0b0b0c" roughness={0.6} />
      </mesh>

      {/* The hinge: a dark seam where lid meets base. */}
      <mesh position={[0, 0.0215, -0.2145]} rotation={[0, 0, Math.PI / 2]} {...SHADOWS}>
        <cylinderGeometry args={[0.0062, 0.0062, 0.5, 14]} />
        <meshStandardMaterial color="#26262a" metalness={0.6} roughness={0.4} />
      </mesh>

      {/* Lid and screen. */}
      <group position={[0, 0.0125, -0.21]} rotation={[LID_TILT, 0, 0]}>
        <RoundBox size={[0.64, 0.42, 0.01]} radius={0.0045} position={[0, 0.21, 0]}>
          <meshStandardMaterial {...ALUMINIUM} />
        </RoundBox>
        {/* Bezel and glass. */}
        <mesh geometry={bezel} position={[0, 0.21, 0.0052]}>
          <meshBasicMaterial color="#060607" toneMapped={false} />
        </mesh>
        <mesh geometry={glass} position={[0, 0.2075, 0.0056]}>
          <meshBasicMaterial color="#0b0b0d" toneMapped={false} />
        </mesh>
        <mesh geometry={glass} position={[0, 0.2075, 0.006]}>
          <meshBasicMaterial
            ref={slidesMat}
            map={slides}
            transparent
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh ref={shelfPlane} geometry={glass} position={[0, 0.2075, 0.0063]}>
          <meshBasicMaterial
            ref={shelfMat}
            map={shelf}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh ref={readerPlane} geometry={glass} position={[0, 0.2075, 0.0066]}>
          <meshBasicMaterial
            ref={readerMat}
            map={reader}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        {/* Notch and camera, over the picture. */}
        <mesh geometry={notch} position={[0, 0.3975, 0.0069]}>
          <meshBasicMaterial color="#050506" toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.3935, 0.0071]}>
          <circleGeometry args={[0.0021, 14]} />
          <meshBasicMaterial color="#10182a" toneMapped={false} />
        </mesh>
        <mesh position={[0.016, 0.3935, 0.0071]}>
          <circleGeometry args={[0.0009, 10]} />
          <meshBasicMaterial color="#1c4a2a" toneMapped={false} />
        </mesh>
        {/* A faint glare across the glass. */}
        <mesh position={[0, 0.2075, 0.0072]}>
          <planeGeometry args={[0.612, 0.3825]} />
          <meshBasicMaterial
            map={glare}
            transparent
            opacity={0.1}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* The screen's glow on the keys and the student's hands. */}
      <pointLight
        position={[0, 0.3, 0.35]}
        color="#e8ecff"
        intensity={0.08}
        distance={1.2}
        decay={2}
      />
    </group>
  );
}
