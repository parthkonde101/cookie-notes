import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import {
  Activity,
  Flame,
  UserCheck,
  Users,
} from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/admin/stat-card';
import {
  ActiveStudentsByMonthCard,
  RegistrationsByMonthCard,
  StudyHoursCard,
  StudySubjectsCard,
} from '@/components/admin/study-charts';
import { env } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guards';
import { adminOverview } from '@/lib/analytics/queries';
import { activeByMonth, registrationsByMonth, studyHours, studySubjects } from '@/lib/analytics/study';
import { CHART_SETTINGS_COOKIE } from '@/lib/analytics/chart-settings';
import { readChartChoices } from '@/lib/analytics/chart-settings-server';

export const metadata: Metadata = { title: 'Admin overview' };
export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  await requireAdmin('/admin');

  // The charts come back as they were left: the choices are kept in a cookie, so
  // the first view is already drawn with them.
  const choices = readChartChoices((await cookies()).get(CHART_SETTINGS_COOKIE)?.value);

  const [stats, hours, subjects, activeMonthly, registrationsMonthly, today] = await Promise.all([
    adminOverview(),
    studyHours(choices.hours.range, choices.hours.offset, choices.hours.custom),
    studySubjects(choices.subjects.range, choices.subjects.offset, choices.subjects.custom),
    activeByMonth(choices.activeMonths),
    registrationsByMonth(choices.registrationMonths),
    // Students who used notes today — the "Active today" figure.
    studyHours('day', 0),
  ]);

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Overview"
        description="Live numbers from the database — nothing here is estimated."
      />

      {/* Reach — who is here, and how many of them are real students. */}
      <section className="mt-6 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Reach</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Total students"
            value={stats.totalUsers}
            icon={Users}
            hint={`${stats.activeUsers} active · ${stats.disabledUsers} disabled`}
          />
          {/* About verified college emails, so it only means something while
              verification is on. Off, the number would just read as a low score
              for a check nobody is being asked to pass. */}
          {env.verification.required && (
            <StatCard
              label="Verified students"
              value={stats.verifiedStudents}
              icon={UserCheck}
              tone="success"
              hint={`${percent(stats.verifiedStudents, stats.totalUsers)} of students have a verified college email`}
            />
          )}
          <StatCard
            label="Active today"
            value={today.students}
            icon={Activity}
            tone="primary"
            hint={`students who used notes today · ${percent(today.students, stats.totalUsers)} of all students`}
          />
          <StatCard
            label="Studying now"
            value={stats.liveSessions}
            icon={Flame}
            tone="success"
            hint={`Active in the last ${stats.liveWindowMinutes} minutes`}
          />
        </div>

        <div className="grid gap-6 pt-3 lg:grid-cols-2 [&>*]:min-w-0">
          <StudyHoursCard initial={hours} />
          <StudySubjectsCard initial={subjects} />
        </div>

        <div className="grid gap-6 pt-3 lg:grid-cols-2 [&>*]:min-w-0">
          <ActiveStudentsByMonthCard initial={activeMonthly} />
          <RegistrationsByMonthCard initial={registrationsMonthly} />
        </div>
      </section>
    </PageContainer>
  );
}

/** "42%" — or a dash while there is no one to divide by. */
function percent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}
