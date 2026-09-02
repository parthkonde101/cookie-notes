import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth/guards';
import { formatDateTime } from '@/lib/utils';
import type { AuditAction } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 40;

const DESTRUCTIVE: AuditAction[] = [
  'USER_DELETED',
  'USER_DISABLED',
  'NOTE_DELETED',
  'ACCESS_REVOKED',
  'SESSION_TERMINATED',
  'SEMESTER_DELETED',
  'SUBJECT_DELETED',
  'UNIT_DELETED',
  'TOPIC_DELETED',
];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  await requireAdmin('/admin/audit');
  const { action, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

  const where: Prisma.AuditLogWhereInput =
    action && action !== 'all' ? { action: action as AuditAction } : {};

  const [entries, total, actions] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true } }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Audit log"
        description="Every privileged action, with who did it and from where. Append-only."
      />

      <form className="mt-6 flex flex-wrap gap-2" action="/admin/audit" method="get">
        <Select name="action" defaultValue={action ?? 'all'} wrapperClassName="w-auto min-w-[220px]">
          <option value="all">All actions ({total})</option>
          {actions
            .sort((a, b) => b._count._all - a._count._all)
            .map((row) => (
              <option key={row.action} value={row.action}>
                {row.action} ({row._count._all})
              </option>
            ))}
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      <div className="mt-4">
        {entries.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Nothing logged yet"
            description="Admin actions such as uploads, grants and account changes appear here."
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDateTime(entry.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={DESTRUCTIVE.includes(entry.action) ? 'destructive' : 'secondary'}>
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.actorEmail ?? '—'}
                      {entry.ipAddress && (
                        <span className="block font-mono text-xs text-muted-foreground">
                          {entry.ipAddress}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px] text-sm">
                      <span className="block truncate">{entry.targetLabel ?? entry.targetId ?? '—'}</span>
                      {entry.targetType && (
                        <span className="block text-xs text-muted-foreground">{entry.targetType}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      {entry.metadata ? (
                        <code className="block truncate font-mono text-xs text-muted-foreground">
                          {JSON.stringify(entry.metadata)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {pageCount > 1 && (
        <nav className="mt-6 flex items-center justify-between">
          <Button asChild variant="outline" size="sm" disabled={page <= 1}>
            <Link href={`/admin/audit?action=${action ?? 'all'}&page=${page - 1}`}>Previous</Link>
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          <Button asChild variant="outline" size="sm" disabled={page >= pageCount}>
            <Link href={`/admin/audit?action=${action ?? 'all'}&page=${page + 1}`}>Next</Link>
          </Button>
        </nav>
      )}
    </PageContainer>
  );
}
