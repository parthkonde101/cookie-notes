import type { Metadata } from 'next';
import Link from 'next/link';
import { MessageSquareText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { FeedbackRow } from '@/components/admin/feedback-row';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth/guards';
import type { FeedbackStatus } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

export const metadata: Metadata = { title: 'Feedback' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'REVIEWED', label: 'Reviewed' },
  { value: 'ARCHIVED', label: 'Archived' },
];

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  await requireAdmin('/admin/feedback');
  const { status, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

  const where: Prisma.FeedbackWhereInput =
    status && status !== 'all' ? { status: status as FeedbackStatus } : {};

  const [rows, total, pendingCount] = await Promise.all([
    prisma.feedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        message: true,
        status: true,
        featured: true,
        publicConsent: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    }),
    prisma.feedback.count({ where }),
    prisma.feedback.count({ where: { status: 'PENDING' } }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Feedback"
        description={
          pendingCount > 0
            ? `${pendingCount} awaiting review. Featured testimonials appear on the homepage.`
            : 'Student testimonials, reviewed here before anything goes public.'
        }
      />

      <form className="mt-6 flex flex-wrap gap-2" action="/admin/feedback" method="get">
        <Select name="status" defaultValue={status ?? 'all'} wrapperClassName="w-auto min-w-[200px]">
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState
            icon={MessageSquareText}
            title="No feedback here"
            description="Student testimonials submitted from /feedback will show up in this queue."
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table minWidthClass="min-w-[880px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Feedback</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Consent</TableHead>
                  <TableHead>Homepage</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <FeedbackRow
                    key={row.id}
                    feedback={{
                      id: row.id,
                      message: row.message,
                      status: row.status,
                      featured: row.featured,
                      publicConsent: row.publicConsent,
                      createdAt: row.createdAt.toISOString(),
                      userName: row.user.name,
                      userEmail: row.user.email,
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-between gap-3">
          <Button asChild variant="outline" size="sm" disabled={page <= 1}>
            <Link href={buildHref({ status, page: page - 1 })}>Previous</Link>
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          <Button asChild variant="outline" size="sm" disabled={page >= pageCount}>
            <Link href={buildHref({ status, page: page + 1 })}>Next</Link>
          </Button>
        </nav>
      )}
    </PageContainer>
  );
}

function buildHref(params: { status?: string; page: number }) {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  search.set('page', String(params.page));
  return `/admin/feedback?${search.toString()}`;
}
