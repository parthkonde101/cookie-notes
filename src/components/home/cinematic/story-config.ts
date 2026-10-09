/**
 * The whole Home story, as data. Everything you would want to tune — where the
 * camera is, when a line of text appears, when the book opens, how bright the
 * room gets — is a number in this file. The scene and the overlay only read it.
 *
 * `progress` runs 0 → 1 across the scroll. Scene positions are in the scene's
 * own units (about metres): the desk top is y = 0, the student sits on the +z
 * side facing -z, and the laptop is at the middle of the desk facing the student.
 *
 * The film is built as ARRIVE → HOLD → TRAVEL. Each beat has two nearly
 * identical shots, one where the camera arrives and one where it is about to
 * leave; between them it hardly moves, so the words can be read. The camera
 * only travels in the gaps between beats.
 */

export type Vec3 = [number, number, number];

/* ------------------------------------------------------------------ */
/* Scroll                                                              */
/* ------------------------------------------------------------------ */

/** Height of the scroll track, in viewport heights. More = a slower film. */
export const SCROLL_HEIGHT_VH = 900;

/** Fraction of the scroll, at the very end, spent holding on the final frame. */
export const HOLD_END = 0.04;

/**
 * About how long, in seconds, the film takes to settle onto the scrollbar. It
 * follows it the way a heavy object would be dragged: critically damped, so it
 * accelerates gently, never overshoots, and its speed is always continuous —
 * a discrete wheel notch becomes a smooth push, not a jolt. Longer = heavier.
 */
export const SMOOTH_TIME = 0.3;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export interface Shot {
  /** Progress at which the camera is exactly here. */
  at: number;
  position: Vec3;
  /** What the camera looks at. On a wide screen this is nudged off the subject to leave room for the words. */
  target: Vec3;
  /** Where the subject really is — what a narrow screen (words above it) aims at instead. */
  focus?: Vec3;
  /**
   * On a narrow screen, how far to move the subject down the frame to make
   * room for the words above it, as a fraction of the frame's height. More
   * words need more room.
   */
  lift?: number;
  /**
   * On a narrow screen, how far back to stand relative to the standard
   * compensation: above 1 to fit a wide subject in, below 1 to close in on a
   * small one.
   */
  fit?: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /**
   * 0 = move at constant speed through this shot, 1 = come to a full stop on it.
   * Every shot in the film is 1: each move starts and ends at rest, so there is
   * never a lurch at a keyframe. Anything less makes the speed on either side of
   * a key disagree.
   */
  dwell?: number;
}

/** Mobile composition shared by the two shots of a beat. */
const M = {
  desk: { focus: [0, 0.15, 0.4] as Vec3, lift: 0.12, fit: 0.75 },
  laptop: { focus: [0, 0.15, 0.1] as Vec3, lift: 0.08, fit: 1.35 },
  book: { focus: [-0.85, 0.05, 0.1] as Vec3, lift: 0.22, fit: 1.12 },
  pile: { focus: [0.8, 0.04, 0.15] as Vec3, lift: 0.2, fit: 1.1 },
  calm: { focus: [0, 0.1, 0.3] as Vec3, lift: 0.18, fit: 0.8 },
  reveal: { focus: [0, 0.12, 0.0] as Vec3, lift: 0.3, fit: 1.3 },
  screen: { focus: [0, 0.3, 0.1] as Vec3, lift: 0, fit: 1.15 },
  page: { focus: [0, 0.38, 0.3] as Vec3, lift: 0, fit: 1.75 },
  final: { focus: [0, 0.1, 0.45] as Vec3, lift: 0.2, fit: 0.85 },
};

