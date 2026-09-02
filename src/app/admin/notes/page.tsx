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
 * The single content-management surface: the academic structure and the notes
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

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Notes"
        description={
          total === 0
            ? 'Build your academic structure, then upload notes into it.'
            : `${pluralize(total, 'note')} · ${published} published${drafts > 0 ? ` · ${drafts} draft` : ''}`
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
