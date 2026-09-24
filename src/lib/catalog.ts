import 'server-only';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import type { Program } from '@/lib/program';

/**
 * The public catalogue.
 *
 * Everyone — signed in or not, entitled or not — sees exactly the same academic
 * structure. Only PUBLISHED notes appear; drafts and archived material are
 * invisible outside the admin area. Nothing here exposes storage keys, file
 * names or any other detail that could be used to reach content directly.
 *
 * ## Program is a view, not a gate
 *
 * `catalogOverview` and `catalogTotals` take a program and draw that shelf.
 * That is *filtering*, in the same sense as `isArchived: false` — it decides
 * what is listed, never what may be opened. Any student can call either
 * function with either program, and `subjectCatalog` deliberately does not
 * filter by program at all: a Polytechnic subject opens from a B.Tech shelf,
 * from a pasted link, from anywhere. Access is `lib/access/entitlements.ts`'s
 * business and it has never heard of this enum.
 */

export interface CatalogNote {
  id: string;
  title: string;
  description: string | null;
  priceMinor: number;
  visibility: 'FREE' | 'RESTRICTED';
  pageCount: number | null;
  createdAt: Date;
  unitId: string | null;
  subjectId: string;
  semesterId: string;
  unitName: string | null;
  subjectName: string;
}

/**
 * A unit, as students see it: a number, a title, and the one PDF behind it.
 *
 * The unit *is* the item — there is no note listed underneath it — so `note`
 * carries only what opening it needs. A unit with nothing uploaded is still
 * returned, with `note: null`, so the notebook shows its full shape and a
 * student can see which units are still to come.
 */
export interface CatalogUnit {
  id: string;
  /** 1-based position in the notebook, used for the "Unit 3" label. */
  index: number;
  name: string;
  description: string | null;
  note: CatalogNote | null;
  /**
   * "Being Baked" — the notes are on the way. Only ever true while `note` is
   * null; a unit that has its PDF is simply available.
   */
  beingBaked: boolean;
}

const PUBLISHED = { status: 'PUBLISHED' as const };

/**
 * Semesters with their subjects and note counts — one program's shelf.
 *
 * Served by `semesters(program, isArchived, position)`, which is this query
 * read left to right.
 */
export async function catalogOverview(program: Program) {
  const semesters = await prisma.semester.findMany({
    where: { program, isArchived: false },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      subjects: {
        where: { isArchived: false },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          slug: true,
          code: true,
          description: true,
          coverStorageKey: true,
          coverUpdatedAt: true,
          _count: { select: { notes: { where: PUBLISHED }, pyqs: true } },
        },
      },
    },
  });

  // Hide semesters that would render as an empty shell. A subject counts as
  // having something to open if it has a published note *or* a past paper.
  return semesters
    .map((semester) => ({
      ...semester,
      subjects: semester.subjects
        .filter((subject) => subject._count.notes > 0 || subject._count.pyqs > 0)
        .map(({ _count, ...subject }) => ({
          ...subject,
          cover: coverUrl(subject.id, subject.coverStorageKey, subject.coverUpdatedAt),
        })),
    }))
    .filter((semester) => semester.subjects.length > 0);
}

/** Totals for the home page header, for the shelf being shown. */
export async function catalogTotals(program: Program) {
  const inProgram = { semester: { is: { program } } };
  const [notes, subjects, semesters] = await Promise.all([
    prisma.note.count({ where: { ...PUBLISHED, subject: { is: inProgram } } }),
    prisma.subject.count({ where: { ...inProgram, isArchived: false, notes: { some: PUBLISHED } } }),
    prisma.semester.count({
      where: { program, isArchived: false, subjects: { some: { notes: { some: PUBLISHED } } } },
    }),
  ]);
  return { notes, subjects, semesters };
}

/**
 * One subject: its units — each with at most one PDF — and its past papers.
 *
 * `notes.take: 1` is belt-and-braces rather than a filter. The database holds a
 * unique index on `notes."unitId"`, so a unit cannot have a second note; the
 * take exists so that a database which somehow predates that constraint renders
 * a sane page instead of a duplicated one.
 *
 * NOT FILTERED BY PROGRAM, on purpose. A subject opens from whichever shelf the
 * link came from. Its semester's program comes back with it only so the page
 * can keep the shelf choice in step — see `ProgramMemory`.
 */
