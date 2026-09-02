import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth/guards';
import { checkNoteAccess } from '@/lib/access/entitlements';
import { NoteViewer } from '@/components/notes/note-viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Reading' };

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireUser(`/notes/${id}`);

  // Authorised server-side before anything is rendered. The viewer then goes
  // through the API, which repeats the check for every byte it serves.
  const decision = await checkNoteAccess(user.id, user.role, id);
  if (!decision.allowed) notFound();

  const note = await prisma.note.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      subject: { select: { name: true, slug: true, code: true } },
      unit: { select: { name: true } },
      topic: { select: { name: true } },
    },
  });
  if (!note) notFound();

  const subtitle = [note.subject.code ?? note.subject.name, note.unit?.name, note.topic?.name]
    .filter(Boolean)
    .join(' · ');

  return (
    <NoteViewer
      noteId={note.id}
      title={note.title}
      subtitle={subtitle}
      backHref={`/subject/${note.subject.slug}`}
    />
  );
}
