import type { Metadata } from 'next';
import Link from 'next/link';
import { MonitorSmartphone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/admin/stat-card';
import { ActionButton } from '@/components/admin/action-button';
import { terminateSessionAction } from '@/app/admin/_actions/users';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guards';
import { idleCutoff, liveCutoff } from '@/lib/auth/session';
import { describeDevice } from '@/lib/request';
import { formatDateTime, relativeTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Sessions' };
export const dynamic = 'force-dynamic';

export default async function AdminSessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireAdmin('/admin/sessions');
  const { filter } = await searchParams;
  const showAll = filter === 'all';

  const now = new Date();

  const [sessions, liveCount, idleCount, totalToday] = await Promise.all([
    prisma.session.findMany({
      where: showAll ? {} : { status: 'ACTIVE', expiresAt: { gt: now } },
      orderBy: { lastActivityAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, name: true, email: true, status: true } } },
    }),
    prisma.session.count({
      where: { status: 'ACTIVE', lastActivityAt: { gt: liveCutoff(now) }, expiresAt: { gt: now } },
    }),
    prisma.session.count({
      where: {
        status: 'ACTIVE',
        lastActivityAt: { lte: liveCutoff(now), gt: idleCutoff(now) },
        expiresAt: { gt: now },
      },
    }),
    prisma.session.count({
      where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } },
    }),
  ]);

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Sessions"
        description="One account may hold one active session. Ending a session signs that device out immediately."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={showAll ? '/admin/sessions' : '/admin/sessions?filter=all'}>
              {showAll ? 'Show active only' : 'Show all sessions'}
            </Link>
          </Button>
        }
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Active right now"
          value={liveCount}
          tone="success"
          hint={`Activity within ${env.liveWindowMinutes} minutes`}
        />
        <StatCard
          label="Idle but signed in"
          value={idleCount}
          hint={`No activity for ${env.liveWindowMinutes}–${env.session.idleMinutes} minutes`}
        />
        <StatCard label="Started today" value={totalToday} />
      </div>

      <div className="mt-6">
        {sessions.length === 0 ? (
          <EmptyState icon={MonitorSmartphone} title="No sessions to show" />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const isLive =
                    session.status === 'ACTIVE' &&
                    session.lastActivityAt > liveCutoff(now) &&
                    session.expiresAt > now;

                  return (
                    <TableRow key={session.id}>
                      <TableCell>
                        <Link
                          href={`/admin/users/${session.user.id}`}
                          className="font-medium hover:text-primary"
                        >
                          {session.user.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{session.user.email}</p>
                      </TableCell>
                      <TableCell className="text-sm">{describeDevice(session)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {session.ipAddress ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(session.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {relativeTime(session.lastActivityAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={isLive ? 'success' : session.status === 'ACTIVE' ? 'warning' : 'outline'}>
                          {isLive ? 'live' : session.status.toLowerCase().replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {session.status === 'ACTIVE' && (
                          <ActionButton
                            variant="ghost"
                            size="sm"
                            action={terminateSessionAction.bind(null, session.id)}
                            confirm={{
                              title: 'End this session?',
                              description: `${session.user.email} will be signed out on that device right away.`,
                              confirmLabel: 'End session',
                              destructive: true,
                            }}
                          >
                            End
                          </ActionButton>
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
    </PageContainer>
  );
}
