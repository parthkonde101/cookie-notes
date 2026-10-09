import * as THREE from 'three';
import { seeded } from '@/components/home/cinematic/math';
import {
  canvas,
  roundRect,
  texture,
  type Ctx,
  type PageSource,
} from '@/components/home/cinematic/scene/canvas-kit';

/**
 * Every surface in the scene that is not a flat colour is drawn here, once, on
 * a small 2D canvas. There are no image files for the room itself — only the
 * real note pages are loaded from `public/`.
 *
 * The two Cookie Notes screens are drawn in the product's own palette and
 * layout (see `src/app/globals.css` and the catalogue and reader components):
 * a dark warm background, caramel accent, notebook covers with a dark spine,
 * and a reader with back / zoom / page controls.
 */

export type { PageSource } from '@/components/home/cinematic/scene/canvas-kit';

/* ------------------------------------------------------------------ */
/* Room                                                                */
/* ------------------------------------------------------------------ */

/** Warm oak, with long soft grain. Used as both colour and bump. */
export function woodTexture() {
  const [c, ctx] = canvas(512, 512);
  const rand = seeded(11);
  ctx.fillStyle = '#8a5a38';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 220; i += 1) {
    const y = rand() * 512;
    const h = 1 + rand() * 6;
    const light = rand() > 0.5;
    ctx.fillStyle = light
      ? `rgba(220,168,108,${0.04 + rand() * 0.09})`
      : `rgba(58,30,14,${0.05 + rand() * 0.13})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) {
      ctx.lineTo(x, y + Math.sin(x * 0.011 + i) * 3.5 * rand());
    }
    ctx.lineTo(512, y + h);
    ctx.lineTo(0, y + h);
    ctx.closePath();
    ctx.fill();
  }
  // A few knots, so the surface is not a pattern.
  for (let k = 0; k < 2; k += 1) {
    const x = 80 + rand() * 350;
    const y = 60 + rand() * 380;
    const g = ctx.createRadialGradient(x, y, 1, x, y, 26);
    g.addColorStop(0, 'rgba(50,26,12,0.5)');
    g.addColorStop(1, 'rgba(50,26,12,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, 34, 12, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return texture(c, { repeat: true });
}

export function wallTexture() {
  const [c, ctx] = canvas(512, 256);
  const g = ctx.createRadialGradient(130, 150, 20, 256, 128, 340);
  g.addColorStop(0, '#2c2118');
  g.addColorStop(1, '#0e0b08');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  return texture(c);
}

/* ------------------------------------------------------------------ */
/* Laptop screens                                                      */
/* ------------------------------------------------------------------ */

export const SCREEN_W = 1280;
export const SCREEN_H = 800;

/** A real, long deck: dense slides, a deep thumbnail rail, a scrollbar that hardly moves. */
export function slidesScreen() {
  const [c, ctx] = canvas(SCREEN_W, SCREEN_H);
  const rand = seeded(5);

  ctx.fillStyle = '#26262b';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // Title bar.
  ctx.fillStyle = '#34343a';
  ctx.fillRect(0, 0, SCREEN_W, 44);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(26 + i * 24, 22, 7, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#b8b8c0';
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Data Link Layer — Lecture Slides', SCREEN_W / 2, 28);
  ctx.textAlign = 'left';

  // Thumbnail rail: lots of slides, and a thin scrollbar showing how many more.
  ctx.fillStyle = '#1f1f23';
  ctx.fillRect(0, 44, 230, SCREEN_H - 44 - 34);
  for (let i = 0; i < 9; i += 1) {
    const y = 62 + i * 82;
    if (i === 4) {
      ctx.strokeStyle = '#e09a42';
      ctx.lineWidth = 3;
      ctx.strokeRect(22, y - 3, 168, 76);
    }
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(25, y, 162, 70);
    ctx.fillStyle = '#34343a';
    ctx.fillRect(34, y + 8, 70, 7);
    for (let l = 0; l < 4; l += 1) {
      ctx.fillStyle = '#b9b6ad';
      ctx.fillRect(34, y + 24 + l * 11, 40 + rand() * 90, 4);
    }
    ctx.fillStyle = '#8a8a92';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(String(41 + i), 6, y + 14);
  }
  ctx.fillStyle = '#3a3a42';
  ctx.fillRect(218, 52, 6, SCREEN_H - 130);
  ctx.fillStyle = '#7d7d88';
  ctx.fillRect(218, 52 + (SCREEN_H - 130) * 0.32, 6, 34);

  // The slide.
  const sx = 280;
  const sy = 84;
  const sw = 940;
  const sh = 600;
  ctx.fillStyle = '#f7f4ee';
  ctx.fillRect(sx, sy, sw, sh);
  ctx.fillStyle = '#2d2d33';
  ctx.font = '700 30px system-ui, sans-serif';
  ctx.fillText('Flow control and error control', sx + 48, sy + 64);
  ctx.fillStyle = '#e09a42';
  ctx.fillRect(sx + 48, sy + 80, 120, 5);

  // Dense bullets, in real words small enough to feel like a lot.
  const bullets = [
    'Framing: character count, flag bytes, bit stuffing',
    'Error detection: parity, checksum, CRC',
    'Error correction: Hamming code, forward error correction',
    'Stop-and-wait: one frame, then wait for the acknowledgement',
    'Sliding window: several frames outstanding at once',
    'Go-Back-N: resend from the frame that was lost',
    'Selective repeat: resend only what was lost',
    'Window size and sequence numbers',
    'Piggybacking acknowledgements on data frames',
    'Efficiency, utilisation and the bandwidth–delay product',
    'Medium access: ALOHA, slotted ALOHA, CSMA',
    'CSMA/CD and the minimum frame size',
    'Collision-free protocols and token passing',
    'Limited-contention protocols',
    'Wireless LANs: hidden and exposed stations',
    'Ethernet: frame format and addressing',
    'Switches, bridges and learning tables',
  ];
  ctx.font = '500 17px system-ui, sans-serif';
  bullets.forEach((line, l) => {
    const indent = l % 5 === 0 ? 0 : 26;
    ctx.fillStyle = '#4a4a52';
    ctx.beginPath();
    ctx.arc(sx + 56 + indent, sy + 124 + l * 26 - 5, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4f4f58';
    ctx.fillText(line, sx + 70 + indent, sy + 124 + l * 26);
  });

  // A diagram on the right.
  const dx = sx + 620;
  ctx.strokeStyle = '#4a4a52';
  ctx.lineWidth = 3;
  for (let r = 0; r < 3; r += 1) {
    for (let k = 0; k < 2; k += 1) {
      const bx = dx + k * 150;
      const by = sy + 150 + r * 120;
      ctx.strokeRect(bx, by, 120, 64);
      ctx.fillStyle = '#d9d5cb';
      ctx.fillRect(bx + 14, by + 20, 92, 6);
      ctx.fillRect(bx + 14, by + 36, 56, 6);
    }
    if (r < 2) {
      ctx.beginPath();
      ctx.moveTo(dx + 60, sy + 214 + r * 120);
      ctx.lineTo(dx + 60, sy + 270 + r * 120);
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#9a9aa2';
  ctx.fillRect(sx + 48, sy + sh - 36, sw - 96, 4);

  // Status bar.
  ctx.fillStyle = '#34343a';
  ctx.fillRect(0, SCREEN_H - 34, SCREEN_W, 34);
  ctx.fillStyle = '#a8a8b0';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText('Slide 45 of 128', 18, SCREEN_H - 12);

  return texture(c, { anisotropy: 8 });
}

/* The product's own palette (see globals.css, dark theme). */
const BG = '#0f0d0b';
const CARD = '#171412';
const BORDER = '#302b27';
const FG = '#f4f2f0';
const MUTED = '#a79d93';
const PRIMARY = '#d29f60';
const ON_PRIMARY = '#1a1208';

function cookieMark(ctx: Ctx, x: number, y: number, r: number) {
  ctx.fillStyle = PRIMARY;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6b4220';
  [
    [-0.35, -0.3, 0.14],
    [0.32, -0.12, 0.12],
    [-0.1, 0.34, 0.13],
    [0.28, 0.34, 0.09],
    [-0.42, 0.15, 0.08],
  ].forEach(([dx, dy, dr]) => {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, dr * r, 0, Math.PI * 2);
    ctx.fill();
  });
}

/* ------------------------------------------------------------------ */
/* The live catalogue                                                  */
/* ------------------------------------------------------------------ */

interface CoverStyle {
  bg: string;
  line: string;
  letter: string;
}

/** The subjects as cookienotes.app lists them, with the colours of each uploaded cover. */
const LIVE_SHELF: {
  semester: string;
  subjects: { name: string; image: string; cover: CoverStyle }[];
}[] = [
  {
    semester: 'Semester 5',
    subjects: [
      {
        name: 'Artificial Intelligence & Expert Systems',
        image: '/home/covers/ai.webp',
        cover: { bg: '#7d2f79', line: 'rgba(255,230,250,0.62)', letter: '#ffffff' },
      },
      {
        name: 'Big Data Technologies',
        image: '/home/covers/bigdata.webp',
        cover: { bg: '#cfe38a', line: 'rgba(40,86,62,0.7)', letter: '#2c5a4b' },
      },
      {
        name: 'Computer Networks',
        image: '/home/covers/networks.webp',
        cover: { bg: '#2d6b58', line: 'rgba(214,240,228,0.55)', letter: '#ffffff' },
      },
      {
        name: 'Software Engineering & Management',
        image: '/home/covers/software.webp',
        cover: { bg: '#e8e8e6', line: 'rgba(20,20,20,0.75)', letter: '#0d0d0d' },
      },
    ],
  },
  {
    semester: 'Semester 6',
    subjects: [
      {
        name: 'Data Engineering & Data Visualisation',
        image: '/home/covers/dataeng.webp',
        cover: { bg: '#6b2447', line: 'rgba(255,205,222,0.62)', letter: '#ffffff' },
      },
      {
        name: 'Deep Learning',
        image: '/home/covers/deeplearning.webp',
        cover: { bg: '#7a3022', line: 'rgba(240,204,156,0.62)', letter: '#e6c58d' },
      },
      {
        name: 'Machine Learning',
        image: '/home/covers/ml.webp',
        cover: { bg: '#1d2a5e', line: 'rgba(184,212,255,0.7)', letter: '#ffffff' },
      },
    ],
  },
];

/** The wavy contour cover with its scattered G, O, O, D letters. */
function waveCover(ctx: Ctx, x: number, y: number, w: number, h: number, style: CoverStyle) {
  ctx.fillStyle = style.bg;
  ctx.fillRect(x, y, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Contour lines: long, slow waves that drift a little from one line to the next.
  const lines = 15;
  ctx.strokeStyle = style.line;
  ctx.lineWidth = Math.max(1, w / 170);
  for (let i = 0; i < lines; i += 1) {
    const base = y + (h * (i + 0.5)) / lines;
    ctx.beginPath();
    for (let px = 0; px <= w; px += 3) {
      const t = px / w;
      const wave =
        Math.sin(t * 7.2 + i * 0.34) * (h * 0.028) +
        Math.sin(t * 15 - i * 0.55) * (h * 0.012) +
        Math.sin(t * 2.4 + i * 0.12) * (h * 0.035);
      if (px === 0) ctx.moveTo(x + px, base + wave);
      else ctx.lineTo(x + px, base + wave);
    }
    ctx.stroke();
  }

  // The letters, bold and sans-serif, some running off the edge.
  ctx.fillStyle = style.letter;
  ctx.font = `800 ${Math.round(w * 0.17)}px system-ui, 'Helvetica Neue', Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  (
    [
      ['G', 0.14, 0.21],
      ['O', 0.71, 0.105],
      ['D', 0.95, 0.28],
      ['O', 0.34, 0.42],
      ['O', 0.0, 0.62],
      ['O', 0.72, 0.64],
      ['O', 0.3, 0.88],
      ['D', 0.9, 0.88],
    ] as const
  ).forEach(([ch, lx, ly]) => ctx.fillText(ch, x + lx * w, y + ly * h));
  ctx.restore();
}

