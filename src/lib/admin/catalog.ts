import 'server-only';
import { prisma } from '@/lib/prisma';

/**
 * The full academic tree for the admin Notes section.
 *
 * One query set, one payload: the whole semester → subject → unit → topic → note
 * structure arrives together so content management is a single screen rather
 * than a trail of pages.
 */

export interface CatalogNote {
  id: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  visibility: 'FREE' | 'RESTRICTED';
  priceMinor: number;
  viewCount: number;
  fileSize: number;
  topicId: string | null;
  topicName: string | null;
  updatedAt: Date;
}

export interface CatalogTopic {
  id: string;
  name: string;
  noteCount: number;
}

export interface CatalogUnit {
  id: string;
  name: string;
  description: string | null;
  topics: CatalogTopic[];
  notes: CatalogNote[];
}

export interface CatalogSubject {
  id: string;
  name: string;
  code: string | null;
  slug: string;
  isArchived: boolean;
  units: CatalogUnit[];
  /** Notes filed directly under the subject with no unit. */
  looseNotes: CatalogNote[];
  noteCount: number;
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
          units: {
            orderBy: [{ position: 'asc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              description: true,
              topics: {
                orderBy: [{ position: 'asc' }, { name: 'asc' }],
                select: { id: true, name: true, _count: { select: { notes: true } } },
              },
              notes: {
                orderBy: [{ topic: { position: 'asc' } }, { title: 'asc' }],
                select: noteSelect,
              },
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
      const units = subject.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        description: unit.description,
        topics: unit.topics.map((topic) => ({
          id: topic.id,
          name: topic.name,
          noteCount: topic._count.notes,
        })),
        notes: unit.notes.map(shapeNote),
      }));

      const looseNotes = subject.notes.map(shapeNote);

      return {
        id: subject.id,
        name: subject.name,
        code: subject.code,
        slug: subject.slug,
        isArchived: subject.isArchived,
        units,
        looseNotes,
        noteCount: units.reduce((sum, unit) => sum + unit.notes.length, 0) + looseNotes.length,
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
  topicId: true,
  updatedAt: true,
  topic: { select: { name: true } },
} as const;

function shapeNote(note: {
  id: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  visibility: 'FREE' | 'RESTRICTED';
  priceMinor: number;
  viewCount: number;
  fileSize: number;
  topicId: string | null;
  updatedAt: Date;
  topic: { name: string } | null;
}): CatalogNote {
  return {
    id: note.id,
    title: note.title,
    status: note.status,
    visibility: note.visibility,
    priceMinor: note.priceMinor,
    viewCount: note.viewCount,
    fileSize: note.fileSize,
    topicId: note.topicId,
    topicName: note.topic?.name ?? null,
    updatedAt: note.updatedAt,
  };
}

/** Flat list of every place a note can be filed — used by pickers. */
export interface PlacementOption {
  subjectId: string;
  subjectLabel: string;
  units: { id: string; name: string; topics: { id: string; name: string }[] }[];
}

export function placementOptions(catalog: CatalogSemester[]): PlacementOption[] {
  return catalog.flatMap((semester) =>
    semester.subjects.map((subject) => ({
      subjectId: subject.id,
      subjectLabel: `${semester.name} · ${subject.name}`,
      units: subject.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        topics: unit.topics.map((topic) => ({ id: topic.id, name: topic.name })),
      })),
    })),
  );
}
