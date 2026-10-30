import type { Metadata } from 'next';
import Link from 'next/link';
import { PackageOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { NewBundleForm } from '@/components/admin/new-bundle-form';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth/guards';
import { allBundlesForAdmin } from '@/lib/commerce/bundles';
import { formatInr } from '@/lib/commerce/money';

export const metadata: Metadata = { title: 'Bundles' };
export const dynamic = 'force-dynamic';

/**
 * Every bundle, live or not, with what is wrong with it and how it is selling.
 *
 * "Live" means a student could buy it right now — active, two or more notes, all published —
 * so a bundle switched on but blocked (say, by an unpublished note) is shown as blocked, never
 * as live.
 */
export default async function AdminBundlesPage() {
  await requireAdmin('/admin/bundles');

  const [bundles, subjects, sales] = await Promise.all([
    allBundlesForAdmin(),
    prisma.subject.findMany({ select: { id: true, name: true } }),
    prisma.orderItem.groupBy({
      by: ['bundleId'],
      where: { bundleId: { not: null }, order: { status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } } },
      _count: { _all: true },
      _sum: { amountMinor: true },
    }),
  ]);
  const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const soldBy = new Map(sales.map((row) => [row.bundleId, row]));

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Bundles"
        description="Sets of notes sold together at a price you choose. They appear at the top of the subject pages you pick."
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px] [&>*]:min-w-0">
        <div>
          {bundles.length === 0 ? (
            <EmptyState icon={PackageOpen} title="No bundles yet" description="Create one on the right, then choose its notes." />
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bundle</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bundles.map((bundle) => {
                    const sold = soldBy.get(bundle.id);
                    return (
                      <TableRow key={bundle.id}>
                        <TableCell>
                          <Link href={`/admin/bundles/${bundle.id}`} className="font-medium hover:text-primary">
                            {bundle.title}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {bundle.subjectIds.length === 0
                              ? 'Not promoted anywhere'
                              : bundle.subjectIds
                                  .map((id) => subjectName.get(id))
                                  .filter(Boolean)
                                  .slice(0, 3)
                                  .join(' · ')}
                          </p>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatInr(bundle.priceMinor)}
                          {bundle.savings && (
                            <span className="block text-xs text-success">saves {formatInr(bundle.savings.savingsMinor)}</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">{bundle.notes.length}</TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            {bundle.isActive && bundle.problem === null ? (
                              <Badge variant="success">live</Badge>
                            ) : bundle.isActive ? (
                              <Badge variant="warning">blocked</Badge>
                            ) : (
                              <Badge variant="outline">draft</Badge>
                            )}
                            {bundle.isFeatured && <Badge>featured</Badge>}
                            {bundle.isActive && bundle.problem && (
                              <span className="max-w-[16rem] text-xs text-warning">{bundle.problem}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {sold ? (
                            <>
                              {sold._count._all}
                              <span className="block text-xs">{formatInr(sold._sum.amountMinor ?? 0)}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle>New bundle</CardTitle>
            <CardDescription>It starts as a draft. Nothing is public until you switch it on.</CardDescription>
          </CardHeader>
          <CardContent>
            <NewBundleForm />
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
