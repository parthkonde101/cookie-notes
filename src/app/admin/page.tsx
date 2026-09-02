import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity,
  BookOpen,
  Eye,
  FileText,
  Flame,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/admin/stat-card';
import { TrendChart } from '@/components/charts/trend-chart';
import { requireAdmin } from '@/lib/auth/guards';
import { adminOverview, growthSeries } from '@/lib/analytics/queries';
import { relativeTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Admin overview' };
export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  await requireAdmin('/admin');

  const [stats, series] = await Promise.all([adminOverview(), growthSeries(30)]);

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Overview"
        description="Live numbers from the database — nothing here is estimated."
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total students" value={stats.totalUsers} icon={Users} hint={`${stats.activeUsers} active · ${stats.disabledUsers} disabled`} />
        <StatCard
          label="Studying now"
          value={stats.liveSessions}
          icon={Flame}
          tone="success"
          hint={`Active in the last ${stats.liveWindowMinutes} minutes`}
        />
        <StatCard label="New today" value={stats.newToday} icon={UserPlus} hint={`${stats.newThisWeek} in the last 7 days`} />
        <StatCard label="Notes" value={stats.totalNotes} icon={FileText} hint={`${stats.publishedNotes} published · ${stats.totalSubjects} subjects`} />

        <StatCard label="Note views today" value={stats.viewsToday} icon={Eye} hint={`${stats.totalViews} all time`} />
        <StatCard label="Daily active" value={stats.dau} icon={Activity} hint="Distinct users with activity today" />
        <StatCard label="Weekly active" value={stats.wau} icon={Activity} hint="Last 7 days" />
        <StatCard label="Monthly active" value={stats.mau} icon={TrendingUp} hint="Last 30 days" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Registrations</CardTitle>
            <CardDescription>New student accounts per day, last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart data={series.registrations} suffix="sign-ups" variant="bar" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Daily active users</CardTitle>
            <CardDescription>Distinct students with recorded activity</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart data={series.activeUsers} suffix="students" color="hsl(var(--success))" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Note views</CardTitle>
            <CardDescription>Times a note was opened</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart data={series.noteViews} suffix="views" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Sign-ins</CardTitle>
            <CardDescription>Successful logins per day</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart data={series.logins} suffix="sign-ins" color="hsl(var(--warning))" variant="bar" />
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="size-4" />
              Most viewed note
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats.mostViewedNote ? (
              <Link
                href={`/admin/notes/${stats.mostViewedNote.id}`}
                className="block rounded-md border border-border p-3 transition-colors hover:border-primary/40"
              >
                <p className="font-medium">{stats.mostViewedNote.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {stats.mostViewedNote.subject.name} · {stats.mostViewedNote.viewCount} views
                </p>
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">No note has been opened yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              Most active students
            </CardTitle>
            <CardDescription>By recorded events in the last 30 days</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {stats.mostActiveUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
            ) : (
              stats.mostActiveUsers.map((student, index) => (
                <Link
                  key={student.id}
                  href={`/admin/users/${student.id}`}
                  className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-secondary/60"
                >
                  <span className="w-4 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{student.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {student.email}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground">
                    <span className="block tabular-nums">{student.events} events</span>
                    <span className="block">{relativeTime(student.last_seen)}</span>
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
