import 'server-only';
import { prisma } from '@/lib/prisma';
import { coverUrl } from '@/lib/catalog';

/**
 * The full academic tree for the admin Notes section.
 *
 * One query set, one payload: the whole semester → subject → unit → PDF
 * structure, plus each subject's past papers, arrives together so content
 * management is a single screen rather than a trail of pages.
 *
 * The shape mirrors what an admin is actually managing: one unit holds at most
 * one PDF, so a unit carries a single `note` rather than a list, and a unit with
 * `note: null` is one still waiting for an upload.
 */

export interface CatalogNote {
  id: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  visibility: 'FREE' | 'RESTRICTED';
  priceMinor: number;
  viewCount: number;
  fileSize: number;
  /** Shown so an admin can confirm which file is currently attached. */
  fileName: string;
  updatedAt: Date;
}

export interface CatalogUnit {
  id: string;
  /** 1-based position within the subject — the "3" in "Unit 3". */
  index: number;
  name: string;
  description: string | null;
  /** The unit's one PDF, or null when nothing has been uploaded to it. */
  note: CatalogNote | null;
}

export interface CatalogPyq {
  id: string;
  year: number;
  label: string | null;
  fileSize: number;
  updatedAt: Date;
}

export interface CatalogSubject {
  id: string;
  name: string;
  code: string | null;
  slug: string;
  isArchived: boolean;
  /** Application URL for the notebook cover, or null if none is set. */
  cover: string | null;
  units: CatalogUnit[];
  /**
   * Notes filed directly under the subject with no unit. Nothing creates these
   * any more, but a catalogue built under the older model may still hold some
   * and an admin needs to be able to see and manage them.
   */
  looseNotes: CatalogNote[];
  /** Previous-year papers, latest first. */
  pyqs: CatalogPyq[];
  /** Units that actually have a PDF, plus any loose notes. */
  noteCount: number;
  /** How many units are still waiting for a PDF. */
  missingCount: number;
}

export interface CatalogSemester {
  id: string;
  name: string;
  slug: string;
  isArchived: boolean;
  subjects: CatalogSubject[];
  noteCount: number;
}

export async function loadCatalogTree(): Promise<CatalogSemester[]> {
  const semesters = await prisma.semester.findMany({
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      isArchived: true,
      subjects: {
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          code: true,
          slug: true,
          isArchived: true,
          coverStorageKey: true,
          coverUpdatedAt: true,
          pyqs: {
            orderBy: { year: 'desc' },
            select: { id: true, year: true, label: true, fileSize: true, updatedAt: true },
          },
          units: {
            orderBy: [{ position: 'asc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              description: true,
              // At most one — the database holds a unique index on
              // notes."unitId". The take is here so a database that somehow
              // predates that constraint still renders sanely.
              notes: { orderBy: { createdAt: 'asc' }, take: 1, select: noteSelect },
            },
          },
          notes: {
            where: { unitId: null },
            orderBy: { title: 'asc' },
            select: noteSelect,
          },
        },
      },
    },
  });

  return semesters.map((semester) => {
    const subjects = semester.subjects.map((subject) => {
      const units: CatalogUnit[] = subject.units.map((unit, index) => ({
        id: unit.id,
        index: index + 1,
        name: unit.name,
        description: unit.description,
        note: unit.notes[0] ? shapeNote(unit.notes[0]) : null,
      }));

      const looseNotes = subject.notes.map(shapeNote);
      const uploaded = units.filter((unit) => unit.note !== null).length;

      return {
        id: subject.id,
        name: subject.name,
        code: subject.code,
        slug: subject.slug,
        isArchived: subject.isArchived,
        cover: coverUrl(subject.id, subject.coverStorageKey, subject.coverUpdatedAt),
        pyqs: subject.pyqs,
        units,
        looseNotes,
        noteCount: uploaded + looseNotes.length,
        missingCount: units.length - uploaded,
      };
    });

    return {
      id: semester.id,
      name: semester.name,
      slug: semester.slug,
      isArchived: semester.isArchived,
      subjects,
      noteCount: subjects.reduce((sum, subject) => sum + subject.noteCount, 0),
    };
  });
}

const noteSelect = {
  id: true,
  title: true,
  status: true,
  visibility: true,
  priceMinor: true,
  viewCount: true,
  fileSize: true,
  fileName: true,
  updatedAt: true,
} as const;

function shapeNote(note: CatalogNote): CatalogNote {
  return {
    id: note.id,
    title: note.title,
    status: note.status,
    visibility: note.visibility,
    priceMinor: note.priceMinor,
    viewCount: note.viewCount,
    fileSize: note.fileSize,
    fileName: note.fileName,
    updatedAt: note.updatedAt,
  };
}

/**
 * Flat list of every place a PDF can be filed — used by the upload picker.
 *
 * A unit already holding a PDF is still listed, marked `hasNote`, because
 * choosing it is how an admin replaces that PDF. The picker is subject → unit;
 * there is no third level.
 */
export interface PlacementOption {
  subjectId: string;
  subjectLabel: string;
  units: { id: string; index: number; name: string; hasNote: boolean }[];
}

export function placementOptions(catalog: CatalogSemester[]): PlacementOption[] {
  return catalog.flatMap((semester) =>
    semester.subjects.map((subject) => ({
      subjectId: subject.id,
      subjectLabel: `${semester.name} · ${subject.name}`,
      units: subject.units.map((unit) => ({
        id: unit.id,
        index: unit.index,
        name: unit.name,
        hasNote: unit.note !== null,
      })),
    })),
  );
}
