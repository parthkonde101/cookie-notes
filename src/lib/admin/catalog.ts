import 'server-only';
import { prisma } from '@/lib/prisma';
import { coverUrl } from '@/lib/catalog';
import { stripProgramPrefix, type Program } from '@/lib/program';

/**
 * The academic tree for the admin Notes section, for one program.
 *
 * One query set, one payload: the whole semester → subject → unit → PDF
 * structure, plus each subject's past papers, arrives together so content
 * management is a single screen rather than a trail of pages.
 *
 * The shape mirrors what an admin is actually managing: one unit holds at most
 * one PDF, so a unit carries a single `note` rather than a list, and a unit with
 * `note: null` is one still waiting for an upload.
 *
 * ## One program at a time
 *
 * The tree is scoped to a program and the two are managed independently. That
 * is not a permission — an admin switches with one click — it is what stops a
 * B.Tech unit from appearing in a Polytechnic upload picker, which is the
 * mistake that is actually easy to make. The server-side guard in
 * `_actions/notes.ts` and `api/admin/notes/route.ts` is what enforces it;
 * scoping the tree is what stops an admin having to notice.
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
  /** "Being Baked" — only ever true while `note` is null. */
  beingBaked: boolean;
  /** How many students asked to be told when this unit goes live. */
  subscriberCount: number;
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
  /** The program this semester — and therefore everything under it — is in. */
  program: Program;
  subjects: CatalogSubject[];
  noteCount: number;
}

/**
 * @param program Restricts the tree to one program. Omitted, every semester is
 *   returned — which is what the places that resolve a single id by hand want
 *   (a note's edit page, a user's access grants), since those already know
 *   exactly which row they are looking for and filtering would only let a
 *   correct id 404.
 */
export async function loadCatalogTree(program?: Program): Promise<CatalogSemester[]> {
  const semesters = await prisma.semester.findMany({
    where: program ? { program } : undefined,
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      isArchived: true,
      program: true,
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
              beingBaked: true,
              // A count, never the subscribers themselves: no student's identity
              // or email reaches the catalogue UI.
              _count: { select: { subscriptions: true } },
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
      const units: CatalogUnit[] = subject.units.map((unit, index) => {
        const note = unit.notes[0] ? shapeNote(unit.notes[0]) : null;
        return {
          id: unit.id,
          index: index + 1,
          name: unit.name,
          description: unit.description,
          note,
          // Belt and braces against a row that predates the invariant: a unit
          // holding a PDF never reads as being baked, whatever the column says.
          beingBaked: note === null && unit.beingBaked,
          subscriberCount: unit._count.subscriptions,
        };
      });

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
      program: semester.program,
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
 *
 * `program` rides along so the form can show which catalogue it is filing into
 * and refuse a placement from the other one. That is a convenience, not the
 * guarantee — the server re-derives the program from the chosen subject and
 * rejects a mismatch regardless of what the form sent.
 */
export interface PlacementOption {
  subjectId: string;
  subjectLabel: string;
  program: Program;
  units: { id: string; index: number; name: string; hasNote: boolean }[];
}

export function placementOptions(catalog: CatalogSemester[]): PlacementOption[] {
  return catalog.flatMap((semester) =>
    semester.subjects.map((subject) => ({
      subjectId: subject.id,
      // "Semester 1 · Machine Learning". The picker is already scoped to one
      // programme and the dialog says which, so the semester's own name does
      // not need to repeat it.
      subjectLabel: `${stripProgramPrefix(semester.name, semester.program)} · ${subject.name}`,
      program: semester.program,
      units: subject.units.map((unit) => ({
        id: unit.id,
        index: unit.index,
        name: unit.name,
        hasNote: unit.note !== null,
      })),
    })),
  );
}

/**
 * The program a subject's content belongs to, read straight from the database.
 *
 * THE SERVER-SIDE GUARD. Every write that files content under a subject calls
 * this and compares it with the program the request claims to be working in.
 * It never trusts a program submitted in a form — a stale admin tab, a
 * double-submit after switching, or a hand-made request would all otherwise
 * be able to file a Polytechnic PDF into the B.Tech catalogue, and nothing
 * downstream would notice because a note has no program of its own to check.
 *
 * Returns `null` when the subject does not exist, which the caller reports as
 * a missing subject rather than a mismatch.
 */
export async function subjectProgram(subjectId: string): Promise<Program | null> {
  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { semester: { select: { program: true } } },
  });
  return subject?.semester.program ?? null;
}
