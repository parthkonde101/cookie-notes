'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CUES, NOTE_PAGES, type Vec3 } from '@/components/home/cinematic/story-config';
import { lerp, seeded, smootherstep, smoothstep } from '@/components/home/cinematic/math';
import { useStory } from '@/components/home/cinematic/story-state';
import { Pop, RoundBox, SHADOWS } from '@/components/home/cinematic/scene/parts';
import {
  BASE,
  BUILD,
  COVERED,
  PLACED,
  originY,
  type Piece,
} from '@/components/home/cinematic/scene/desk-pieces';
import { LID_TILT, SCREEN_CENTER } from '@/components/home/cinematic/scene/props';
import {
  INKS,
  bookCover,
  bookSpine,
  classSheet,
  notebookLabel,
  pageEdge,
  printedPage,
  stickyNote,
} from '@/components/home/cinematic/scene/desk-textures';

/** The things on the desk: the reference book, the class notes, and the real notes. */

/* ------------------------------------------------------------------ */
/* The reference book                                                  */
/* ------------------------------------------------------------------ */

const BOOK_W = 0.38;
const BOOK_D = 0.52;
/** Half the thickness of the closed book: a board and a block of pages. */
const BOOK_T = 0.05;
const BOARD = 0.006;
const PAGES_T = BOOK_T - BOARD;
/** The page block is a little smaller than the boards, the way a hardback's is. */
const BLOCK_W = BOOK_W - 0.012;
const BLOCK_D = BOOK_D - 0.014;
const LEAVES = 8;
const LEAF_SEGMENTS = 16;
const CLOTH = '#512321';

/** How each leaf behaves: some are limp, some stiff, and each fans out at a slightly different angle. */
const LEAF_FEEL = Array.from({ length: LEAVES }, (_, i) => ({
  bend: 0.62 - 0.035 * i,
  ripple: 0.006 + 0.0014 * ((i * 5) % 4),
  phase: i * 1.7,
  yaw: (i - (LEAVES - 1) / 2) * 0.006,
}));

/**
 * One leaf of the book, bent as it turns: the edge away from the spine lags
 * behind and the page ripples along its depth as it travels, then lays flat on
 * the far side. `angle` is how far it has turned (0 = flat on the right, π =
 * flat on the left); `moving` (0–1) is how much it is in motion.
 */
