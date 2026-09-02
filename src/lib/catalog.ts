import 'server-only';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';

/**
 * The public catalogue.
 *
 * Everyone — signed in or not, entitled or not — sees exactly the same academic
 * structure. Only PUBLISHED notes appear; drafts and archived material are
 * invisible outside the admin area. Nothing here exposes storage keys, file
 * names or any other detail that could be used to reach content directly.
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
  topicName: string | null;
  unitName: string | null;
  subjectName: string;
}

const PUBLISHED = { status: 'PUBLISHED' as const };

/** Semesters with their subjects and note counts — the home page. */
export async function catalogOverview() {
  const semesters = await prisma.semester.findMany({
    where: { isArchived: false },
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
          _count: { select: { notes: { where: PUBLISHED } } },
        },
      },
    },
  });

  // Hide semesters that would render as an empty shell.
  return semesters
    .map((semester) => ({
      ...semester,
      subjects: semester.subjects.filter((subject) => subject._count.notes > 0),
    }))
    .filter((semester) => semester.subjects.length > 0);
}

/** Totals for the home page header. */
export async function catalogTotals() {
  const [notes, subjects, semesters] = await Promise.all([
    prisma.note.count({ where: PUBLISHED }),
    prisma.subject.count({ where: { isArchived: false, notes: { some: PUBLISHED } } }),
    prisma.semester.count({
      where: { isArchived: false, subjects: { some: { notes: { some: PUBLISHED } } } },
    }),
  ]);
  return { notes, subjects, semesters };
}

/** One subject, with its units, topics and published notes. */
export async function subjectCatalog(slug: string) {
  const subject = await prisma.subject.findFirst({
    where: { slug, isArchived: false },
    select: {
      id: true,
      name: true,
      slug: true,
      code: true,
      description: true,
      semester: { select: { id: true, name: true, slug: true } },
      units: {
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          notes: {
            where: PUBLISHED,
            orderBy: [{ topic: { position: 'asc' } }, { createdAt: 'asc' }],
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
    topicName: note.topic?.name ?? null,
    unitName,
    subjectName: subject.name,
  });

  const units = subject.units
    .map((unit) => ({
      id: unit.id,
      name: unit.name,
      description: unit.description,
      notes: unit.notes.map((note) => shape(note, unit.name)),
    }))
    .filter((unit) => unit.notes.length > 0);

  const looseNotes = subject.notes.map((note) => shape(note, null));

  return {
    id: subject.id,
    name: subject.name,
    slug: subject.slug,
    code: subject.code,
    description: subject.description,
    semester: subject.semester,
    units,
    looseNotes,
    noteCount: units.reduce((sum, unit) => sum + unit.notes.length, 0) + looseNotes.length,
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
  topic: { select: { name: true } },
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
  topic: { name: string } | null;
}

/** Formats paise (or whatever the smallest unit is) for display. */
export function formatPrice(priceMinor: number): string {
  const symbol = env.catalog.currencySymbol;
  const major = priceMinor / 100;
  return `${symbol}${Number.isInteger(major) ? major : major.toFixed(2)}`;
}
