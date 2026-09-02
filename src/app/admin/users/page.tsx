import type { Metadata } from 'next';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { ActionForm, Field } from '@/components/admin/action-form';
import { createUserAction } from '@/app/admin/_actions/users';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth/guards';
import { liveCutoff } from '@/lib/auth/session';
import { relativeTime } from '@/lib/utils';
import type { Prisma } from '@/generated/prisma/client';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * The single place accounts are managed. Access grants live on each user's own
 * page — there is no separate Access section to keep in step with this one.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; role?: string; page?: string }>;
}) {
  await requireAdmin('/admin/users');
  const { q, status, role, page: pageParam } = await searchParams;

  const query = (q ?? '').trim();
  const page = Math.max(1, Number(pageParam) || 1);

  const where: Prisma.UserWhereInput = {
    ...(query
      ? {
          OR: [
            { email: { contains: query, mode: 'insensitive' } },
            { name: { contains: query, mode: 'insensitive' } },
            { college: { contains: query, mode: 'insensitive' } },
            { program: { contains: query, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(status && status !== 'all' ? { status: status as 'ACTIVE' | 'DISABLED' } : {}),
    ...(role && role !== 'all' ? { role: role as 'STUDENT' | 'ADMIN' } : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        college: true,
        program: true,
        semester: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { entitlements: true, noteViews: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  // One query for "who is live right now", rather than one per row.
  const liveRows = await prisma.session.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { gt: new Date() },
      lastActivityAt: { gt: liveCutoff() },
      userId: { in: users.map((user) => user.id) },
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  const live = new Set(liveRows.map((row) => row.userId));

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Users"
        description={`${total} account${total === 1 ? '' : 's'} in this view. Open one to manage its access.`}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <form className="flex flex-wrap gap-2" action="/admin/users" method="get">
            <Input
              name="q"
              defaultValue={query}
              placeholder="Search name, email, college or programme"
              className="min-w-[200px] flex-1"
            />
            <Select name="status" defaultValue={status ?? 'all'} wrapperClassName="w-auto">
              <option value="all">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="DISABLED">Disabled</option>
            </Select>
            <Select name="role" defaultValue={role ?? 'all'} wrapperClassName="w-auto">
              <option value="all">All roles</option>
              <option value="STUDENT">Students</option>
              <option value="ADMIN">Admins</option>
            </Select>
            <Button type="submit" variant="outline">
              Filter
            </Button>
          </form>

          {users.length === 0 ? (
            <EmptyState icon={Users} title="No users match this filter" />
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student</TableHead>
                    <TableHead>Course</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Last login</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <Link
                          href={`/admin/users/${user.id}`}
                          className="font-medium hover:text-primary"
                        >
                          {user.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground">
                        {user.college ?? '—'}
                        {(user.program || user.semester) && (
                          <span className="block text-xs">
                            {[user.program, user.semester ? `Sem ${user.semester}` : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          <Badge variant={user.status === 'ACTIVE' ? 'success' : 'destructive'}>
                            {user.status.toLowerCase()}
                          </Badge>
                          {user.role === 'ADMIN' && <Badge>admin</Badge>}
                          {live.has(user.id) && <Badge variant="secondary">online</Badge>}
                        </div>
                      </TableCell>

                      <TableCell className="text-sm tabular-nums text-muted-foreground">
                        {user._count.entitlements} grants
                        <br />
                        {user._count.noteViews} reads
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground">
                        {user.lastLoginAt ? relativeTime(user.lastLoginAt) : 'Never'}
                        <span className="block text-xs">
                          joined {relativeTime(user.createdAt)}
                        </span>
                      </TableCell>

                      <TableCell className="text-right">
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/admin/users/${user.id}`}>Manage</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {pageCount > 1 && (
            <nav className="flex items-center justify-between gap-3">
              <Button asChild variant="outline" size="sm" disabled={page <= 1}>
                <Link href={buildHref({ q: query, status, role, page: page - 1 })}>Previous</Link>
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              <Button asChild variant="outline" size="sm" disabled={page >= pageCount}>
                <Link href={buildHref({ q: query, status, role, page: page + 1 })}>Next</Link>
              </Button>
            </nav>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle>Create a user</CardTitle>
            <CardDescription>
              For accounts you set up yourself. Students can also register on the site.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={createUserAction} submitLabel="Create user" resetOnSuccess>
              <Field label="Full name" htmlFor="name">
                <Input id="name" name="name" required />
              </Field>
              <Field label="Email" htmlFor="email">
                <Input id="email" name="email" type="email" required />
              </Field>
              <Field
                label="Temporary password"
                htmlFor="password"
                hint="At least 10 characters with mixed case, a number and a symbol."
              >
                <Input id="password" name="password" type="text" required />
              </Field>
              <Field label="Role" htmlFor="role">
                <Select id="role" name="role" defaultValue="STUDENT">
                  <option value="STUDENT">Student</option>
                  <option value="ADMIN">Admin</option>
                </Select>
              </Field>
              <Field label="College" htmlFor="college">
                <Input id="college" name="college" />
              </Field>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}

function buildHref(params: { q?: string; status?: string; role?: string; page: number }) {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.status) search.set('status', params.status);
  if (params.role) search.set('role', params.role);
  search.set('page', String(params.page));
  return `/admin/users?${search.toString()}`;
}