function bendLeaf(
  geometry: THREE.PlaneGeometry,
  angle: number,
  feel: (typeof LEAF_FEEL)[number],
  moving: number,
) {
  const pos = geometry.attributes.position;
  const cols = LEAF_SEGMENTS + 1;
  const ds = BLOCK_W / LEAF_SEGMENTS;
  // The plane is built in XY with x across the width; its two rows are the near and far edge.
  let x = 0;
  let y = 0;
  const profile: [number, number][] = [[0, 0]];
  for (let c = 1; c < cols; c += 1) {
    const t = c / LEAF_SEGMENTS;
    const a = angle - feel.bend * Math.sin(angle) * t;
    x += Math.cos(a) * ds;
    y += Math.sin(a) * ds;
    profile.push([x, y]);
  }
  const wave = feel.ripple * Math.sin(angle) * moving;
  for (let i = 0; i < pos.count; i += 1) {
    const col = i % cols;
    const t = col / LEAF_SEGMENTS;
    const z = pos.getZ(i);
    const ripple = wave * t * Math.sin(z * 15 + feel.phase);
    pos.setXYZ(i, profile[col][0] + 0.004, profile[col][1] + ripple, z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

/* ------------------------------------------------------------------ */
/* The blocks of pages, with a curved gutter                            */
/* ------------------------------------------------------------------ */

/** How far from the spine the pages begin to sweep down, and how deep the valley is at the spine. */
const GUTTER_W = 0.05;
const GUTTER_DIP = 0.0085;

/**
 * One block of pages. Its readable face does not stop flat at the spine: it
 * curves down into it, the way an open book's pages do, and the two blocks
 * meet at the spine with no gap between them.
 *
 * `face: 'top'` is the right-hand block (its page face points up); `'bottom'`
 * is the half that swings over (its face points down in its own frame, and
 * comes to face up once it is turned). Group 0 is the page face, group 1 every
 * edge of the block.
 */
function pageBlockGeometry(face: 'top' | 'bottom') {
  const curve = (x: number) => GUTTER_DIP * (1 - THREE.MathUtils.smoothstep(x, 0, GUTTER_W));
  const steps = 14;
  const shape = new THREE.Shape();
  if (face === 'top') {
    shape.moveTo(0, 0);
    shape.lineTo(BLOCK_W, 0);
    shape.lineTo(BLOCK_W, PAGES_T);
    for (let i = steps; i >= 0; i -= 1) {
      const x = (i / steps) * GUTTER_W;
      shape.lineTo(x, PAGES_T - curve(x));
    }
    shape.lineTo(0, 0);
  } else {
    shape.moveTo(0, PAGES_T);
    shape.lineTo(0, curve(0));
    for (let i = 1; i <= steps; i += 1) {
      const x = (i / steps) * GUTTER_W;
      shape.lineTo(x, curve(x));
    }
    shape.lineTo(BLOCK_W, 0);
    shape.lineTo(BLOCK_W, PAGES_T);
    shape.lineTo(0, PAGES_T);
  }

  const raw = new THREE.ExtrudeGeometry(shape, { depth: BLOCK_D, bevelEnabled: false, steps: 1 });
  raw.translate(0, 0, -BLOCK_D / 2);
  const src = raw.toNonIndexed();
  const pos = src.attributes.position;

  const faceTris: number[] = [];
  const edgeTris: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    // The page face is the long, gently curved side that points up (or down). Everything else is an edge.
    const onFace = face === 'top' ? n.y > 0.2 : n.y < -0.2;
    const centreX = (a.x + b.x + c.x) / 3;
    const isCap = Math.abs(n.z) > 0.9;
    const isFace = onFace && !isCap && centreX < BLOCK_W - 1e-4;
    (isFace ? faceTris : edgeTris).push(i, i + 1, i + 2);
  }

  const faceVerts = faceTris.length;
  const total = faceTris.length + edgeTris.length;
  const order = [...faceTris, ...edgeTris];

  // Two states of the same block: shut (the face runs flat to the spine) and
  // open (the face sweeps down into it). The geometry is the flat one, with the
  // open one as a morph target, so the gutter can develop as the cover lifts.
  const dipped = new Float32Array(total * 3);
  const flat = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const normalsDipped = new Float32Array(total * 3);
  const normalsFlat = new Float32Array(total * 3);
  const flatFaceY = face === 'top' ? PAGES_T : 0;
  const sign = face === 'top' ? 1 : -1;
  const slope = (x: number) => {
    // d/dx of the face height, in the open state.
    if (x <= 0 || x >= GUTTER_W) return 0;
    const t = x / GUTTER_W;
    return (face === 'top' ? 1 : -1) * GUTTER_DIP * ((6 * t * (1 - t)) / GUTTER_W);
  };

  order.forEach((vertex, k) => {
    const x = pos.getX(vertex);
    const y = pos.getY(vertex);
    const z = pos.getZ(vertex);
    const faceY = face === 'top' ? PAGES_T - curve(x) : curve(x);
    const onCurve = x <= GUTTER_W + 1e-6 && Math.abs(y - faceY) < 1e-7;
    dipped.set([x, y, z], k * 3);
    flat.set([x, onCurve ? flatFaceY : y, z], k * 3);

    if (k < faceVerts) {
      // Smooth across the curve: the normal follows the slope of the face.
      const f = slope(x);
      const len = Math.hypot(f, 1);
      normalsDipped.set([(-f * sign) / len, sign / len, 0], k * 3);
      normalsFlat.set([0, sign, 0], k * 3);
      const v = (z + BLOCK_D / 2) / BLOCK_D;
      uvs.set([x / BLOCK_W, face === 'top' ? 1 - v : v], k * 2);
    } else {
      uvs.set([0.5, y / PAGES_T], k * 2);
    }
  });

  // Edges stay flat-shaded: one normal per triangle, from each state's own points.
  const edgeNormal = (source: Float32Array, k: number, into: Float32Array) => {
    const o = (k - (k % 3)) * 3;
    a.set(source[o], source[o + 1], source[o + 2]);
    b.set(source[o + 3], source[o + 4], source[o + 5]);
    c.set(source[o + 6], source[o + 7], source[o + 8]);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    into.set([n.x, n.y, n.z], k * 3);
  };
  for (let k = faceVerts; k < total; k += 1) {
    edgeNormal(dipped, k, normalsDipped);
    edgeNormal(flat, k, normalsFlat);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(flat, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normalsFlat, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.morphAttributes.position = [new THREE.BufferAttribute(dipped, 3)];
  out.morphAttributes.normal = [new THREE.BufferAttribute(normalsDipped, 3)];
  out.addGroup(0, faceTris.length, 0);
  out.addGroup(faceTris.length, edgeTris.length, 1);
  raw.dispose();
  src.dispose();
  return out;
}

/* ------------------------------------------------------------------ */
/* The bookmark ribbon                                                  */
/* ------------------------------------------------------------------ */

const RIBBON_WIDTH = 0.013;
const RIBBON_X = 0.036;

/**
 * Where the ribbon goes, as (z, height) along the book. It is fixed at the head
 * of the spine, lies down the gutter on the right-hand page, leaves the book at
 * the foot, hangs over the edge, and lies on the desk with its end resting
 * flat. Smoothed through a Catmull-Rom curve so the turn over the edge is soft.
 */
function ribbonPath(): { z: number; y: number; x: number }[] {
  const head = -BLOCK_D / 2;
  const foot = BLOCK_D / 2;
  const lie = BOOK_T + 0.0004;
  const key: [number, number, number][] = [
    [head, lie, RIBBON_X],
    [head + 0.1, lie, RIBBON_X + 0.001],
    [foot - 0.06, lie, RIBBON_X],
    [foot, lie, RIBBON_X],
    [foot + 0.018, lie - 0.006, RIBBON_X - 0.001],
    [foot + 0.032, lie - 0.026, RIBBON_X - 0.002],
    [foot + 0.036, 0.011, RIBBON_X - 0.004],
    [foot + 0.046, 0.0024, RIBBON_X - 0.007],
    [foot + 0.075, 0.0012, RIBBON_X - 0.012],
    [foot + 0.108, 0.0012, RIBBON_X - 0.016],
  ];
  const curve = new THREE.CatmullRomCurve3(key.map(([z, y, x]) => new THREE.Vector3(x, y, z)));
  const points = curve.getSpacedPoints(90);
  return points.map((p) => ({ x: p.x, y: Math.max(p.y, 0.0011), z: p.z }));
}

/** A satin ribbon, with a swallow-tail cut at its end and a soft highlight down its middle. */
function useRibbonGeometry() {
  const geometry = useMemo(() => {
    const path = ribbonPath();
    const rows = path.length - 4;
    const half = RIBBON_WIDTH / 2;
    const positions: number[] = [];
    const colors: number[] = [];
    const edge = new THREE.Color('#6e141b');
    const middle = new THREE.Color('#b4303a');
    const push = (x: number, y: number, z: number, c: THREE.Color) => {
      positions.push(x, y, z);
      colors.push(c.r, c.g, c.b);
    };
    // Three vertices across each row — edge, middle, edge — so the satin catches the light in the middle.
    for (let i = 0; i < rows; i += 1) {
      const { x, y, z } = path[i];
      push(x - half, y, z, edge);
      push(x, y, z, middle);
      push(x + half, y, z, edge);
    }
    const index: number[] = [];
    for (let i = 0; i < rows - 1; i += 1) {
      const a = i * 3;
      const b = (i + 1) * 3;
      index.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
    // The tail: two points, with the middle of the end cut back to a V.
    const last = rows - 1;
    const end = path[path.length - 1];
    const tl = positions.length / 3;
    push(end.x - half, end.y, end.z, edge);
    const tr = positions.length / 3;
    push(end.x + half, end.y, end.z, edge);
    const l = last * 3;
    index.push(l, tl, l + 1, l + 1, tr, l + 2);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

function Ribbon() {
  const geometry = useRibbonGeometry();
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        vertexColors
        roughness={0.34}
        metalness={0.15}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function Book() {
  const story = useStory();
  const right = useMemo(() => printedPage('right'), []);
  const left = useMemo(() => {
    // This face belongs to the half that swings over, so it is seen turned about.
    const t = printedPage('left');
    t.center.set(0.5, 0.5);
    t.rotation = Math.PI;
    return t;
  }, []);
  const leftFlipped = useMemo(() => {
    // The back of a turning leaf is seen from behind, so its picture is mirrored to read correctly.
    const t = printedPage('left', 31);
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = -1;
    t.offset.x = 1;
    return t;
  }, []);
  const cover = useMemo(() => bookCover(), []);
  const spine = useMemo(() => bookSpine(), []);
  const edge = useMemo(() => pageEdge(), []);
  const rightBlock = useMemo(() => pageBlockGeometry('top'), []);
  const leftBlock = useMemo(() => pageBlockGeometry('bottom'), []);
  const leafGeometries = useMemo(
    () =>
      Array.from({ length: LEAVES }, (_, i) => {
        const g = new THREE.PlaneGeometry(BLOCK_W, BLOCK_D, LEAF_SEGMENTS, 1);
        // Lay it so its width runs along x and its depth along z.
        g.rotateX(-Math.PI / 2);
        bendLeaf(g, 0, LEAF_FEEL[i], 0);
        return g;
      }),
    [],
  );
  useEffect(
    () => () => {
      [right, left, leftFlipped, cover, spine, edge].forEach((t) => t.dispose());
      leafGeometries.forEach((g) => g.dispose());
      rightBlock.dispose();
      leftBlock.dispose();
    },
    [right, left, leftFlipped, cover, spine, edge, leafGeometries, rightBlock, leftBlock],
  );

  const root = useRef<THREE.Group>(null);
  const flip = useRef<THREE.Group>(null);
  const spinePlane = useRef<THREE.Mesh>(null);
  const rightMesh = useRef<THREE.Mesh>(null);
  const leftMesh = useRef<THREE.Mesh>(null);
  const leaves = useRef<(THREE.Group | null)[]>([]);

  useFrame(() => {
    const p = story.smooth;
    const open =
      smootherstep((p - CUES.bookOpen[0]) / (CUES.bookOpen[1] - CUES.bookOpen[0])) *
      (1 - smoothstep(CUES.bookClose[0], CUES.bookClose[1], p));

    // The cover is lifted by a hand: it rises quickly, then eases down onto the far side.
    const lifted = 1 - Math.pow(1 - open, 2.1);
    if (flip.current) flip.current.rotation.z = lifted * Math.PI;
    if (spinePlane.current) spinePlane.current.visible = open < 0.02;

    // The pages sweep down into the spine as the book opens, and lie flush when it shuts.
    const gutter = smoothstep(0.15, 0.85, open);
    for (const mesh of [rightMesh.current, leftMesh.current]) {
      if (!mesh) continue;
      if (!mesh.morphTargetInfluences) mesh.updateMorphTargets();
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[0] = gutter;
    }

    // Loose leaves turn after the cover, each a little later than the last, and
    // bend as they go, so the pages fan over rather than the book hinging like a lid.
    leaves.current.forEach((leaf, i) => {
      if (!leaf) return;
      const lag = 0.04 * (i + 1);
      const turned = smootherstep((open - lag) / (1 - lag));
      leaf.visible = open > 0.01 && open < 0.995;
      leaf.rotation.y = LEAF_FEEL[i].yaw * Math.sin(turned * Math.PI);
      const moving = Math.sin(Math.min(1, Math.max(0, turned)) * Math.PI);
      if (leaf.visible) bendLeaf(leafGeometries[i], turned * Math.PI, LEAF_FEEL[i], moving);
    });

    // The spine stays put while the book opens, so the open book sits centred.
    if (root.current) {
      root.current.position.x = lerp(-0.95 - BOOK_W / 2, -0.95, open);
      // The book lifts a hair as the cover comes up, and settles.
      root.current.position.y = Math.sin(open * Math.PI) * 0.004;
    }
  });

  // Group 0 of a block is its page face; group 1 is every edge.
  const pageMaterials = (face: THREE.Texture) => (
    <>
      <meshStandardMaterial attach="material-0" map={face} roughness={0.95} />
      <meshStandardMaterial attach="material-1" map={edge} roughness={0.9} />
    </>
  );

  return (
    <Pop
      position={[0, 0, 0.12]}
      rotation={[0, 0.3, 0]}
      vanish={[CUES.bookClose[1], CUES.clutterOut[1] - 0.02]}
    >
      <group ref={root}>
        {/* Lower half: back board and the right-hand block of pages. */}
        <mesh position={[BOOK_W / 2, BOARD / 2, 0]} {...SHADOWS}>
          <boxGeometry args={[BOOK_W, BOARD, BOOK_D]} />
          <meshStandardMaterial color={CLOTH} roughness={0.75} />
        </mesh>
        <mesh ref={rightMesh} geometry={rightBlock} position={[0, BOARD, 0]} {...SHADOWS}>
          {pageMaterials(right)}
        </mesh>

        {/* The ribbon that comes with the book. */}
        <Ribbon />

        {/* Leaves turning over, bending as they go. */}
        <group position={[0, BOOK_T + 0.0008, 0]}>
          {leafGeometries.map((geometry, i) => (
            <group
              key={i}
              ref={(el) => {
                leaves.current[i] = el;
              }}
              position={[0, i * 0.00025, 0]}
              visible={false}
            >
              <mesh geometry={geometry} receiveShadow>
                <meshStandardMaterial map={right} roughness={0.95} side={THREE.FrontSide} />
              </mesh>
              <mesh geometry={geometry} receiveShadow>
                <meshStandardMaterial map={leftFlipped} roughness={0.95} side={THREE.BackSide} />
              </mesh>
            </group>
          ))}
        </group>

        {/* Upper half: the front board and its pages, swinging open about the spine. */}
        <group ref={flip} position={[0, BOOK_T, 0]}>
          <mesh ref={leftMesh} geometry={leftBlock} {...SHADOWS}>
            {pageMaterials(left)}
          </mesh>
          <mesh position={[BOOK_W / 2, PAGES_T + BOARD / 2, 0]} {...SHADOWS}>
            <boxGeometry args={[BOOK_W, BOARD, BOOK_D]} />
            <meshStandardMaterial attach="material-0" color={CLOTH} roughness={0.75} />
            <meshStandardMaterial attach="material-1" color={CLOTH} roughness={0.75} />
            <meshStandardMaterial attach="material-2" map={cover} roughness={0.55} />
            <meshStandardMaterial attach="material-3" color="#cdbf9f" roughness={0.9} />
            <meshStandardMaterial attach="material-4" color={CLOTH} roughness={0.75} />
            <meshStandardMaterial attach="material-5" color={CLOTH} roughness={0.75} />
          </mesh>
        </group>

        {/* The spine, while the book is shut: the title runs along it. */}
        <mesh ref={spinePlane} position={[-0.0006, BOOK_T, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[BOOK_D, BOOK_T * 2]} />
          <meshStandardMaterial map={spine} roughness={0.6} />
        </mesh>
      </group>
    </Pop>
  );
}

/* ------------------------------------------------------------------ */
/* Paper, notebooks, pens                                              */
/* ------------------------------------------------------------------ */

const SHEET_W = 0.3;
const SHEET_L = 0.42;

/**
 * A sheet of paper. The surface is smooth — a fine grid and no ripple, so it
 * shades like paper and not like card — with, if nothing lies on it, one
 * corner lifting a little. A covered sheet stays flat, so whatever is on top of
 * it can never pass through it.
 */
function sheetGeometry(seed: number, covered: boolean) {
  const rand = seeded(seed * 7 + 1);
  const g = new THREE.PlaneGeometry(SHEET_W, SHEET_L, 24, 34);
  g.rotateX(-Math.PI / 2);
  const sx = rand() > 0.5 ? 1 : -1;
  const sz = rand() > 0.5 ? 1 : -1;
  const lift = covered ? 0 : 0.0025 + rand() * 0.0035;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // 0 across most of the sheet, rising smoothly toward one corner.
    const corner = Math.max(0, (x * sx) / SHEET_W + (z * sz) / SHEET_L - 0.1);
    pos.setY(i, corner * corner * lift * 2.4);
  }
  g.computeVertexNormals();
  return g;
}

/** A sticky note: a little lighter at the glue, and the free corner curls up. */
function stickyGeometry() {
  const g = new THREE.PlaneGeometry(0.075, 0.075, 6, 6);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const d = Math.max(0, (pos.getX(i) + pos.getZ(i)) / 0.15 + 0.2);
    pos.setY(i, d * d * 0.004);
  }
  g.computeVertexNormals();
  return g;
}

function Notebook({ size, color, seed }: { size: Vec3; color: string; seed: number }) {
  const [w, t, d] = size;
  const edge = useMemo(() => pageEdge(), []);
  const label = useMemo(() => notebookLabel(seed), [seed]);
  useEffect(
    () => () => {
      edge.dispose();
      label.dispose();
    },
    [edge, label],
  );
  const board = 0.0045;
  return (
    <group>
      <RoundBox size={[w, board, d]} radius={0.003} position={[0, board / 2, 0]}>
        <meshStandardMaterial color={color} roughness={0.7} />
      </RoundBox>
      <mesh position={[0.003, t / 2, 0]} {...SHADOWS}>
        <boxGeometry args={[w - 0.012, t - 2 * board, d - 0.01]} />
        <meshStandardMaterial attach="material-0" map={edge} roughness={0.9} />
        <meshStandardMaterial attach="material-1" color="#d9cdb2" roughness={0.9} />
        <meshStandardMaterial attach="material-2" color="#d9cdb2" roughness={0.9} />
        <meshStandardMaterial attach="material-3" color="#d9cdb2" roughness={0.9} />
        <meshStandardMaterial attach="material-4" map={edge} roughness={0.9} />
        <meshStandardMaterial attach="material-5" map={edge} roughness={0.9} />
      </mesh>
      <RoundBox size={[w, board, d]} radius={0.003} position={[0, t - board / 2, 0]} {...SHADOWS}>
        <meshStandardMaterial color={color} roughness={0.7} />
      </RoundBox>
      {/* The spine, a shade darker. */}
      <RoundBox size={[0.008, t, d]} radius={0.003} position={[-w / 2 + 0.004, t / 2, 0]}>
        <meshStandardMaterial color={color} roughness={0.8} />
      </RoundBox>
      {/* The label on the cover, and an elastic band across it. */}
      <mesh position={[w * 0.06, t + 0.0003, -d * 0.18]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w * 0.56, w * 0.56 * 0.625]} />
        <meshStandardMaterial map={label} roughness={0.85} />
      </mesh>
      <RoundBox size={[0.009, t + 0.002, d + 0.002]} radius={0.002} position={[w * 0.3, t / 2, 0]}>
        <meshStandardMaterial color="#141414" roughness={0.6} />
      </RoundBox>
    </group>
  );
}

function Pen({ color }: { color: string }) {
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh position={[0, 0.002, 0]} {...SHADOWS}>
        <cylinderGeometry args={[0.0058, 0.0058, 0.11, 14]} />
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.1} />
      </mesh>
      {/* Grip and tip. */}
      <mesh position={[0, -0.0675, 0]} {...SHADOWS}>
        <cylinderGeometry args={[0.0058, 0.0032, 0.025, 14]} />
        <meshStandardMaterial color="#1a1a1c" roughness={0.5} />
      </mesh>
      <mesh position={[0, -0.0825, 0]}>
        <coneGeometry args={[0.0032, 0.007, 12]} />
        <meshStandardMaterial color="#b9b9bd" metalness={0.9} roughness={0.25} />
      </mesh>
      {/* Cap and clip. */}
      <mesh position={[0, 0.0635, 0]} {...SHADOWS}>
        <cylinderGeometry args={[0.0062, 0.0062, 0.017, 14]} />
        <meshStandardMaterial color="#1a1a1c" roughness={0.5} />
      </mesh>
      <mesh position={[0.0065, 0.04, 0]}>
        <boxGeometry args={[0.0016, 0.045, 0.004]} />
        <meshStandardMaterial color="#c9c9cd" metalness={0.9} roughness={0.3} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Clutter: class notes, loose sheets, the day-to-day mess              */
/* ------------------------------------------------------------------ */

/** How long each piece takes to clear, in progress. Long, so neighbours overlap and the wave is continuous. */
const CLEAR_LENGTH = 0.035;

export function Clutter() {
  const textures = useMemo(() => {
    const sheets = new Map<number, THREE.Texture>();
    const stickies = new Map<number, THREE.Texture>();
    const geometries = new Map<number, THREE.BufferGeometry>();
    [...BASE, ...BUILD].forEach((piece, i) => {
      if (piece.kind === 'sheet') {
        sheets.set(piece.seed, classSheet(piece.seed, INKS[i % INKS.length]));
        geometries.set(piece.seed, sheetGeometry(piece.seed, COVERED[i]));
      }
      if (piece.kind === 'sticky') {
        stickies.set(piece.seed, stickyNote(piece.color, piece.seed));
        geometries.set(piece.seed, stickyGeometry());
      }
    });
    return { sheets, stickies, geometries };
  }, []);
  useEffect(
    () => () => {
      textures.sheets.forEach((t) => t.dispose());
      textures.stickies.forEach((t) => t.dispose());
      textures.geometries.forEach((g) => g.dispose());
    },
    [textures],
  );

  // Clearing the desk is a wave, not a shuffle: pieces nearest the camera go
  // first and the clearing travels away from it, so it reads as one calm
  // gesture. A random order makes the reset flicker. The reference point is
  // where the camera is when the clutter peaks.
  const clearOrder = useMemo(() => {
    const view = new THREE.Vector3(1.42, 1.4, 1.72);
    // Pieces lying on others go first, so nothing is left floating when what it
    // was resting on is cleared: each level up counts as being much nearer.
    const ranked = [...BASE, ...BUILD]
      .map((piece, index) => ({
        index,
        d: view.distanceTo(new THREE.Vector3(...piece.position)) - 1.5 * PLACED[index].level,
      }))
      .sort((x, y) => x.d - y.d);
    const order: number[] = [];
    ranked.forEach(({ index }, rank) => {
      order[index] = rank;
    });
    return order;
  }, []);

  const [inStart, inEnd] = CUES.clutterIn;
  const [outStart, outEnd] = CUES.clutterOut;
  const total = BASE.length + BUILD.length;
  const vanishFor = (index: number): readonly [number, number] => {
    const slot = clearOrder[index] / (total - 1);
    const start = outStart + slot * (outEnd - outStart - CLEAR_LENGTH);
    return [start, start + CLEAR_LENGTH];
  };
  const arriveFor = (buildIndex: number): readonly [number, number] => {
    const start = inStart + (buildIndex / (BUILD.length - 1)) * (inEnd - inStart - 0.04);
    return [start, start + 0.04];
  };

  const render = (piece: Piece, index: number, appear?: readonly [number, number]) => {
    const vanish = vanishFor(index);
    const key = `${piece.kind}-${index}`;
    const common = {
      position: [piece.position[0], originY(piece, PLACED[index]), piece.position[2]] as Vec3,
      rotation: [0, piece.rotationY, 0] as Vec3,
      appear,
      vanish,
      drop: piece.kind === 'sheet' ? 0.28 : 0.2,
      turn: piece.kind === 'sheet' ? 0.4 : 0.15,
      rise: 0.04,
      tilt: piece.kind === 'sheet' ? 0.5 : piece.kind === 'sticky' ? 0.3 : 0,
    };
    switch (piece.kind) {
      case 'sheet':
        return (
          <Pop key={key} {...common}>
            <mesh geometry={textures.geometries.get(piece.seed)} {...SHADOWS}>
              <meshStandardMaterial
                map={textures.sheets.get(piece.seed)}
                roughness={0.92}
                side={THREE.DoubleSide}
              />
            </mesh>
          </Pop>
        );
      case 'notebook':
        return (
          <Pop key={key} {...common}>
            <group position={[0, -piece.size[1] / 2, 0]}>
              <Notebook size={piece.size} color={piece.color} seed={index + 5} />
            </group>
          </Pop>
        );
      case 'sticky':
        return (
          <Pop key={key} {...common}>
            <mesh geometry={textures.geometries.get(piece.seed)} {...SHADOWS}>
              <meshStandardMaterial
                map={textures.stickies.get(piece.seed)}
                roughness={0.9}
                side={THREE.DoubleSide}
              />
            </mesh>
          </Pop>
        );
      case 'pen':
        return (
          <Pop key={key} {...common}>
            <Pen color={piece.color} />
          </Pop>
        );
      case 'stack':
        return (
          <Pop key={key} {...common}>
            <group position={[0, -0.05, 0]}>
              <Notebook size={[0.3, 0.045, 0.4]} color="#6b4a2c" seed={41} />
              <group position={[0.01, 0.045, -0.01]} rotation={[0, 0.12, 0]}>
                <Notebook size={[0.28, 0.04, 0.37]} color="#2f4a5e" seed={42} />
              </group>
              <group position={[-0.008, 0.085, 0.006]} rotation={[0, -0.08, 0]}>
                <Notebook size={[0.26, 0.036, 0.34]} color="#496b4f" seed={43} />
              </group>
            </group>
          </Pop>
        );
    }
  };

  return (
    <group>
      {BASE.map((piece, i) => render(piece, i))}
      {BUILD.map((piece, i) => render(piece, BASE.length + i, arriveFor(i)))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* The real notes, rising out of the screen                             */
/* ------------------------------------------------------------------ */

const PAGE_W = 0.24;
const PAGE_H = (PAGE_W * 858) / 664;

export function NotePages({ textures }: { textures: (THREE.Texture | null)[] }) {
  const story = useStory();
  const refs = useRef<(THREE.Group | null)[]>([]);
  const supporting = useMemo(
    () => NOTE_PAGES.map((n, i) => (n.hero ? -1 : i)).filter((i) => i >= 0),
    [],
  );

  useFrame(() => {
    const p = story.smooth;
    const [foldA, foldB] = CUES.pagesFold;
    // The hero is the last to go: the others fold away first and it follows.
    const foldSupport = smoothstep(foldA, foldB - 0.008, p);
    const foldHero = smoothstep(foldA + 0.008, foldB, p);

    NOTE_PAGES.forEach((note, i) => {
      const g = refs.current[i];
      if (!g) return;

      const hero = Boolean(note.hero);
      let arrived: number;
      if (hero) {
        arrived = smootherstep(
          (p - CUES.heroEmerge[0]) / (CUES.heroEmerge[1] - CUES.heroEmerge[0]),
        );
      } else {
        const order = supporting.indexOf(i);
        const start = CUES.supportStart + order * CUES.supportStagger;
        arrived = smootherstep((p - start) / CUES.supportFlight);
      }
      const e = arrived * (1 - (hero ? foldHero : foldSupport));

      g.visible = e > 0.004 && textures[i] !== null;
      if (!g.visible) return;

      const pose = note.pose;
      g.position.set(
        lerp(SCREEN_CENTER.x, pose.position[0], e),
        lerp(SCREEN_CENTER.y, pose.position[1], e) + Math.sin(e * Math.PI) * 0.05,
        lerp(SCREEN_CENTER.z, pose.position[2], e),
      );
      g.rotation.set(lerp(LID_TILT, pose.rotateX, e), pose.rotateY * e, pose.rotateZ * e);
      g.scale.setScalar(lerp(0.12, pose.scale, e));
    });
  });

  return (
    <group>
      {NOTE_PAGES.map((note, i) => {
        const b = note.pose.brightness;
        return (
          <group
            key={note.page}
            ref={(el) => {
              refs.current[i] = el;
            }}
            visible={false}
          >
            <mesh position={[0, 0, -0.0015]}>
              <planeGeometry args={[PAGE_W + 0.008, PAGE_H + 0.008]} />
              <meshBasicMaterial
                color={new THREE.Color(0.89 * b, 0.83 * b, 0.71 * b)}
                toneMapped={false}
              />
            </mesh>
            {textures[i] && (
              <mesh>
                <planeGeometry args={[PAGE_W, PAGE_H]} />
                <meshBasicMaterial
                  map={textures[i]}
                  color={new THREE.Color(b, b, b)}
                  toneMapped={false}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}