export async function subjectCatalog(slug: string) {
  const subject = await prisma.subject.findFirst({
    where: { slug, isArchived: false },
    select: {
      id: true,
      name: true,
      slug: true,
      code: true,
      description: true,
      coverStorageKey: true,
      coverUpdatedAt: true,
      semester: { select: { id: true, name: true, slug: true, program: true } },
      pyqs: {
        // Latest year first: the paper a student wants is almost always the
        // most recent one.
        orderBy: { year: 'desc' },
        select: { id: true, year: true, label: true, pageCount: true },
      },
      units: {
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          beingBaked: true,
          notes: {
            where: PUBLISHED,
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: noteSelect,
          },
        },
      },
      notes: {
        where: { ...PUBLISHED, unitId: null },
        orderBy: { createdAt: 'asc' },
        select: noteSelect,
      },
    },
  });

  if (!subject) return null;

  const shape = (note: RawNote, unitName: string | null): CatalogNote => ({
    id: note.id,
    title: note.title,
    description: note.description,
    priceMinor: note.priceMinor,
    visibility: note.visibility,
    pageCount: note.pageCount,
    createdAt: note.createdAt,
    unitId: note.unitId,
    subjectId: subject.id,
    semesterId: subject.semester.id,
    unitName,
    subjectName: subject.name,
  });

  // Every unit is returned, uploaded or not, so the notebook shows its real
  // shape. Ordering is the admin's — `position`, then name — never "the ones
  // with a PDF first", which would make unit numbers jump around.
  const units: CatalogUnit[] = subject.units.map((unit, index) => {
    const note = unit.notes[0] ? shape(unit.notes[0], unit.name) : null;
    return {
      id: unit.id,
      index: index + 1,
      name: unit.name,
      description: unit.description,
      note,
      // A unit with its PDF is available, full stop — the flag cannot make an
      // available unit read as "still baking".
      beingBaked: note === null && unit.beingBaked,
    };
  });

  // Notes that belong to no unit. Nothing creates these any more — the upload
  // flow always attaches to a unit — but a catalogue built under the older model
  // may still hold some, and quietly hiding published material would be worse
  // than showing it.
  const looseNotes = subject.notes.map((note) => shape(note, null));

  return {
    id: subject.id,
    name: subject.name,
    slug: subject.slug,
    code: subject.code,
    description: subject.description,
    cover: coverUrl(subject.id, subject.coverStorageKey, subject.coverUpdatedAt),
    semester: subject.semester,
    pyqs: subject.pyqs,
    units,
    looseNotes,
    noteCount: units.filter((unit) => unit.note !== null).length + looseNotes.length,
  };
}

const noteSelect = {
  id: true,
  title: true,
  description: true,
  priceMinor: true,
  visibility: true,
  pageCount: true,
  createdAt: true,
  unitId: true,
} as const;

interface RawNote {
  id: string;
  title: string;
  description: string | null;
  priceMinor: number;
  visibility: 'FREE' | 'RESTRICTED';
  pageCount: number | null;
  createdAt: Date;
  unitId: string | null;
}

/**
 * Which of these units the viewer has asked to be notified about.
 *
 * Kept out of `subjectCatalog` on purpose: the catalogue is identical for
 * everyone, and this is the one piece of the page that is not. Returns an empty
 * set for a signed-out visitor, so the button simply reads "Notify me" until
 * they sign in.
 */
export async function subscribedUnitIds(
  userId: string | null,
  unitIds: string[],
): Promise<Set<string>> {
  if (!userId || unitIds.length === 0) return new Set();
  const rows = await prisma.unitNotificationSubscription.findMany({
    where: { userId, unitId: { in: unitIds } },
    select: { unitId: true },
  });
  return new Set(rows.map((row) => row.unitId));
}

/**
 * The application URL a notebook cover is served from, or null when the subject
 * has none and the UI should draw its own.
 *
 * The storage key never leaves the server: the browser only ever sees a subject
 * id. The `v` stamp changes when the cover is replaced, which is what makes the
 * long cache on that route safe.
 */
export function coverUrl(
  subjectId: string,
  coverStorageKey: string | null,
  coverUpdatedAt: Date | null,
): string | null {
  if (!coverStorageKey) return null;
  const version = coverUpdatedAt ? coverUpdatedAt.getTime() : 0;
  return `/api/subjects/${subjectId}/cover?v=${version}`;
}

/** Formats paise (or whatever the smallest unit is) for display. */
export function formatPrice(priceMinor: number): string {
  const symbol = env.catalog.currencySymbol;
  const major = priceMinor / 100;
  return `${symbol}${Number.isInteger(major) ? major : major.toFixed(2)}`;
}