export const SHOTS: Shot[] = [
  // 1 · The question. Wide, from behind and to the side. The aim sits left of
  //     the desk so the student lands right of the words. Holds, drifting.
  { at: 0.0, position: [2.9, 1.3, 3.5], target: [-0.45, 0.2, 0.7], fov: 38, dwell: 1, ...M.desk },
  {
    at: 0.095,
    position: [2.72, 1.27, 3.3],
    target: [-0.42, 0.2, 0.65],
    fov: 37.5,
    dwell: 1,
    ...M.desk,
  },
  // 2 · PPTs. Over the shoulder from the right, high enough that the head
  //     clears the screen; the laptop sits right of the words. Holds.
  {
    at: 0.185,
    position: [1.2, 1.28, 2.6],
    target: [-0.5, 0.2, 0.17],
    fov: 30,
    dwell: 1,
    ...M.laptop,
  },
  {
    at: 0.295,
    position: [1.1, 1.24, 2.48],
    target: [-0.48, 0.2, 0.15],
    fov: 29.5,
    dwell: 1,
    ...M.laptop,
  },
  // 3 · The reference book. Travels left and low enough to feel the book's
  //     scale beside the laptop, then holds while it opens.
  {
    at: 0.36,
    position: [-0.3, 1.12, 2.25],
    target: [-0.55, 0.14, 0.1],
    fov: 34,
    dwell: 1,
    ...M.book,
  },
  {
    at: 0.47,
    position: [-0.42, 1.04, 2.0],
    target: [-0.58, 0.13, 0.1],
    fov: 33,
    dwell: 1,
    ...M.book,
  },
  // 4 · Class notes. Across to the pile, then a slow push up and in as it
  //     builds, so the desk closes round the viewer.
  {
    at: 0.54,
    position: [1.7, 1.1, 1.95],
    target: [0.58, 0.04, 0.15],
    fov: 36,
    dwell: 1,
    ...M.pile,
  },
  {
    at: 0.625,
    position: [1.42, 1.4, 1.72],
    target: [0.55, 0.02, 0.15],
    fov: 36,
    dwell: 1,
    ...M.pile,
  },
  // 5 · "There's a simpler way." The camera glides out of the peak and comes to
  //     rest on one calm, wide pose. The two shots below are the SAME pose, so
  //     it is a hold: nothing in the camera moves while the line is read. Both
  //     moves either side of it start and stop at rest (`dwell: 1`).
  { at: 0.695, position: [2.4, 1.5, 3.1], target: [0, 0.15, 0.3], fov: 38, dwell: 1, ...M.calm },
  { at: 0.748, position: [2.4, 1.5, 3.1], target: [0, 0.15, 0.3], fov: 38, dwell: 1, ...M.calm },
  // 6 · Cookie Notes. Back over the shoulder; the laptop right of the words.
  {
    at: 0.79,
    position: [1.3, 1.4, 2.5],
    target: [-0.72, 0.18, 0.15],
    fov: 30,
    dwell: 1,
    ...M.reveal,
  },
  {
    at: 0.845,
    position: [1.2, 1.36, 2.32],
    target: [-0.68, 0.2, 0.12],
    fov: 29,
    dwell: 1,
    ...M.reveal,
  },
  // 7 · Into the notes. Close on the screen from above and behind the head,
  //     then in on the page as it rises, then across its diagram. The camera
  //     comes in from the right so the student's head is never in the way.
  {
    at: 0.885,
    position: [0.7, 1.25, 1.7],
    target: [0.02, 0.33, 0.12],
    fov: 32,
    dwell: 1,
    ...M.screen,
  },
  {
    at: 0.918,
    position: [1.45, 1.08, 1.3],
    target: [0.06, 0.4, 0.25],
    fov: 28,
    dwell: 1,
    ...M.page,
  },
  {
    at: 0.934,
    position: [1.55, 1.0, 1.25],
    target: [0.08, 0.31, 0.25],
    fov: 27,
    dwell: 1,
    ...M.page,
  },
  {
    at: 0.943,
    position: [1.55, 1.0, 1.25],
    target: [0.08, 0.31, 0.25],
    fov: 27,
    dwell: 1,
    ...M.page,
  },
  // Final. Pulled right back, from the side, to see the student studying. The
  //        aim sits high so the scene lands low, under the title. The pull-back
  //        is the longest move in the film, so it gets the longest run: it
  //        starts as the notes hold ends and settles into place over the very
  //        end, where the last frame is then held.
  { at: 1.0, position: [-3.1, 1.0, 1.9], target: [0, 0.95, 0.45], fov: 38, dwell: 1, ...M.final },
];

/* ------------------------------------------------------------------ */
/* Scene cues — when things in the world happen                        */
/* ------------------------------------------------------------------ */

/**
 * How the student sits back when the notes rise. The chair's back tilts by the same
 * angle he leans, so he rests against it, and the chair rolls back with him.
 */
export const SIT_BACK = {
  /** Radians back from upright. */
  recline: 0.28,
  /** Metres the chair (and he) roll back. */
  slide: 0.04,
};

/**
 * Where the film comes to rest: one point per topic, with its words fully on
 * screen and the camera still. When the viewer stops scrolling, the film glides
 * on to the next of these in the direction they were going, so nobody has to
 * scroll in a careful rhythm to see each moment properly.
 */
export const STOPS = [0, 0.24, 0.44, 0.61, 0.73, 0.846, 0.946, 1] as const;

export const SETTLE = {
  /** How long the scroll must be still before the film takes over, in ms. */
  idleMs: 230,
  /** A nudge smaller than this (in progress) returns to where it was. */
  minPush: 0.01,
  /** The glide lasts this long for a short hop… */
  glideMin: 650,
  /** …and this much longer for the longest one (a quarter of the film). */
  glideExtra: 1500,
};

