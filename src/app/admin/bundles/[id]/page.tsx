import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { ActionButton } from '@/components/admin/action-button';
import { BundleEditor, type EditorNote, type EditorSubject } from '@/components/admin/bundle-editor';
import { deleteBundleAction } from '@/app/admin/_actions/commerce';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth/guards';
import { bundleForAdmin } from '@/lib/commerce/bundles';
import { coverUrl } from '@/lib/catalog';

export const metadata: Metadata = { title: 'Bundle' };
export const dynamic = 'force-dynamic';

export default async function AdminBundlePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const [bundle, raw, subjectRows, orders] = await Promise.all([
    bundleForAdmin(id),
    prisma.bundle.findUnique({ where: { id }, select: { description: true, coverSubjectId: true } }),
    prisma.subject.findMany({
      where: { isArchived: false },
      orderBy: [{ semester: { position: 'asc' } }, { position: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, coverStorageKey: true, coverUpdatedAt: true, semester: { select: { name: true } } },
    }),
    prisma.orderItem.count({ where: { bundleId: id } }),
  ]);
  if (!bundle || !raw) notFound();

  const inBundle = bundle.notes.map((note) => note.id);
  const noteRows = await prisma.note.findMany({
    where: { OR: [{ isPaid: true }, { id: { in: inBundle } }] },
    orderBy: [{ subject: { name: 'asc' } }, { title: 'asc' }],
    select: { id: true, title: true, subjectId: true, priceMinor: true, isPaid: true, status: true, subject: { select: { name: true } } },
  });

  const notes: EditorNote[] = noteRows.map((note) => ({
    id: note.id,
    title: note.title,
    subjectId: note.subjectId,
    subjectName: note.subject.name,
    priceMinor: note.priceMinor,
    isPaid: note.isPaid,
    status: note.status,
  }));
  const subjects: EditorSubject[] = subjectRows.map((subject) => ({
    id: subject.id,
    name: subject.name,
    semesterName: subject.semester.name,
    cover: coverUrl(subject.id, subject.coverStorageKey, subject.coverUpdatedAt),
  }));

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/admin/bundles" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> All bundles
      </Link>

      <PageHeader
        title={bundle.title}
        description={
          orders > 0
            ? `${orders} ${orders === 1 ? 'order' : 'orders'} so far. Edits change future purchases only; every past order keeps its own price and contents.`
            : 'Nobody has bought this yet.'
        }
        actions={
          orders === 0 ? (
            <ActionButton
              variant="destructive"
              size="sm"
              action={deleteBundleAction.bind(null, bundle.id)}
              confirm={{
                title: 'Delete this bundle?',
                description: 'It has no orders, so it can be removed completely. This cannot be undone.',
                confirmLabel: 'Delete',
                destructive: true,
              }}
            >
              Delete
            </ActionButton>
          ) : null
        }
      />

      <div className="mt-6">
        <BundleEditor
          bundle={{
            id: bundle.id,
            title: bundle.title,
            description: raw.description ?? '',
            priceMinor: bundle.priceMinor,
            isActive: bundle.isActive,
            isFeatured: bundle.isFeatured,
            position: bundle.position,
            coverSubjectId: raw.coverSubjectId,
            noteIds: inBundle,
            subjectIds: bundle.subjectIds,
          }}
          notes={notes}
          subjects={subjects}
        />
      </div>
    </PageContainer>
  );
}
