'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  CUES,
  LIGHT,
  NOTE_PAGES,
  PAGES_PRELOAD_AT,
  PALETTE,
  SHOTS,
} from '@/components/home/cinematic/story-config';
import { lerp, smoothstep, windowed } from '@/components/home/cinematic/math';
import {
  StoryContext,
  useStory,
  type StoryState,
} from '@/components/home/cinematic/story-state';
import { sampleCamera } from '@/components/home/cinematic/scene/camera';
import {
  Chair,
  Desk,
  Keepsakes,
  Lamp,
  Laptop,
  Room,
} from '@/components/home/cinematic/scene/props';
import { Student } from '@/components/home/cinematic/scene/student';
import { Book, Clutter, NotePages } from '@/components/home/cinematic/scene/study-items';
import type { PageSource } from '@/components/home/cinematic/scene/textures';

/** The longest the room waits for the character before it is shown without them. */
const STUDENT_WAIT_MS = 8000;

const HERO_INDEX = Math.max(
  0,
  NOTE_PAGES.findIndex((n) => n.hero),
);

/** Moves the camera along the story's path. Nothing else in the scene touches it. */
function Rig() {
  const story = useStory();
  const { camera, size } = useThree();
  const position = useMemo(() => new THREE.Vector3(), []);
  const aim = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }) => {
    const shot = sampleCamera(story.smooth);
    position.copy(shot.position);

    // A narrow screen sees less of the scene sideways, so stand further back,
    // and aim at the subject itself. The words sit across the top there, so
    // the subject is carried down the frame by the shot's `lift` — aiming
    // higher than the subject moves it lower on screen.
    const aspect = size.width / Math.max(1, size.height);
    const narrow = aspect < 1.15;
    aim.copy(narrow ? shot.focus : shot.target);
    if (narrow) {
      const k = Math.min(1.9, 1 + (1.15 - aspect) * 0.9) * shot.fit;
      position.sub(aim).multiplyScalar(k).add(aim);
      const halfHeight = position.distanceTo(aim) * Math.tan(THREE.MathUtils.degToRad(shot.fov) / 2);
      aim.y += shot.lift * 2 * halfHeight;
    }

    // The faintest hand-held drift, so a held frame is never dead still —
    // except across "There's a simpler way." and the glide into the reveal,
    // where it fades out and the camera is genuinely still.
    const [fadeOut, fadeIn] = CUES.driftOff;
    const drift = 1 - windowed(story.smooth, fadeOut, fadeIn);
    const t = clock.elapsedTime;
    position.x += Math.sin(t * 0.35) * 0.008 * drift;
    position.y += Math.sin(t * 0.27) * 0.006 * drift;

    camera.position.copy(position);
    camera.lookAt(aim);

    const cam = camera as THREE.PerspectiveCamera;
    if (Math.abs(cam.fov - shot.fov) > 0.001) {
      cam.fov = shot.fov;
      cam.updateProjectionMatrix();
    }
  });

  return null;
}

/**
 * Soft reflections: a small, dim, procedural "room" for the metal and the
 * lacquer to pick up. Subtle on purpose — it gives materials a believable
 * response without lighting the scene.
 */
function RoomReflections() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const generator = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = generator.fromScene(room, 0.04);
    scene.environment = target.texture;
    scene.environmentIntensity = LIGHT.environment;
    room.dispose();
    generator.dispose();
    return () => {
      scene.environment = null;
      target.dispose();
    };
  }, [gl, scene]);
  return null;
}

/**
 * The evening, then the reveal. Fill light rises as the desk clears and Cookie
 * Notes appears, so the room reads as clearer without ever looking lit-up; and
 * dips slightly while the clutter peaks, so the desk feels heavier.
 */
function Lights({ shadows }: { shadows: boolean }) {
  const story = useStory();
  const ambient = useRef<THREE.AmbientLight>(null);
  const hemisphere = useRef<THREE.HemisphereLight>(null);
  const key = useRef<THREE.DirectionalLight>(null);

  useFrame(() => {
    const p = story.smooth;
    const clarity = smoothstep(CUES.clarity[0], CUES.clarity[1], p);
    const heavy = windowed(p, CUES.clutterIn, [CUES.clutterOut[0], CUES.clutterOut[1]]);
    const dim = 1 - heavy * LIGHT.clutterDim;
    if (ambient.current) ambient.current.intensity = lerp(LIGHT.ambient[0], LIGHT.ambient[1], clarity) * dim;
    if (hemisphere.current) hemisphere.current.intensity = lerp(LIGHT.hemisphere[0], LIGHT.hemisphere[1], clarity) * dim;
    if (key.current) key.current.intensity = lerp(LIGHT.key[0], LIGHT.key[1], clarity);
  });

  return (
    <>
      <ambientLight ref={ambient} color="#ffe7cc" intensity={LIGHT.ambient[0]} />
      <hemisphereLight ref={hemisphere} args={['#ffe9d0', '#2b2118', LIGHT.hemisphere[0]]} />
      {/* The key: soft studio light from the upper left. */}
      <directionalLight
        ref={key}
        position={[-3.2, 4.6, 3.6]}
        color="#ffe3c0"
        intensity={LIGHT.key[0]}
        castShadow={shadows}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-2.8}
        shadow-camera-right={2.8}
        shadow-camera-top={2.8}
        shadow-camera-bottom={-2.8}
        shadow-camera-near={0.5}
        shadow-camera-far={12}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      {/* A low cool fill from the right, so shadows are not black. */}
      <directionalLight position={[3.5, 1.2, 1.5]} color="#9db4d6" intensity={0.24} />
      {/* A warm edge from across the desk: the navy blazer would otherwise melt into the wall. */}
      <directionalLight position={[-2.2, 1.7, -1.6]} color="#ffd2a0" intensity={LIGHT.rim} />
      <ScreenGlow />
    </>
  );
}