export const CUES = {
  /** The reference book swings open, leaf by leaf. */
  bookOpen: [0.35, 0.45] as const,
  /** …and shuts again before it goes. */
  bookClose: [0.62, 0.655] as const,
  /** The class-notes clutter builds, a piece at a time. */
  clutterIn: [0.49, 0.62] as const,
  /** Everything that isn't the laptop clears away, a piece at a time. */
  clutterOut: [0.635, 0.695] as const,
  /** The room goes from busy and amber to clear and calm. */
  clarity: [0.645, 0.7] as const,
  /** The laptop screen goes from slides to the Cookie Notes shelf… */
  screenShelf: [0.77, 0.8] as const,
  /** …and from the shelf to an open notebook. */
  screenReader: [0.858, 0.885] as const,
  /** The student sits back and takes his hands off the keys as the notes rise toward him. */
  sitBack: [0.872, 0.915] as const,
  /** Page 20 lifts out of the screen. */
  heroEmerge: [0.885, 0.918] as const,
  /** The other pages open out around it, one after another. */
  supportStart: 0.905,
  supportStagger: 0.005,
  supportFlight: 0.02,
  /** Everything folds back into the screen as the camera pulls away. */
  pagesFold: [0.964, 0.985] as const,
  /**
   * The camera's hand-held drift is switched off between these: it fades out
   * across the first pair and back in across the second. It is the one thing
   * that keeps a held frame from being dead still, and for "There's a simpler
   * way." and the glide into the reveal, dead still is the point.
   */
  driftOff: [
    [0.605, 0.64],
    [0.79, 0.82],
  ] as const,
  /** The student's head turns toward whatever the camera is looking at. */
  lookBook: [0.34, 0.42] as const,
  lookBookEnd: [0.47, 0.53] as const,
  lookNotes: [0.52, 0.58] as const,
  lookReset: [0.64, 0.695] as const,
};

/* ------------------------------------------------------------------ */
/* Light — evening, then clarity                                       */
/* ------------------------------------------------------------------ */

/** `[before, after]` the clarity cue: the busy amber evening, then the clear reveal. */
export const LIGHT = {
  ambient: [0.26, 0.42] as const,
  hemisphere: [0.34, 0.5] as const,
  key: [1.15, 1.55] as const,
  lamp: [3.6, 4.7] as const,
  /** Fill is pulled down a little while the clutter peaks, so the desk feels heavier. */
  clutterDim: 0.1,
  /** How much the reflections in the room are allowed to show. */
  environment: 0.16,
  /** The laptop's own light on the student's hands and face; it brightens once Cookie Notes is up. */
  screen: [0.1, 0.22] as const,
  /** A low warm light from across the desk that edges the blazer against the dark wall. */
  rim: 0.14,
};

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export interface BeatLine {
  text: string;
  /** Progress at which this line appears, if later than the block. */
  at?: number;
  tone?: 'headline' | 'support' | 'list' | 'brand' | 'tagline';
}

export interface Beat {
  id: string;
  /** Fades in across the first pair, and out across the second. Both sit inside the camera's hold. */
  in: [number, number];
  out: [number, number];
  /**
   * Where it sits on a wide screen. `upper-*` keeps the words up on the dark
   * wall, clear of the student, when the middle of the frame is busy. On a
   * phone every beat sits across the top, above the scene.
   */
  place: 'left' | 'right' | 'top' | 'upper-left' | 'upper-right';
  /**
   * How much the scene is darkened, softly and without an edge, just behind
   * this beat's words (0–1). Tuned per beat: bright wood and paper need more
   * than a dark wall does.
   */
  scrim: number;
  lines: BeatLine[];
}

const NEVER: [number, number] = [2, 2];

