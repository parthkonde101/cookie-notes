import { seeded } from '@/components/home/cinematic/math';
import { canvas, roundRect, texture, type Ctx } from '@/components/home/cinematic/scene/canvas-kit';

/**
 * Everything printed, written or typed on the desk: the MacBook's keyboard, the
 * reference book (cover, spine, pages), the class notes and the sticky notes.
 * Drawn once on small canvases; nothing here is an image file.
 */

const HAND =
  "'Bradley Hand', 'Segoe Print', 'Noteworthy', 'Chalkboard SE', 'Comic Sans MS', cursive";
const SERIF = "Georgia, 'Times New Roman', 'Iowan Old Style', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/* ------------------------------------------------------------------ */
/* The MacBook keyboard                                                */
/* ------------------------------------------------------------------ */

type Key = { label: string; w?: number; sub?: string; half?: boolean };

const K = (label: string, w = 1, sub?: string): Key => ({ label, w, sub });

const FUNCTION_ROW: Key[] = [
  K('esc', 1.5),
  ...['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map((f) => K(f)),
  K('', 1),
];
const ROWS: Key[][] = [
  [
    ...['`~', '1!', '2@', '3#', '4$', '5%', '6^', '7&', '8*', '9(', '0)', '-_', '=+'].map((l) =>
      K(l.length > 1 ? l[1] : l, 1, l.length > 1 ? l[0] : undefined),
    ),
    K('delete', 1.5),
  ],
  [K('tab', 1.5), ...'QWERTYUIOP[]'.split('').map((l) => K(l)), K('\\', 1.5)],
  [K('caps lock', 1.75), ..."ASDFGHJKL;'".split('').map((l) => K(l)), K('return', 2.25)],
  [K('shift', 2.25), ...'ZXCVBNM,./'.split('').map((l) => K(l)), K('shift', 2.75)],
];
const BOTTOM: Key[] = [
  K('fn'),
  K('control'),
  K('option'),
  K('command', 1.25),
  K('', 5),
  K('command', 1.25),
  K('option'),
];

/**
 * A MacBook keyboard: graphite deck, black keycaps with a lit-edge bevel, a
 * short function row, the inverted-T arrow cluster, and legends. Returns the
 * colour map and a matching bump map so the keys stand proud of the deck.
 */
export function keyboardTextures() {
  const W = 1120;
  const H = 480;
  const [c, ctx] = canvas(W, H);
  const [b, bctx] = canvas(W, H);
  ctx.fillStyle = '#2b2b2e';
  ctx.fillRect(0, 0, W, H);
  bctx.fillStyle = '#000';
  bctx.fillRect(0, 0, W, H);

  const margin = 14;
  const gap = 5;
  const unit = (W - margin * 2 + gap) / 15;
  const keyH = 62;
  const fnH = 38;

  const drawKey = (x: number, y: number, w: number, h: number, key: Key) => {
    // Cap: dark, with a faintly lighter dished top and a brighter upper lip.
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#26262a');
    g.addColorStop(0.5, '#17171a');
    g.addColorStop(1, '#101012');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, w, h, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 6);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    roundRect(ctx, x + 5, y + 5, w - 10, h * 0.42, 5);
    ctx.fill();

    bctx.fillStyle = '#fff';
    roundRect(bctx, x, y, w, h, 7);
    bctx.fill();

    ctx.fillStyle = '#e9e9ec';
    ctx.textBaseline = 'middle';
    const word = key.label.length > 1;
    if (word) {
      ctx.font = `600 ${h > 50 ? 15 : 12}px ${SANS}`;
      const left = [
        'tab',
        'caps lock',
        'shift',
        'control',
        'option',
        'command',
        'fn',
        'delete',
        'return',
        'esc',
      ];
      const placed = left.includes(key.label) && key.label !== 'esc';
      ctx.textAlign = placed
        ? key.label === 'delete' || key.label === 'return' || w > 2.2 * unit
          ? 'right'
          : 'left'
        : 'center';
      const tx =
        ctx.textAlign === 'right' ? x + w - 10 : ctx.textAlign === 'left' ? x + 10 : x + w / 2;
      ctx.fillText(key.label, tx, y + (h > 50 ? h - 17 : h / 2));
    } else if (key.sub) {
      ctx.font = `500 15px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(key.sub, x + w / 2, y + h * 0.32);
      ctx.fillText(key.label, x + w / 2, y + h * 0.68);
    } else if (key.label) {
      ctx.font = `500 ${h > 50 ? 22 : 13}px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(key.label, x + w / 2, y + h / 2 + 1);
    }
  };

  let y = margin;
  let x = margin;
  FUNCTION_ROW.forEach((key) => {
    const w = (key.w ?? 1) * unit - gap;
    drawKey(x, y, w, fnH, key);
    x += w + gap;
  });
  y += fnH + gap + 2;

  ROWS.forEach((row) => {
    x = margin;
    row.forEach((key) => {
      const w = (key.w ?? 1) * unit - gap;
      drawKey(x, y, w, keyH, key);
      x += w + gap;
    });
    y += keyH + gap;
  });

  // Bottom row: modifiers, space bar, then the arrow cluster (half-height up/down).
  x = margin;
  BOTTOM.forEach((key) => {
    const w = (key.w ?? 1) * unit - gap;
    drawKey(x, y, w, keyH, key);
    x += w + gap;
  });
  const aw = unit - gap;
  const half = (keyH - gap) / 2;
  drawKey(x, y + half + gap, aw, half, K('◂'));
  drawKey(x + unit, y, aw, half, K('▴'));
  drawKey(x + unit, y + half + gap, aw, half, K('▾'));
  drawKey(x + unit * 2, y + half + gap, aw, half, K('▸'));

  const colour = texture(c, { anisotropy: 8 });
  const bump = texture(b, { anisotropy: 4, linear: true });
  return { colour, bump };
}

