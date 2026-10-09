import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/admin/stat-card';
import { TrendChart } from '@/components/charts/trend-chart';
import { requireAdmin } from '@/lib/auth/guards';
import {
  adminOverview,
  contentAnalytics,
  engagementAnalytics,
  growthSeries,
  pageViewAnalytics,
  programAnalytics,
  type PageViewStats,
  type ProgramStats,
} from '@/lib/analytics/queries';
import { programLabel } from '@/lib/program';
import { formatDate, formatDuration, relativeTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdmin('/admin/analytics');

  const { days: daysParam } = await searchParams;
  const days = [7, 30, 90].includes(Number(daysParam)) ? Number(daysParam) : 30;

  // The two reach reports are newer than the rest. If either cannot be computed
  // the page still loads, with a note in its place, rather than failing whole.
  const unavailable = (name: string) => (error: unknown) => {
    console.error(`[admin] ${name} unavailable`, error);
    return null;
  };

  const [overview, series, content, engagement, pages, programs] = await Promise.all([
    adminOverview(),
    growthSeries(days),
    contentAnalytics(),
    engagementAnalytics(),
    pageViewAnalytics(days).catch(unavailable('page views')),
    programAnalytics(days).catch(unavailable('programme access')),
  ]);

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Analytics"
        description="Who is signing up, what they read, and how long they stay. All computed from recorded events."
        actions={
          <div className="flex gap-1">
            {[7, 30, 90].map((option) => (
              <Button
                key={option}
                asChild
                size="sm"
                variant={option === days ? 'default' : 'outline'}
              >
                <Link href={`/admin/analytics?days=${option}`}>{option}d</Link>
              </Button>
            ))}
          </div>
        }
      />

      {/* Audience */}
      <section className="mt-6 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Audience</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Registered students" value={overview.totalUsers} />
          <StatCard label="Daily active" value={overview.dau} hint="Distinct users today" />
          <StatCard label="Weekly active" value={overview.wau} hint="Last 7 days" />
          <StatCard label="Monthly active" value={overview.mau} hint="Last 30 days" />
          <StatCard
            label="Returning users"
            value={engagement.returningUsers}
            hint="Signed in more than once"
          />
          <StatCard
            label="Average logins per user"
            value={engagement.averageLoginsPerUser}
          />
          <StatCard
            label="Average sessions per user"
            value={engagement.averageSessionsPerUser}
          />
          <StatCard
            label="Average session length"
            value={formatDuration(engagement.averageSessionSeconds * 1000)}
            hint="First to last activity"
          />
        </div>
      </section>

      {/* Reach: which pages and which programmes students use */}
      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Where students go · last {days} days
        </h2>

        {pages ? (
          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            {pages.map((stats) => (
              <PageViewCard
                key={stats.page}
                stats={stats}
                registered={overview.totalUsers}
                days={days}
              />
            ))}
          </div>
        ) : (
          <Unavailable>Page views could not be loaded right now.</Unavailable>
        )}

        {programs ? (
          <ProgramSplit programs={programs} />
        ) : (
          <Unavailable>Programme access could not be loaded right now.</Unavailable>
        )}
      </section>

      {/* Growth */}
      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Growth · last {days} days</h2>
        <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <ChartCard title="Registrations" description="New accounts per day">
            <TrendChart data={series.registrations} suffix="sign-ups" variant="bar" />
          </ChartCard>
          <ChartCard title="Daily active users" description="Distinct students with activity">
            <TrendChart data={series.activeUsers} suffix="students" color="hsl(var(--success))" />
          </ChartCard>
          <ChartCard title="Note views" description="Notes opened per day">
            <TrendChart data={series.noteViews} suffix="views" />
          </ChartCard>
          <ChartCard title="Sign-ins" description="Successful logins per day">
            <TrendChart
              data={series.logins}
              suffix="sign-ins"
              color="hsl(var(--warning))"
              variant="bar"
            />
          </ChartCard>
        </div>
      </section>

      {/* Content */}
      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Content</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Total note opens" value={overview.totalViews} />
          <StatCard
            label="Average reading time"
            value={formatDuration(content.averageDurationMs)}
            hint={`${content.readingSessions} measured sessions`}
          />
          <StatCard
            label="Total time reading"
            value={formatDuration(content.totalReadingMs)}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Most viewed notes</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {content.mostViewed.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">Nothing opened yet.</p>
              ) : (
                <Table minWidthClass="min-w-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Note</TableHead>
                      <TableHead className="text-right">Views</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {content.mostViewed.map((note) => (
                      <TableRow key={note.id}>
                        <TableCell>
                          <Link href={`/admin/notes/${note.id}`} className="hover:text-primary">
                            <span className="block font-medium">{note.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {note.subject.name}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{note.viewCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Least viewed notes</CardTitle>
              <CardDescription>Published but going unread — worth reviewing</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {content.leastViewed.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">No published notes yet.</p>
              ) : (
                <Table minWidthClass="min-w-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Note</TableHead>
                      <TableHead className="text-right">Views</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {content.leastViewed.map((note) => (
                      <TableRow key={note.id}>
                        <TableCell>
                          <Link href={`/admin/notes/${note.id}`} className="hover:text-primary">
                            <span className="block font-medium">{note.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {note.subject.name} · added {formatDate(note.createdAt)}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{note.viewCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Most popular subjects</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {content.topSubjects.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">No subjects with notes yet.</p>
              ) : (
                <Table minWidthClass="min-w-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Subject</TableHead>
                      <TableHead className="text-right">Notes</TableHead>
                      <TableHead className="text-right">Views</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {content.topSubjects.map((subject) => (
                      <TableRow key={subject.id}>
                        <TableCell className="font-medium">{subject.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{subject.notes}</TableCell>
                        <TableCell className="text-right tabular-nums">{subject.views}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Recently accessed</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {content.recentlyAccessed.length === 0 ? (
                <p className="text-sm text-muted-foreground">No reading sessions yet.</p>
              ) : (
                content.recentlyAccessed.map((view) => (
                  <div
                    key={view.id}
                    className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 text-sm last:border-0"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/admin/notes/${view.note.id}`}
                        className="block truncate font-medium hover:text-primary"
                      >
                        {view.note.title}
                      </Link>
                      <Link
                        href={`/admin/users/${view.user.id}`}
                        className="block truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        {view.user.email}
                      </Link>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <span className="block">{relativeTime(view.startedAt)}</span>
                      <span className="block">{formatDuration(view.durationMs)}</span>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </PageContainer>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const PAGE_COPY = {
  home: {
    title: 'Home page',
    description: 'The scroll-through introduction, at Home and at / for signed-out visitors',
  },
  about: { title: 'About page', description: 'Who is behind Cookie Notes' },
} as const;

function formatPercent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

function MiniStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums tracking-tight">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** How many students looked at one public page, and how that moved day to day. */
function PageViewCard({
  stats,
  registered,
  days,
}: {
  stats: PageViewStats;
  registered: number;
  days: number;
}) {
  const copy = PAGE_COPY[stats.page];
  const views = stats.studentViews + stats.visitorViews;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-3">
          <p className="stat-value">{stats.students}</p>
          <p className="pb-1 text-sm text-muted-foreground">
            {stats.students === 1 ? 'student' : 'students'} viewed it in {days} days
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
          <MiniStat label="Views" value={views} hint={`${stats.studentViews} by students`} />
          <MiniStat label="Not signed in" value={stats.visitorViews} hint="Visitor views" />
          <MiniStat
            label="All time"
            value={stats.studentsAllTime}
            hint={`${formatPercent(stats.studentsAllTime, registered)} of students`}
          />
        </div>

        <TrendChart data={stats.series} suffix="views" variant="bar" />

        <p className="text-xs text-muted-foreground">
          {stats.since
            ? `Counting since ${formatDate(stats.since)}.`
            : 'No views recorded yet — counting began with this release, so earlier visits are not included.'}
        </p>
      </CardContent>
    </Card>
  );
}

/** B.Tech and Polytechnic side by side: how many students read each, and how much. */
function ProgramSplit({ programs }: { programs: ProgramStats[] }) {
  const totalOpens = programs.reduce((sum, program) => sum + program.noteOpens, 0);

  return (
    <div className="space-y-3">
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        {programs.map((program) => (
          <Card key={program.program}>
            <CardHeader className="pb-3">
              <CardTitle>{programLabel(program.program)} notes</CardTitle>
              <CardDescription>Students who opened at least one note in this period</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3">
                <p className="stat-value">{program.students}</p>
                <p className="pb-1 text-sm text-muted-foreground">
                  {program.students === 1 ? 'student' : 'students'}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
                <MiniStat
                  label="Note opens"
                  value={program.noteOpens}
                  hint={
                    program.students > 0
                      ? `${(program.noteOpens / program.students).toFixed(1)} per student`
                      : undefined
                  }
                />
                <MiniStat label="Past papers" value={program.paperOpens} hint="Opened" />
                <MiniStat label="Catalogue" value={program.catalogueViews} hint="Shelf views" />
              </div>

              <p className="text-xs text-muted-foreground">
                All time: {program.studentsAllTime}{' '}
                {program.studentsAllTime === 1 ? 'student' : 'students'} ·{' '}
                {program.noteOpensAllTime} note opens · {program.publishedNotes} published notes
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {totalOpens > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Share of note opens
          </p>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-secondary" aria-hidden>
            {programs.map((program, index) => (
              <span
                key={program.program}
                className={index === 0 ? 'bg-primary' : 'bg-success'}
                style={{ width: `${(program.noteOpens / totalOpens) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {programs.map((program, index) => (
              <span key={program.program} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`size-2 rounded-full ${index === 0 ? 'bg-primary' : 'bg-success'}`}
                />
                {programLabel(program.program)}{' '}
                <span className="font-medium tabular-nums text-foreground">
                  {formatPercent(program.noteOpens, totalOpens)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