export const BEATS: Beat[] = [
  {
    id: 'question',
    in: [-1, 0],
    out: [0.075, 0.115],
    place: 'left',
    scrim: 0.55,
    lines: [{ text: 'How do you study for exams?', tone: 'headline' }],
  },
  {
    id: 'ppts',
    in: [0.17, 0.205],
    out: [0.285, 0.318],
    place: 'upper-left',
    scrim: 0.6,
    lines: [{ text: 'Do you study lengthy PPTs?', tone: 'headline' }],
  },
  {
    id: 'books',
    in: [0.345, 0.38],
    out: [0.46, 0.495],
    place: 'upper-right',
    scrim: 0.65,
    lines: [{ text: 'Or do you go through huge reference books?', tone: 'headline' }],
  },
  {
    id: 'class-notes',
    in: [0.5, 0.535],
    out: [0.66, 0.692],
    place: 'upper-right',
    scrim: 0.7,
    lines: [
      { text: 'Or do you refer to the notes taken in class?', tone: 'headline' },
      { text: 'Which are never quite consistent.', tone: 'support', at: 0.585 },
    ],
  },
  {
    id: 'simpler',
    in: [0.7, 0.727],
    out: [0.742, 0.766],
    place: 'top',
    scrim: 0.4,
    lines: [{ text: 'There’s a simpler way.', tone: 'headline' }],
  },
  {
    id: 'cookie-notes',
    in: [0.785, 0.805],
    out: [0.855, 0.88],
    place: 'upper-left',
    scrim: 0.65,
    lines: [
      {
        text: 'Here at Cookie Notes, you’ll find the\nhandwritten notes you need.',
        tone: 'support',
      },
      { text: 'Focussed on important topics.', tone: 'list', at: 0.806 },
      { text: 'Based on your syllabus.', tone: 'list', at: 0.821 },
      { text: '& previous-year questions.', tone: 'list', at: 0.836 },
    ],
  },
  {
    id: 'final',
    in: [0.97, 0.99],
    out: NEVER,
    place: 'top',
    scrim: 0.5,
    lines: [
      { text: 'Cookie Notes', tone: 'brand' },
      { text: 'Baked for exams.', tone: 'tagline', at: 0.98 },
    ],
  },
];

/** The primary call to action, shown with the final beat. */
export const CTA = { label: 'Explore Cookie Notes', href: '/catalog', at: 0.985 };

/* ------------------------------------------------------------------ */
/* The real notes                                                      */
/* ------------------------------------------------------------------ */

/** Where a page sits once it has opened out, in scene units. Rotations in radians. */
export interface PagePose {
  position: Vec3;
  /** Tilt toward the camera. */
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  scale: number;
  /** 0–1: how much of its own brightness a supporting page keeps. */
  brightness: number;
}

export interface NotePage {
  page: number;
  title: string;
  src: string;
  /** The one that gets its own moment. */
  hero?: boolean;
  pose: PagePose;
}

/**
 * Pages 17–22 of the Computer Networks Unit 2 sample, rendered to small WebP
 * files in `public/home/notes/`. They are loaded only when the story gets
 * near the part that shows them.
 *
 * Page 20 — the Sliding Window diagram — is the hero: it rises first, large,
 * facing the camera. The others open out around it, smaller, angled in and
 * dimmer, so the eye stays on the diagram.
 */
export const NOTE_PAGES: NotePage[] = [
  {
    page: 17,
    title: 'Simple & Stop-and-Wait Protocol',
    src: '/home/notes/p17.webp',
    pose: {
      position: [-0.38, 0.3, 0.3],
      rotateX: -0.4,
      rotateY: 0.55,
      rotateZ: 0.06,
      scale: 0.8,
      brightness: 0.55,
    },
  },
  {
    page: 18,
    title: 'Stop-and-Wait ARQ',
    src: '/home/notes/p18.webp',
    pose: {
      position: [-0.3, 0.55, 0.2],
      rotateX: -0.4,
      rotateY: 0.4,
      rotateZ: 0.04,
      scale: 0.72,
      brightness: 0.5,
    },
  },
  {
    page: 19,
    title: 'Go-Back-N ARQ',
    src: '/home/notes/p19.webp',
    pose: {
      position: [-0.43, 0.13, 0.36],
      rotateX: -0.4,
      rotateY: 0.5,
      rotateZ: -0.04,
      scale: 0.7,
      brightness: 0.5,
    },
  },
  {
    page: 20,
    title: 'Sliding Window Protocol',
    src: '/home/notes/p20.webp',
    hero: true,
    pose: {
      position: [0, 0.42, 0.24],
      rotateX: -0.5,
      rotateY: 0.38,
      rotateZ: 0,
      scale: 1.5,
      brightness: 1,
    },
  },
  {
    page: 21,
    title: 'Selective Repeat ARQ',
    src: '/home/notes/p21.webp',
    pose: {
      position: [0.4, 0.3, 0.3],
      rotateX: -0.4,
      rotateY: -0.5,
      rotateZ: -0.06,
      scale: 0.8,
      brightness: 0.55,
    },
  },
  {
    page: 22,
    title: 'Channel Allocation',
    src: '/home/notes/p22.webp',
    pose: {
      position: [0.32, 0.55, 0.2],
      rotateX: -0.4,
      rotateY: -0.4,
      rotateZ: -0.04,
      scale: 0.72,
      brightness: 0.5,
    },
  },
];

/** Progress at which the page images start downloading. */
export const PAGES_PRELOAD_AT = 0.55;

/* ------------------------------------------------------------------ */
/* Palette (fixed — the stage is a lit room, not themed UI)             */
/* ------------------------------------------------------------------ */

export const PALETTE = {
  room: '#0d0b09',
  cream: '#f3ebdf',
  muted: '#b9ac9a',
  caramel: '#d6a05a',
};