/** Draws an image to fill a box, cropping the overflow — the way `object-cover` does. */
function coverImage(ctx: Ctx, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/** Wraps `text` into at most two lines, ending the second in "..." if it does not fit. */
function twoLines(ctx: Ctx, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i += 1) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= maxW) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === 1) {
      // Everything left goes on the second line; trim it if it overruns.
      let rest = words.slice(i).join(' ');
      if (ctx.measureText(rest).width > maxW) {
        while (rest.length > 1 && ctx.measureText(`${rest}...`).width > maxW)
          rest = rest.slice(0, -1);
        rest = `${rest.trimEnd()}...`;
      }
      lines.push(rest);
      return lines;
    }
  }
  lines.push(line);
  return lines;
}

/** The header cookienotes.app shows today: the mark and name on the left, sign-in on the right. */
function liveHeader(ctx: Ctx) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SCREEN_W, 64);
  ctx.fillStyle = BORDER;
  ctx.fillRect(0, 63, SCREEN_W, 1);

  ctx.fillStyle = CARD;
  roundRect(ctx, 64, 12, 40, 40, 10);
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();
  cookieMark(ctx, 84, 32, 11);
  ctx.fillStyle = FG;
  ctx.font = '600 17px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Cookie Notes', 116, 38);

  ctx.fillStyle = FG;
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.fillText('Sign in', 1010, 38);
  ctx.fillStyle = PRIMARY;
  roundRect(ctx, 1086, 14, 140, 36, 8);
  ctx.fill();
  ctx.fillStyle = ON_PRIMARY;
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Create account', 1156, 37);
  ctx.textAlign = 'left';
}

