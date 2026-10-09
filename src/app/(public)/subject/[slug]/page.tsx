import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { NoteCard, type CardAccessState } from '@/components/catalog/note-card';
import { UnitRow } from '@/components/catalog/unit-card';
import { ProgramMemory } from '@/components/catalog/program-memory';
import { subjectCatalog, subscribedUnitIds, type CatalogNote } from '@/lib/catalog';
import { PROGRAM_PARAM, programLabel, stripProgramPrefix } from '@/lib/program';
import { optionalUser } from '@/lib/auth/guards';
import { resolveNoteAccessStates } from '@/lib/access/entitlements';
import { recordEvent } from '@/lib/analytics/events';
import { requestContext } from '@/lib/request';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const subject = await subjectCatalog(slug);
  return {
    title: subject ? `${subject.name} notes` : 'Subject',
    description: subject?.description ?? undefined,
  };
}

/**
 * A subject, opened.
 *
 * The page reads as the inside of the notebook whose cover was clicked: the
 * cover sits in the header so the object is continuous, then the contents —
 * units, then past papers.
 *
 * One unit is one PDF, so a unit is a line in the table of contents that you
 * open rather than a heading with files under it. A subject has only a handful
 * of units, so they are a numbered list, not a grid. Past papers keep their own shape — a subject's papers belong
 * to the subject as a whole, not to any unit — and are listed latest year first.
 *
 * Public: the structure is visible to anyone. Only the action on each card
 * differs, and opening anything still goes through the full server-side
 * authorisation chain.
 */
