import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, FileText, Layers } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { NoteCard, type CardAccessState } from '@/components/catalog/note-card';
import { UnitCard } from '@/components/catalog/unit-card';
import { subjectCatalog, type CatalogNote } from '@/lib/catalog';
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
 * One unit is one PDF, so a unit is a card you open rather than a heading with
 * files under it. Past papers keep their own shape — a subject's papers belong
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
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All notebooks
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
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            {subject.semester.name}
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
              <SectionHeading>Units</SectionHeading>
              {/* Same fluid grid as the shelf: the column count follows the
                  space available, and the `min(…,100%)` floor is what stops a
                  track wider than its container from scrolling the page
                  sideways on a narrow phone. */}
              <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))] gap-3">
                {subject.units.map((unit) => (
                  <UnitCard
                    key={unit.id}
                    index={unit.index}
                    name={unit.name}
                    description={unit.description}
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
              </div>
            </section>
          )}

          {subject.pyqs.length > 0 && (
            <section>
              <SectionHeading>Previous Year Questions</SectionHeading>
              {/* Latest year first — ordered in the query, not here. */}
              <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))] gap-3">
                {subject.pyqs.map((pyq) => (
                  <PyqCard key={pyq.id} id={pyq.id} year={pyq.year} label={pyq.label} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-base font-semibold tracking-tight">{children}</h2>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

/** One year's paper. The whole card is the link, so it is one tab stop. */
function PyqCard({ id, year, label }: { id: string; year: number; label: string | null }) {
  return (
    <Link
      href={`/pyqs/${id}`}
      aria-label={`Open the ${year} previous year paper${label ? ` (${label})` : ''}`}
      className="surface-interactive group flex min-w-0 flex-col gap-1 p-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xl font-semibold tabular-nums tracking-tight transition-colors group-hover:text-primary">
          {year}
        </span>
        <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {label ?? 'Previous year paper'}
      </p>
      <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-primary">
        Open
        <ArrowRight aria-hidden className="size-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