/**
 * The Cookie Notes catalogue, as cookienotes.app shows it: the hero, then each
 * semester's subjects as notebooks with their real covers. Computer Networks —
 * the notebook the story opens next — is the one under the pointer.
 */
export function shelfScreen() {
  const [c, ctx] = canvas(SCREEN_W, SCREEN_H);
  const tex = texture(c, { anisotropy: 8 });
  /** The real cover images, once they have loaded. Until then the redrawn covers stand in. */
  const covers = new Map<string, HTMLImageElement>();

  const draw = () => {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

    // A faint warm glow behind the hero.
    const glow = ctx.createRadialGradient(SCREEN_W * 0.3, 70, 10, SCREEN_W * 0.3, 70, 330);
    glow.addColorStop(0, 'rgba(210,159,96,0.11)');
    glow.addColorStop(1, 'rgba(210,159,96,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 64, SCREEN_W, 150);

    liveHeader(ctx);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = FG;
    ctx.font = '700 54px system-ui, sans-serif';
    ctx.fillText('Cookie Notes', 64, 138);
    ctx.fillStyle = MUTED;
    ctx.font = '400 22px system-ui, sans-serif';
    ctx.fillText('Baked for exams.', 64, 176);
    ctx.fillStyle = BORDER;
    ctx.fillRect(0, 208, SCREEN_W, 1);

    const cardW = 200;
    const gap = 24;
    const coverH = Math.round((cardW * 4) / 3);
    const labelH = 62;
    const cardH = coverH + labelH;
    const hoverIndex = 2; // Computer Networks, in Semester 5.

    let y = 256;
    LIVE_SHELF.forEach((section, si) => {
      ctx.fillStyle = FG;
      ctx.font = '600 22px system-ui, sans-serif';
      ctx.fillText(section.semester, 64, y);
      ctx.fillStyle = BORDER;
      ctx.fillRect(64, y + 14, SCREEN_W - 128, 1);

      const top = y + 40;
      section.subjects.forEach((subject, i) => {
        const x = 64 + i * (cardW + gap);
        const hovered = si === 0 && i === hoverIndex;
        const lift = hovered ? -3 : 0;
        const cy = top + lift;

        ctx.fillStyle = CARD;
        roundRect(ctx, x, cy, cardW, cardH, 8);
        ctx.fill();
        ctx.save();
        roundRect(ctx, x, cy, cardW, cardH, 8);
        ctx.clip();

        const photo = covers.get(subject.name);
        if (photo) coverImage(ctx, photo, x, cy, cardW, coverH);
        else waveCover(ctx, x, cy, cardW, coverH, subject.cover);

        // The binding.
        const spine = ctx.createLinearGradient(x, 0, x + 10, 0);
        spine.addColorStop(0, 'rgba(0,0,0,0.55)');
        spine.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = spine;
        ctx.fillRect(x, cy, 10, coverH);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(x + 10, cy, 1, coverH);

        // The label: the subject name, two lines at most.
        ctx.fillStyle = BORDER;
        ctx.fillRect(x, cy + coverH, cardW, 1);
        ctx.fillStyle = hovered ? PRIMARY : FG;
        ctx.font = '500 14.5px system-ui, sans-serif';
        ctx.textBaseline = 'alphabetic';
        twoLines(ctx, subject.name, cardW - 28).forEach((line, li) =>
          ctx.fillText(line, x + 14, cy + coverH + 26 + li * 20),
        );
        ctx.restore();

        ctx.strokeStyle = hovered ? 'rgba(210,159,96,0.7)' : BORDER;
        ctx.lineWidth = hovered ? 1.6 : 1;
        roundRect(ctx, x, cy, cardW, cardH, 8);
        ctx.stroke();
      });

      y = top + cardH + 50;
    });

    // The pointer, over Computer Networks.
    const px = 64 + hoverIndex * (cardW + gap) + 118;
    const py = 256 + 40 + 150;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px, py + 32);
    ctx.lineTo(px + 8, py + 25);
    ctx.lineTo(px + 14, py + 38);
    ctx.lineTo(px + 20, py + 35);
    ctx.lineTo(px + 14, py + 22);
    ctx.lineTo(px + 24, py + 21);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    tex.needsUpdate = true;
  };

  draw();
  if (typeof Image !== 'undefined') {
    LIVE_SHELF.forEach((section) =>
      section.subjects.forEach((subject) => {
        const img = new Image();
        img.onload = () => {
          covers.set(subject.name, img);
          draw();
        };
        img.src = subject.image;
      }),
    );
  }
  return tex;
}