export default async function SubjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const subject = await subjectCatalog(slug);
  if (!subject) notFound();

  const auth = await optionalUser();

  const allNotes: CatalogNote[] = [
    ...subject.looseNotes,
    ...subject.units.flatMap((unit) => (unit.note ? [unit.note] : [])),
  ];

  // Only the units still waiting for a PDF can carry a reminder, so that is all
  // we look up.
  const subscribed = await subscribedUnitIds(
    auth?.user.id ?? null,
    subject.units.filter((unit) => unit.beingBaked).map((unit) => unit.id),
  );

  const states = await resolveNoteAccessStates(
    auth ? { id: auth.user.id, role: auth.user.role } : null,
    allNotes.map((note) => ({
      id: note.id,
      visibility: note.visibility,
      unitId: note.unitId,
      subjectId: note.subjectId,
      semesterId: note.semesterId,
    })),
  );

  await recordEvent({
    type: 'SUBJECT_OPENED',
    userId: auth?.user.id ?? null,
    sessionId: auth?.session.id ?? null,
    subjectId: subject.id,
    ctx: await requestContext(),
  });

  const renderNote = (note: CatalogNote) => (
    <NoteCard
      key={note.id}
      id={note.id}
      title={note.title}
      description={note.description}
      context={note.unitName}
      pageCount={note.pageCount}
      access={(states.get(note.id) ?? { kind: 'sign_in_required' }) as CardAccessState}
    />
  );

  const hasContents =
    subject.units.length > 0 || subject.looseNotes.length > 0 || subject.pyqs.length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/*
       * Records which shelf this subject belongs to, so going back to the
       * catalogue lands on the right one even when the page was reached from a
       * shared link. Writes a cookie and renders nothing; it grants nothing and
       * restricts nothing.
       */}
      <ProgramMemory program={subject.semester.program} />

      <Link
        href={`/?${PROGRAM_PARAM}=${subject.semester.program}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All {programLabel(subject.semester.program)} notebooks
      </Link>

      {/* Notebook header — the cover, then the identity. */}
      <header className="mt-4 flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-start sm:gap-6">
        <div className="relative aspect-[3/4] w-24 shrink-0 overflow-hidden rounded-md border border-border bg-muted shadow-md sm:w-32">
          {subject.cover ? (
            <Image
              src={subject.cover}
              alt={`Cover of the ${subject.name} notebook`}
              fill
              sizes="128px"
              className="object-cover"
              priority
            />
          ) : (
            <div
              aria-hidden
              className="h-full w-full bg-gradient-to-br from-primary/25 to-primary/5"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(to bottom,transparent 0 15px,hsl(0 0% 100% / 0.05) 15px 16px)',
              }}
            />
          )}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-black/55 to-transparent"
          />
        </div>

        <div className="min-w-0 flex-1">
          {/*
           * "Semester 1", not "B.Tech Semester 1" — the back link directly
           * above already names the programme, and saying it twice in adjacent
           * lines is the repetition this page had.
           */}
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            {stripProgramPrefix(subject.semester.name, subject.semester.program)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-pretty text-2xl font-semibold tracking-tight sm:text-3xl">
              {subject.name}
            </h1>
            {subject.code && <Badge variant="outline">{subject.code}</Badge>}
          </div>
          {subject.description && (
            <p className="mt-3 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
              {subject.description}
            </p>
          )}
        </div>
      </header>

      {!hasContents ? (
        <EmptyState
          className="mt-10"
          icon={FileText}
          title="Nothing in this notebook yet"
          description="This subject is in the catalogue but nothing has been published to it so far."
        />
      ) : (
        <div className="mt-8 space-y-12">
          {/* Loose notes, if any, come before the units. */}
          {subject.looseNotes.length > 0 && (
            <section>
              <SectionHeading>General</SectionHeading>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {subject.looseNotes.map(renderNote)}
              </div>
            </section>
          )}

          {subject.units.length > 0 && (
            <section>
              <SectionHeading
                aside={
                  <UnitProgress
                    ready={subject.units.filter((unit) => unit.note !== null).length}
                    total={subject.units.length}
                    states={subject.units.map((unit) => unit.note !== null)}
                  />
                }
              >
                Units
              </SectionHeading>
              {/* One ruled surface, like the contents page of a book. */}
              <ol className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {subject.units.map((unit) => (
                  <UnitRow
                    key={unit.id}
                    unitId={unit.id}
                    index={unit.index}
                    name={unit.name}
                    description={unit.description}
                    beingBaked={unit.beingBaked}
                    subscribed={subscribed.has(unit.id)}
                    note={
                      unit.note
                        ? {
                            id: unit.note.id,
                            access: (states.get(unit.note.id) ?? {
                              kind: 'sign_in_required',
                            }) as CardAccessState,
                          }
                        : null
                    }
                  />
                ))}
              </ol>
            </section>
          )}

          {subject.pyqs.length > 0 && (
            <section>
              <SectionHeading
                aside={
                  <span className="text-xs text-muted-foreground">
                    {subject.pyqs.length} {subject.pyqs.length === 1 ? 'paper' : 'papers'} · latest
                    first
                  </span>
                }
              >
                Previous Year Questions
              </SectionHeading>
              {/* Latest year first — ordered in the query, not here. Two columns
                  from `md`; the 1px gap over a ruled background draws the lines
                  between papers, and a filler cell keeps an odd count tidy. */}
              <ul
                className={`mt-4 grid gap-px overflow-hidden rounded-xl border border-border bg-border ${
                  subject.pyqs.length > 1 ? 'md:grid-cols-2' : ''
                }`}
              >
                {subject.pyqs.map((pyq, position) => (
                  <PyqRow
                    key={pyq.id}
                    id={pyq.id}
                    year={pyq.year}
                    label={pyq.label}
                    latest={position === 0}
                  />
                ))}
                {subject.pyqs.length > 1 && subject.pyqs.length % 2 === 1 && (
                  <li aria-hidden className="hidden bg-card md:block" />
                )}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function SectionHeading({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-base font-semibold tracking-tight">{children}</h2>
      <span aria-hidden className="h-px flex-1 bg-border" />
      {aside}
    </div>
  );
}

/**
 * How much of the notebook is ready, as one segment per unit. A subject has
 * five units, so five segments read at a glance: filled for a unit with its
 * notes, outlined for one still to come.
 */
function UnitProgress({
  ready,
  total,
  states,
}: {
  ready: number;
  total: number;
  states: boolean[];
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-xs text-muted-foreground">
        <span className="font-medium tabular-nums text-foreground">{ready}</span> of {total} ready
      </span>
      <span aria-hidden className="flex items-center gap-1">
        {states.map((isReady, position) => (
          <span
            key={position}
            className={
              isReady
                ? 'h-1.5 w-5 rounded-full bg-primary'
                : 'h-1.5 w-5 rounded-full border border-border bg-transparent'
            }
          />
        ))}
      </span>
    </div>
  );
}

/**
 * One year's paper, as a line in the ledger of past papers: the year stamped on
 * the left, what it is in the middle, and the way in on the right. The whole
 * row is the link, so it is one tab stop.
 */
function PyqRow({
  id,
  year,
  label,
  latest,
}: {
  id: string;
  year: number;
  label: string | null;
  latest: boolean;
}) {
  return (
    <li className="bg-card">
      <Link
        href={`/pyqs/${id}`}
        aria-label={`Open the ${year} previous year paper${label ? ` (${label})` : ''}`}
        className="group relative flex items-center gap-4 px-4 py-4 transition-colors hover:bg-accent/25 focus-visible:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
      >
        <span
          aria-hidden
          className="flex h-11 w-[4.25rem] shrink-0 items-center justify-center rounded-md border border-border bg-background/60 font-mono text-[1.05rem] font-semibold tabular-nums tracking-tight transition-colors group-hover:border-primary/50 group-hover:text-primary"
        >
          {year}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium transition-colors group-hover:text-primary">
              {label ?? 'Question paper'}
            </p>
            {latest && (
              <span className="shrink-0 rounded-full bg-primary/12 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wider text-primary">
                Latest
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">Previous year paper</p>
        </div>

        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors group-hover:border-primary/50 group-hover:bg-primary/10 group-hover:text-primary">
          Open
          <ArrowRight
            aria-hidden
            className="size-3 transition-transform group-hover:translate-x-0.5"
          />
        </span>
      </Link>
    </li>
  );
}