/** The laptop lights the student's hands and face a little, and more once Cookie Notes is on it. */
function ScreenGlow() {
  const story = useStory();
  const light = useRef<THREE.PointLight>(null);

  useFrame(() => {
    const up = smoothstep(CUES.screenShelf[0], CUES.screenShelf[1], story.smooth);
    if (light.current) light.current.intensity = lerp(LIGHT.screen[0], LIGHT.screen[1], up);
  });

  return <pointLight ref={light} position={[0, 0.34, 0.02]} color="#dce6ff" distance={2.4} decay={1.6} />;
}

/** Downloads the real note pages, but only once the story is close to them. */
function usePageTextures(enabled: boolean) {
  const [textures, setTextures] = useState<(THREE.Texture | null)[]>(() =>
    NOTE_PAGES.map(() => null),
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const loaded: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();

    // The hero page first, so the screen is right as early as possible.
    const order = [HERO_INDEX, ...NOTE_PAGES.map((_, i) => i).filter((i) => i !== HERO_INDEX)];
    order.forEach((i) => {
      loader.load(NOTE_PAGES[i].src, (texture) => {
        if (cancelled) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        loaded.push(texture);
        setTextures((prev) => {
          const next = [...prev];
          next[i] = texture;
          return next;
        });
      });
    });

    return () => {
      cancelled = true;
      loaded.forEach((t) => t.dispose());
    };
  }, [enabled]);

  return textures;
}

function World({ shadows, onReady }: { shadows: boolean; onReady: () => void }) {
  const story = useStory();
  const [wantPages, setWantPages] = useState(false);
  const textures = usePageTextures(wantPages);

  useEffect(() => {
    const check = (p: number) => {
      if (p > PAGES_PRELOAD_AT) setWantPages(true);
    };
    story.subscribers.add(check);
    return () => {
      story.subscribers.delete(check);
    };
  }, [story]);

  // The room is revealed only once the student is in it, so the two fade in
  // together instead of the character arriving after the furniture. Two frames
  // are allowed after that, so the shaders and textures of the first full frame
  // are compiled and uploaded while the stage is still hidden. If the model is
  // very slow the room appears anyway, and the student joins when ready.
  const [studentSettled, setStudentSettled] = useState(false);
  const markStudentSettled = useCallback(() => setStudentSettled(true), []);

  useEffect(() => {
    let frame = 0;
    let timer = 0;
    const reveal = () => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(onReady);
      });
    };
    if (studentSettled) reveal();
    else timer = window.setTimeout(reveal, STUDENT_WAIT_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [studentSettled, onReady]);

  const hero = textures[HERO_INDEX];

  return (
    <>
      <Rig />
      <RoomReflections />
      <Lights shadows={shadows} />
      <Room />
      <Desk />
      <Chair />
      <Lamp shadows={shadows} />
      <Keepsakes />
      <Student onSettled={markStudentSettled} />
      <Laptop page={(hero?.image as PageSource | undefined) ?? null} />
      <Book />
      <Clutter />
      <NotePages textures={textures} />
    </>
  );
}

export default function StudyScene({
  story,
  active,
  onReady,
}: {
  story: StoryState;
  /** False when the stage is off-screen: the render loop stops entirely. */
  active: boolean;
  onReady: () => void;
}) {
  // Soft shadows are the most expensive thing here; phones go without.
  const shadows = useRef(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  ).current;

  return (
    <Canvas
      aria-hidden
      frameloop={active ? 'always' : 'never'}
      shadows={shadows ? { type: THREE.PCFShadowMap } : false}
      dpr={[1, shadows ? 2 : 1.5]}
      camera={{ fov: SHOTS[0].fov, near: 0.05, far: 40, position: SHOTS[0].position }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      onCreated={({ gl, scene }) => {
        gl.setClearColor(PALETTE.room);
        scene.fog = new THREE.Fog(PALETTE.room, 8, 20);
      }}
    >
      <StoryContext.Provider value={story}>
        <World shadows={shadows} onReady={onReady} />
      </StoryContext.Provider>
    </Canvas>
  );
}
