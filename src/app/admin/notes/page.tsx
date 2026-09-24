import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { ContentManager } from '@/components/admin/content-manager';
import { requireAdmin } from '@/lib/auth/guards';
import { loadCatalogTree, placementOptions } from '@/lib/admin/catalog';
import {
  ADMIN_PROGRAM_COOKIE,
  PROGRAM_PARAM,
  programLabel,
  resolveProgram,
} from '@/lib/program';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { pluralize } from '@/lib/utils';

export const metadata: Metadata = { title: 'Notes' };
export const dynamic = 'force-dynamic';

/**
 * The single content-management surface: the academic structure and the PDFs
 * inside it. There is no separate catalogue page and no separate upload page —
 * everything happens here, against the tree.
 *
 * ## One program at a time
 *
 * The page manages one program's catalogue. Everything on it — the tree, the
 * counts in the header, the semester and subject forms, the upload picker —
 * is scoped to the selected program, so an admin working on Polytechnic cannot
 * be shown a B.Tech unit to file a PDF into. Switching is one click and costs
 * nothing; it is a view, not a permission.
 *
 * The counts are computed per program too. A header reading "12 of 20 units
 * uploaded" while the tree below shows four is worse than no header at all.
 */
export default async function AdminNotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin('/admin/notes');

  const [params, cookieStore] = await Promise.all([searchParams, cookies()]);
  const program = resolveProgram(
    params[PROGRAM_PARAM],
    cookieStore.get(ADMIN_PROGRAM_COOKIE)?.value,
  );

  const [catalog, counts] = await Promise.all([
    loadCatalogTree(program),
    // Scoped through subject → semester, the same path a note's program is
    // derived by everywhere else. `groupBy` is still one query.
    prisma.note.groupBy({
      by: ['status'],
      where: { subject: { is: { semester: { is: { program } } } } },
      _count: { _all: true },
    }),
  ]);

  const total = counts.reduce((sum, row) => sum + row._count._all, 0);
  const published = counts.find((row) => row.status === 'PUBLISHED')?._count._all ?? 0;
  const drafts = counts.find((row) => row.status === 'DRAFT')?._count._all ?? 0;

  // Coverage rather than a bare total: "18 notes" does not tell an admin which
  // unit is still missing its PDF, and that is the question this page answers.
  const subjects = catalog.flatMap((semester) => semester.subjects);
  const unitCount = subjects.reduce((sum, subject) => sum + subject.units.length, 0);
  const missingCount = subjects.reduce((sum, subject) => sum + subject.missingCount, 0);

  const label = programLabel(program);

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Notes"
        description={
          unitCount === 0
            ? `No ${label} content yet. Add a semester, its subjects and their units — then upload one PDF into each unit.`
            : [
                // The programme is stated by the selector directly below and
                // by the line under it; a third copy in the same eyeful is
                // noise. The counts here are already scoped to it.
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
        program={program}
        maxUploadMb={env.uploads.maxMb}
        currencySymbol={env.catalog.currencySymbol}
      />
    </PageContainer>
  );
}