/**
 * The reader, with a real note page open in it — same header controls as the
 * product (back, title, zoom, page). The page fits the width and runs off the
 * bottom, because that is how it scrolls.
 */

export function readerScreen(page?: PageSource) {
  const [c, ctx] = canvas(SCREEN_W, SCREEN_H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // Header.
  ctx.fillStyle = 'rgba(15,13,11,0.95)';
  ctx.fillRect(0, 0, SCREEN_W, 56);
  ctx.fillStyle = BORDER;
  ctx.fillRect(0, 55, SCREEN_W, 1);

  ctx.strokeStyle = FG;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(40, 28);
  ctx.lineTo(24, 28);
  ctx.moveTo(31, 21);
  ctx.lineTo(24, 28);
  ctx.lineTo(31, 35);
  ctx.stroke();

  ctx.fillStyle = FG;
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.fillText('Computer Networks', 64, 25);
  ctx.fillStyle = MUTED;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText('Unit 2', 64, 43);

  const control = (x: number, w: number, draw: () => void) => {
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    roundRect(ctx, x, 12, w, 32, 6);
    ctx.stroke();
    draw();
  };
  // Zoom: − 100% +
  control(870, 150, () => {
    ctx.fillStyle = FG;
    ctx.strokeStyle = FG;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(886, 28);
    ctx.lineTo(898, 28);
    ctx.moveTo(992, 28);
    ctx.lineTo(1004, 28);
    ctx.moveTo(998, 22);
    ctx.lineTo(998, 34);
    ctx.stroke();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('100%', 945, 32);
    ctx.textAlign = 'left';
  });
  // Page: ‹ 20 / 26 ›
  control(1040, 176, () => {
    ctx.strokeStyle = FG;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(1066, 22);
    ctx.lineTo(1058, 28);
    ctx.lineTo(1066, 34);
    ctx.moveTo(1190, 22);
    ctx.lineTo(1198, 28);
    ctx.lineTo(1190, 34);
    ctx.stroke();
    ctx.fillStyle = FG;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('20 / 26', 1128, 32);
    ctx.textAlign = 'left';
  });

  // The page, fitted to the width and cut by the window.
  const pw = 700;
  const px = (SCREEN_W - pw) / 2;
  const py = 84;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 57, SCREEN_W, SCREEN_H - 57);
  ctx.clip();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 24;
  ctx.fillStyle = CARD;
  ctx.fillRect(px, py, pw, 1000);
  ctx.shadowBlur = 0;
  if (page) {
    const ph = (pw * page.height) / page.width;
    ctx.drawImage(page, px, py, pw, ph);
  } else {
    ctx.fillStyle = '#211a14';
    ctx.fillRect(px, py, pw, 1000);
  }
  ctx.restore();

  // A scroll thumb.
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  roundRect(ctx, SCREEN_W - 10, 90, 4, 150, 2);
  ctx.fill();

  return texture(c, { anisotropy: 8 });
}
