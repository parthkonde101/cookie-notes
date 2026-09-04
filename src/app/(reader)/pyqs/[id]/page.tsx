import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth/guards';
import { checkPyqAccess } from '@/lib/access/entitlements';
import { NoteViewer } from '@/components/notes/note-viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Reading' };

/**
 * A previous-year paper, in the same protected reader notes use.
 *
 * Authorised server-side before anything renders; the viewer then goes through
 * the API, which repeats the check for every byte it serves.
 */
export default async function PyqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireUser(`/pyqs/${id}`);

  const decision = await checkPyqAccess(user.id, user.role, id);
  if (!decision.allowed) notFound();

  const pyq = await prisma.pyq.findUnique({
    where: { id },
    select: {
      id: true,
      year: true,
      label: true,
      subject: { select: { name: true, slug: true, code: true } },
    },
  });
  if (!pyq) notFound();

  const subtitle = [pyq.subject.code ?? pyq.subject.name, 'Previous year paper']
    .filter(Boolean)
    .join(' · ');

  return (
    <NoteViewer
      apiBase="/api/pyqs"
      noteId={pyq.id}
      title={pyq.label ? `${pyq.year} — ${pyq.label}` : `${pyq.year} paper`}
      subtitle={subtitle}
      backHref={`/subject/${pyq.subject.slug}`}
    />
  );
}
