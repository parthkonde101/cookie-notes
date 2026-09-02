import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { NoteCard, type CardAccessState } from '@/components/catalog/note-card';
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
 * A subject's notes, unit by unit.
 *
 * Public: the structure and every note title are visible to anyone. Only the
 * action on each card differs, and opening a note still goes through the full
 * server-side authorisation chain.
 */
export default async function SubjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const subject = await subjectCatalog(slug);
  if (!subject) notFound();

  const auth = await optionalUser();

  const allNotes: CatalogNote[] = [
    ...subject.looseNotes,
    ...subject.units.flatMap((unit) => unit.notes),
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
      context={note.topicName ?? note.unitName}
      pageCount={note.pageCount}
      access={(states.get(note.id) ?? { kind: 'sign_in_required' }) as CardAccessState}
    />
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All subjects
      </Link>

      <header className="mt-4 border-b border-border pb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-primary">
          {subject.semester.name}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{subject.name}</h1>
          {subject.code && <Badge variant="outline">{subject.code}</Badge>}
        </div>
        {subject.description && (
          <p className="mt-3 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
            {subject.description}
          </p>
        )}
      </header>

      {subject.noteCount === 0 ? (
        <EmptyState
          className="mt-10"
          icon={FileText}
          title="No notes published yet"
          description="This subject is in the catalogue but nothing has been published to it so far."
        />
      ) : (
        <div className="mt-8 space-y-10">
          {subject.looseNotes.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-muted-foreground">General</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {subject.looseNotes.map(renderNote)}
              </div>
            </section>
          )}

          {subject.units.map((unit) => (
            <section key={unit.id}>
              <h2 className="font-medium">{unit.name}</h2>
              {unit.description && (
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{unit.description}</p>
              )}
              <div className="mt-3 grid gap-3 md:grid-cols-2">{unit.notes.map(renderNote)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
