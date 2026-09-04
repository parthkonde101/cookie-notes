import type { Metadata } from 'next';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { ContentManager } from '@/components/admin/content-manager';
import { requireAdmin } from '@/lib/auth/guards';
import { loadCatalogTree, placementOptions } from '@/lib/admin/catalog';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { pluralize } from '@/lib/utils';

export const metadata: Metadata = { title: 'Notes' };
export const dynamic = 'force-dynamic';

/**
 * The single content-management surface: the academic structure and the PDFs
 * inside it. There is no separate catalogue page and no separate upload page —
 * everything happens here, against the tree.
 */
export default async function AdminNotesPage() {
  await requireAdmin('/admin/notes');

  const [catalog, counts] = await Promise.all([
    loadCatalogTree(),
    prisma.note.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  const total = counts.reduce((sum, row) => sum + row._count._all, 0);
  const published = counts.find((row) => row.status === 'PUBLISHED')?._count._all ?? 0;
  const drafts = counts.find((row) => row.status === 'DRAFT')?._count._all ?? 0;

  // Coverage rather than a bare total: "18 notes" does not tell an admin which
  // unit is still missing its PDF, and that is the question this page answers.
  const subjects = catalog.flatMap((semester) => semester.subjects);
  const unitCount = subjects.reduce((sum, subject) => sum + subject.units.length, 0);
  const missingCount = subjects.reduce((sum, subject) => sum + subject.missingCount, 0);

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Notes"
        description={
          unitCount === 0
            ? 'Add a semester, its subjects and their units — then upload one PDF into each unit.'
            : [
                `${unitCount - missingCount} of ${pluralize(unitCount, 'unit')} uploaded`,
                `${published} published`,
                drafts > 0 ? `${drafts} draft` : null,
                total > unitCount - missingCount ? `${total} notes in total` : null,
              ]
                .filter(Boolean)
                .join(' · ')
        }
      />

      <ContentManager
        catalog={catalog}
        placements={placementOptions(catalog)}
        maxUploadMb={env.uploads.maxMb}
        currencySymbol={env.catalog.currencySymbol}
      />
    </PageContainer>
  );
}