/* ------------------------------------------------------------------ */
/* Writing helpers                                                     */
/* ------------------------------------------------------------------ */

type Rand = () => number;

/** A line that wobbles a little, the way a hand-drawn one does. */
function wobble(ctx: Ctx, rand: Rand, x0: number, y0: number, x1: number, y1: number, amp = 1.4) {
  const steps = Math.max(2, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 14));
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    ctx.lineTo(
      x0 + (x1 - x0) * t + (rand() - 0.5) * amp,
      y0 + (y1 - y0) * t + (rand() - 0.5) * amp,
    );
  }
  ctx.stroke();
}

function sketchBox(ctx: Ctx, rand: Rand, x: number, y: number, w: number, h: number) {
  wobble(ctx, rand, x, y, x + w, y + 1);
  wobble(ctx, rand, x + w, y + 1, x + w - 1, y + h);
  wobble(ctx, rand, x + w - 1, y + h, x + 1, y + h - 1);
  wobble(ctx, rand, x + 1, y + h - 1, x, y);
}

function arrow(ctx: Ctx, rand: Rand, x0: number, y0: number, x1: number, y1: number) {
  wobble(ctx, rand, x0, y0, x1, y1, 1.2);
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 8 * Math.cos(a - 0.45), y1 - 8 * Math.sin(a - 0.45));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 8 * Math.cos(a + 0.45), y1 - 8 * Math.sin(a + 0.45));
  ctx.stroke();
}

/** Paper grain, so a flat colour reads as a sheet. */
function grain(ctx: Ctx, rand: Rand, w: number, h: number, strength = 0.05) {
  for (let i = 0; i < w * h * 0.012; i += 1) {
    ctx.fillStyle = `rgba(90,70,40,${rand() * strength})`;
    ctx.fillRect(rand() * w, rand() * h, 1.5, 1.5);
  }
}

const TOPICS = [
  'Data Link Layer',
  'Framing & CRC',
  'Stop-and-Wait ARQ',
  'Sliding Window',
  'Go-Back-N',
  'Selective Repeat',
  'CSMA/CD',
  'IP Addressing',
  'Subnetting',
  'TCP Handshake',
  'Routing: RIP & OSPF',
  'OSI vs TCP/IP',
];
const POINTS = [
  'window size = 2^k - 1',
  'sender keeps copies until ACK',
  'NAK -> resend only lost frame',
  'timeout > 2 x prop. delay',
  'efficiency = 1 / (1 + 2a)',
  'piggybacking saves a frame',
  'checksum: 1s complement',
  'MAC = 48 bit, IP = 32 bit',
  'collision -> back off 2^n',
  'SYN, SYN-ACK, ACK',
  'longest prefix match',
  'TTL drops hop by hop',
  'IMP!! frequent in exams',
  'revise before Friday',
];

/** Notes taken in class: titles, bullets, a diagram, highlights — different every time. */
export function classSheet(seed: number, ink: string) {
  const W = 448;
  const H = 640;
  const [c, ctx] = canvas(W, H);
  const rand = seeded(seed);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];

  // Paper: a warm white, a little uneven, with darker edges.
  const tone = ['#f3efe4', '#ece6d6', '#f6f2ea', '#efe9db'][Math.floor(rand() * 4)];
  ctx.fillStyle = tone;
  ctx.fillRect(0, 0, W, H);
  grain(ctx, rand, W, H, 0.06);
  const edge = ctx.createRadialGradient(W / 2, H / 2, W * 0.35, W / 2, H / 2, H * 0.75);
  edge.addColorStop(0, 'rgba(120,95,55,0)');
  edge.addColorStop(1, 'rgba(120,95,55,0.16)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, W, H);

  const ruled = rand() > 0.3;
  const spiral = ruled && rand() > 0.5;
  if (ruled) {
    ctx.strokeStyle = 'rgba(80,125,185,0.32)';
    ctx.lineWidth = 1.2;
    for (let y = 70; y < H - 20; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(205,85,85,0.4)';
    ctx.beginPath();
    ctx.moveTo(62, 0);
    ctx.lineTo(62, H);
    ctx.stroke();
  }
  if (spiral) {
    // Torn spiral edge down the left.
    ctx.fillStyle = 'rgba(60,50,40,0.5)';
    for (let y = 30; y < H - 10; y += 30) {
      ctx.beginPath();
      ctx.arc(14, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const left = ruled ? 74 : 40;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.textBaseline = 'alphabetic';

  // Title, underlined twice.
  ctx.font = `600 27px ${HAND}`;
  const title = pick(TOPICS);
  ctx.save();
  ctx.translate(left, 52);
  ctx.rotate((rand() - 0.5) * 0.02);
  ctx.fillText(title, 0, 0);
  ctx.restore();
  ctx.lineWidth = 2;
  wobble(ctx, rand, left, 60, left + 24 + title.length * 12.5, 60);
  wobble(ctx, rand, left + 4, 65, left + 20 + title.length * 11, 65);

  // Bullets.
  ctx.font = `500 19px ${HAND}`;
  let y = 98;
  const bullets = 5 + Math.floor(rand() * 3);
  for (let i = 0; i < bullets && y < H - 210; i += 1) {
    const line = pick(POINTS);
    if (rand() > 0.72) {
      ctx.fillStyle = 'rgba(255,224,70,0.5)';
      ctx.fillRect(left + 12, y - 16, Math.min(W - left - 24, line.length * 9.2), 21);
      ctx.fillStyle = ink;
    }
    ctx.fillText('• ' + line, left, y + (rand() - 0.5) * 3);
    y += 28 + (rand() > 0.8 ? 14 : 0);
    if (rand() > 0.82) {
      ctx.font = `500 16px ${HAND}`;
      ctx.fillText('   - ' + pick(POINTS), left, y);
      y += 26;
      ctx.font = `500 19px ${HAND}`;
    }
  }

  // A small diagram: nodes and arrows, the way a network gets drawn on a margin.
  const dy = Math.max(y + 14, H - 210);
  ctx.lineWidth = 1.9;
  const kind = rand();
  if (kind < 0.5) {
    const nodes = [left + 20, left + 130, left + 240].map((nx) => nx + (rand() - 0.5) * 8);
    nodes.forEach((nx, i) => {
      sketchBox(ctx, rand, nx, dy, 62, 40);
      ctx.font = `500 15px ${HAND}`;
      ctx.fillText(['sender', 'router', 'recv'][i], nx + 8, dy + 25);
    });
    arrow(ctx, rand, nodes[0] + 64, dy + 14, nodes[1] - 3, dy + 14);
    arrow(ctx, rand, nodes[1] + 64, dy + 14, nodes[2] - 3, dy + 14);
    arrow(ctx, rand, nodes[2] - 3, dy + 30, nodes[0] + 64, dy + 30);
    ctx.font = `500 14px ${HAND}`;
    ctx.fillText('frame', nodes[0] + 70, dy + 8);
    ctx.fillText('ACK', nodes[1] + 78, dy + 46);
  } else {
    for (let i = 0; i < 6; i += 1) {
      sketchBox(ctx, rand, left + 10 + i * 48, dy, 38, 34);
      ctx.font = `500 15px ${HAND}`;
      ctx.fillText(String(i), left + 24 + i * 48, dy + 23);
    }
    ctx.fillStyle = 'rgba(255,224,70,0.45)';
    ctx.fillRect(left + 10 + 48, dy - 4, 48 * 3 - 10, 42);
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.ellipse(left + 10 + 48 * 2 + 14, dy + 17, 78, 30, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `500 16px ${HAND}`;
    ctx.fillText('window', left + 90, dy + 66);
  }

  // Margin marks: a star, an underline, a page number.
  if (rand() > 0.5) {
    ctx.font = `700 26px ${HAND}`;
    ctx.fillStyle = '#b3261e';
    ctx.fillText('★', W - 52, 56 + rand() * 20);
    ctx.fillStyle = ink;
  }
  ctx.font = `500 15px ${HAND}`;
  ctx.fillText(String(Math.floor(3 + rand() * 40)), W - 38, H - 22);

  // Wear: a fold, sometimes a coffee ring.
  if (rand() > 0.45) {
    const fy = H * (0.33 + rand() * 0.34);
    const fg = ctx.createLinearGradient(0, fy - 6, 0, fy + 6);
    fg.addColorStop(0, 'rgba(0,0,0,0)');
    fg.addColorStop(0.5, 'rgba(60,45,25,0.22)');
    fg.addColorStop(1, 'rgba(255,255,255,0.14)');
    ctx.fillStyle = fg;
    ctx.fillRect(0, fy - 6, W, 12);
  }
  if (rand() > 0.78) {
    ctx.strokeStyle = 'rgba(120,70,30,0.28)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(W * (0.55 + rand() * 0.3), H * (0.65 + rand() * 0.2), 30, 0.2, Math.PI * 1.85);
    ctx.stroke();
  }
  return texture(c, { anisotropy: 8 });
}

const STICKY_TEXT = [
  ['Exam', 'Fri 9am!'],
  ['TCP vs', 'UDP ?'],
  ['ask prof', 'about CRC'],
  ['revise', 'unit 3'],
  ['PYQs!!', 'start today'],
  ['sub-', 'netting'],
  ['lab', 'viva Mon'],
  ['OSI', 'layers 1-7'],
];

export function stickyNote(color: string, seed: number) {
  const S = 192;
  const [c, ctx] = canvas(S, S);
  const rand = seeded(seed);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, S, S);
  // Lighter at the top where the glue is, a little shade where the corner curls.
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.18, 'rgba(255,255,255,0)');
  g.addColorStop(0.82, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(60,40,0,0.18)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  grain(ctx, rand, S, S, 0.05);
  const [a, b] = STICKY_TEXT[Math.floor(rand() * STICKY_TEXT.length)];
  ctx.fillStyle = 'rgba(30,30,40,0.82)';
  ctx.font = `600 31px ${HAND}`;
  ctx.textBaseline = 'alphabetic';
  ctx.save();
  ctx.translate(18, 76);
  ctx.rotate((rand() - 0.5) * 0.08);
  ctx.fillText(a, 0, 0);
  ctx.fillText(b, 0, 38);
  ctx.restore();
  ctx.strokeStyle = 'rgba(30,30,40,0.7)';
  ctx.lineWidth = 2.2;
  wobble(ctx, rand, 18, 150, 118 + rand() * 40, 152);
  return texture(c, { anisotropy: 4 });
}

export const INKS = ['#1c3f7a', '#202020', '#7a1f1f', '#3a3a44', '#165a3c'];

/* ------------------------------------------------------------------ */
/* The reference book                                                  */
/* ------------------------------------------------------------------ */

export const BOOK_TITLE = 'COMPUTER NETWORKS';

/** Burgundy cloth, gold-foil title, a network emblem — a textbook that has seen a few semesters. */
export function bookCover() {
  const W = 560;
  const H = 780;
  const [c, ctx] = canvas(W, H);
  const rand = seeded(3);

  // Cloth: a fine weave over a deep red.
  ctx.fillStyle = '#5a2623';
  ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.025)';
    ctx.fillRect(0, y, W, 1);
  }
  for (let x = 0; x < W; x += 3) {
    ctx.fillStyle = x % 6 === 0 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(x, 0, 1, H);
  }
  for (let i = 0; i < 1400; i += 1) {
    ctx.fillStyle = `rgba(0,0,0,${rand() * 0.1})`;
    ctx.fillRect(rand() * W, rand() * H, 2, 2);
  }
  // Wear along the edges.
  const wear = ctx.createRadialGradient(W / 2, H / 2, W * 0.45, W / 2, H / 2, H * 0.72);
  wear.addColorStop(0, 'rgba(0,0,0,0)');
  wear.addColorStop(1, 'rgba(20,6,4,0.45)');
  ctx.fillStyle = wear;
  ctx.fillRect(0, 0, W, H);

  const foil = (x0: number, y0: number, x1: number, y1: number) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#f2d68c');
    g.addColorStop(0.45, '#c9a15a');
    g.addColorStop(1, '#8c6a2c');
    return g;
  };

  // Double border.
  ctx.strokeStyle = foil(0, 0, W, H);
  ctx.lineWidth = 5;
  ctx.strokeRect(26, 26, W - 52, H - 52);
  ctx.lineWidth = 1.6;
  ctx.strokeRect(38, 38, W - 76, H - 76);

  // Network emblem: a ring of nodes, linked.
  const cx = W / 2;
  const cy = 178;
  const nodes = Array.from({ length: 7 }, (_, i) => {
    const a = (i / 7) * Math.PI * 2 - Math.PI / 2;
    return [cx + Math.cos(a) * 62, cy + Math.sin(a) * 62] as const;
  });
  ctx.strokeStyle = foil(cx - 70, cy - 70, cx + 70, cy + 70);
  ctx.lineWidth = 2.2;
  nodes.forEach(([x, y], i) => {
    nodes.forEach(([x2, y2], j) => {
      if (j > i && (j - i === 2 || j - i === 3)) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    });
  });
  ctx.fillStyle = foil(cx - 70, cy - 70, cx + 70, cy + 70);
  nodes.forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.fill();

  // Title, embossed: a dark offset under the foil.
  const title = (text: string, y: number, size: number, spacing: number) => {
    ctx.font = `700 ${size}px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
    ctx.fillStyle = 'rgba(20,6,4,0.7)';
    ctx.fillText(text, cx + 2, y + 3);
    ctx.fillStyle = foil(cx - 200, y - size, cx + 200, y);
    ctx.fillText(text, cx, y);
    (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
  };
  title('COMPUTER', 372, 68, 5);
  title('NETWORKS', 458, 68, 5);

  ctx.strokeStyle = foil(120, 0, W - 120, 0);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(120, 494);
  ctx.lineTo(W - 120, 494);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(150, 502);
  ctx.lineTo(W - 150, 502);
  ctx.stroke();

  ctx.font = `italic 400 26px ${SERIF}`;
  ctx.fillStyle = foil(120, 520, W - 120, 560);
  ctx.textAlign = 'center';
  ctx.fillText('Principles · Protocols · Practice', cx, 548);

  ctx.font = `600 20px ${SERIF}`;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '5px';
  ctx.fillText('FIFTH EDITION', cx, 600);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';

  ctx.font = `500 25px ${SERIF}`;
  ctx.fillText('R. Iyer  ·  M. Okafor', cx, 676);
  ctx.font = `600 16px ${SERIF}`;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '4px';
  ctx.fillText('MERIDIAN PRESS', cx, 722);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';

  return texture(c, { anisotropy: 8 });
}

/** The spine, drawn long: the book lies on the desk, so its title reads along the length. */
export function bookSpine() {
  const W = 1024;
  const H = 168;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#4e211f';
  ctx.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 3) {
    ctx.fillStyle = x % 6 === 0 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(x, 0, 1, H);
  }
  const foil = ctx.createLinearGradient(0, 0, 0, H);
  foil.addColorStop(0, '#f2d68c');
  foil.addColorStop(0.5, '#c9a15a');
  foil.addColorStop(1, '#8c6a2c');
  ctx.fillStyle = foil;
  // Raised bands.
  [22, H - 30].forEach((y) => {
    ctx.fillRect(40, y, W - 80, 4);
    ctx.fillRect(40, y + 9, W - 80, 2);
  });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 64px ${SERIF}`;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '8px';
  ctx.fillStyle = 'rgba(20,6,4,0.7)';
  ctx.fillText(BOOK_TITLE, W / 2 + 2, H / 2 + 3);
  ctx.fillStyle = foil;
  ctx.fillText(BOOK_TITLE, W / 2, H / 2);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
  ctx.font = `500 22px ${SERIF}`;
  ctx.fillText('Iyer · Okafor', 150, H / 2);
  ctx.fillText('5th ed.', W - 120, H / 2);
  return texture(c, { anisotropy: 8 });
}

const PROSE = [
  'The data link layer is responsible for moving frames from one node to the next',
  'over a single link. Its tasks include framing, error control and flow control,',
  'so that a fast sender cannot overwhelm a slow receiver. In the simplest scheme the',
  'sender transmits one frame and waits for an acknowledgement before sending another;',
  'efficiency suffers whenever the propagation delay is large compared with the time',
  'needed to put a frame on the wire. A sliding window lets several frames be',
  'outstanding at once. The sender keeps a copy of every unacknowledged frame, and',
  'the receiver accepts only frames that fall inside its window. When a frame is',
  'lost, Go-Back-N retransmits it and everything after it, while Selective Repeat',
  'retransmits only the frame that was lost, at the price of buffering at the receiver.',
];

/** A page of the book: running head, prose, a figure and a folio. `side` mirrors it. */
export function printedPage(side: 'left' | 'right' = 'right', seed = 23) {
  const W = 512;
  const H = 704;
  const [c, ctx] = canvas(W, H);
  const rand = seeded(seed + (side === 'left' ? 7 : 0));
  ctx.fillStyle = '#e9dfca';
  ctx.fillRect(0, 0, W, H);
  grain(ctx, rand, W, H, 0.07);
  // The gutter: pages curve down into the spine and take a little shade.
  const gx = side === 'right' ? 0 : W;
  const gutter = ctx.createLinearGradient(gx, 0, side === 'right' ? 90 : W - 90, 0);
  gutter.addColorStop(0, 'rgba(50,35,15,0.42)');
  gutter.addColorStop(1, 'rgba(50,35,15,0)');
  ctx.fillStyle = gutter;
  ctx.fillRect(0, 0, W, H);

  const inner = side === 'right' ? 62 : 44;
  const outer = side === 'right' ? W - 44 : W - 62;
  ctx.fillStyle = 'rgba(55,45,35,0.8)';
  ctx.font = `italic 400 14px ${SERIF}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = side === 'right' ? 'right' : 'left';
  ctx.fillText(
    side === 'right' ? 'SEC. 3.4   SLIDING WINDOW PROTOCOLS' : '184   THE DATA LINK LAYER',
    side === 'right' ? outer : inner,
    44,
  );
  ctx.strokeStyle = 'rgba(55,45,35,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(inner, 54);
  ctx.lineTo(outer, 54);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(40,32,24,0.9)';
  ctx.font = `700 22px ${SERIF}`;
  if (side === 'right') ctx.fillText('3.4  Sliding Window Protocols', inner, 98);

  ctx.font = `400 13.2px ${SERIF}`;
  ctx.fillStyle = 'rgba(40,32,24,0.82)';
  let y = side === 'right' ? 130 : 92;
  const bodyLines = side === 'right' ? 13 : 12;
  for (let l = 0; l < bodyLines; l += 1) {
    const text = PROSE[(l + (side === 'left' ? 4 : 0)) % PROSE.length];
    ctx.fillText(text.length > 62 ? text.slice(0, 62) : text, inner, y);
    y += 18.4;
  }

  // A figure: sender and receiver timelines with frames in flight.
  const fy = y + 14;
  ctx.strokeStyle = 'rgba(40,32,24,0.85)';
  ctx.fillStyle = 'rgba(40,32,24,0.85)';
  ctx.lineWidth = 1.4;
  const fx0 = inner + 40;
  const fx1 = outer - 40;
  ctx.beginPath();
  ctx.moveTo(fx0, fy);
  ctx.lineTo(fx0, fy + 170);
  ctx.moveTo(fx1, fy);
  ctx.lineTo(fx1, fy + 170);
  ctx.stroke();
  ctx.font = `600 12px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.fillText('Sender', fx0, fy - 6);
  ctx.fillText('Receiver', fx1, fy - 6);
  for (let i = 0; i < 4; i += 1) {
    const a = fy + 16 + i * 26;
    ctx.beginPath();
    ctx.moveTo(fx0, a);
    ctx.lineTo(fx1, a + 20);
    ctx.stroke();
    ctx.font = `500 11px ${SANS}`;
    ctx.fillText(`F${i}`, (fx0 + fx1) / 2 - 8, a + 4);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(fx1, a + 24);
    ctx.lineTo(fx0, a + 44);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.font = `italic 400 12px ${SERIF}`;
  ctx.fillText('Fig. 3-15.  A sliding window of size 4.', (inner + outer) / 2, fy + 196);

  ctx.textAlign = 'left';
  ctx.font = `400 13.2px ${SERIF}`;
  ctx.fillStyle = 'rgba(40,32,24,0.82)';
  y = fy + 228;
  for (let l = 0; l < 3; l += 1) {
    ctx.fillText(PROSE[(l + 2) % PROSE.length].slice(0, 62), inner, y);
    y += 18.4;
  }
  ctx.textAlign = side === 'right' ? 'right' : 'left';
  ctx.font = `500 14px ${SERIF}`;
  ctx.fillText(side === 'right' ? '185' : '184', side === 'right' ? outer : inner, H - 30);
  return texture(c, { anisotropy: 8 });
}

/** The edge of a stack of pages: fine, slightly irregular lines, a little browned. */
export function pageEdge() {
  const [c, ctx] = canvas(32, 256);
  const rand = seeded(11);
  ctx.fillStyle = '#e6dac0';
  ctx.fillRect(0, 0, 32, 256);
  for (let y = 0; y < 256; y += 2) {
    ctx.fillStyle = `rgba(120,100,70,${0.18 + rand() * 0.28})`;
    ctx.fillRect(0, y, 32, 1);
  }
  return texture(c, { repeat: true });
}

/** Speaker grille: rows of tiny dark holes on a transparent ground, laid over the aluminium. */
export function grilleTexture() {
  const [c, ctx] = canvas(32, 256);
  ctx.clearRect(0, 0, 32, 256);
  ctx.fillStyle = 'rgba(25,25,28,0.85)';
  for (let y = 4; y < 256; y += 8) {
    for (let x = 6; x < 32; x += 8) {
      ctx.beginPath();
      ctx.arc(x + ((y / 8) % 2 ? 4 : 0), y, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return texture(c, { anisotropy: 4 });
}

/** A soft diagonal glare, laid over the screen so the glass reads as glass. */
export function glareTexture() {
  const [c, ctx] = canvas(256, 160);
  const g = ctx.createLinearGradient(0, 0, 256, 160);
  g.addColorStop(0, 'rgba(255,255,255,0.0)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.25)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 160);
  return texture(c, { anisotropy: 2 });
}

/** A wisp of steam: a soft, lopsided puff. */
export function steamTexture() {
  const [c, ctx] = canvas(64, 128);
  const g = ctx.createRadialGradient(32, 64, 2, 32, 64, 46);
  g.addColorStop(0, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.translate(32, 64);
  ctx.scale(0.55, 1.35);
  ctx.translate(-32, -64);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 128);
  ctx.restore();
  return texture(c, { anisotropy: 1 });
}

const LABELS = ['CN', 'OS', 'DBMS', 'DSA', 'Maths', 'SE'];

/** The paper label on a notebook's cover: a subject, a ruled line for a name. */
export function notebookLabel(seed: number) {
  const [c, ctx] = canvas(256, 160);
  const rand = seeded(seed);
  ctx.fillStyle = '#efe8d8';
  ctx.fillRect(0, 0, 256, 160);
  grain(ctx, rand, 256, 160, 0.06);
  ctx.strokeStyle = 'rgba(40,40,60,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 244, 148);
  ctx.fillStyle = 'rgba(30,30,50,0.85)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 52px ${HAND}`;
  ctx.fillText(LABELS[Math.floor(rand() * LABELS.length)], 128, 82);
  ctx.font = `500 22px ${HAND}`;
  ctx.fillText('Notes', 128, 112);
  ctx.strokeStyle = 'rgba(30,30,50,0.5)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(40, 134);
  ctx.lineTo(216, 134);
  ctx.stroke();
  return texture(c, { anisotropy: 4 });
}
