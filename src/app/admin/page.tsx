import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  Activity,
  Banknote,
  CalendarDays,
  Flame,
  ShoppingBag,
  Undo2,
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
import { formatInr } from '@/lib/commerce/money';
import { resolveSalesRange } from '@/lib/commerce/ranges';
import { salesTotals } from '@/lib/commerce/reporting';
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

  const month = resolveSalesRange({ range: 'month' }, new Date(), env.analytics.timezone);

  const [stats, hours, subjects, activeMonthly, registrationsMonthly, today, salesAll, salesMonth] = await Promise.all([
    adminOverview(),
    studyHours(choices.hours.range, choices.hours.offset, choices.hours.custom),
    studySubjects(choices.subjects.range, choices.subjects.offset, choices.subjects.custom),
    activeByMonth(choices.activeMonths),
    registrationsByMonth(choices.registrationMonths),
    // Students who used notes today — the "Active today" figure.
    studyHours('day', 0),
    // Sales headlines: every sale to date, and this month on the store's clock.
    salesTotals(),
    salesTotals(month),
  ]);

  // Nothing to show until selling has been switched on or the first sale or refund has happened.
  const showSales = env.payments.enabled || salesAll.orders > 0 || salesAll.refundCount > 0;

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Overview"
        description="Live numbers from the database — nothing here is estimated."
      />

      {/* Sales — money in, after refunds. Same definitions as the Sales page. */}
      {showSales && (
        <section className="mt-6 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">Sales</h2>
            <Link href="/admin/sales" className="text-sm text-primary underline-offset-4 hover:underline">
              Open Sales
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total sales"
              value={formatInr(salesAll.netMinor)}
              icon={Banknote}
              tone="primary"
              hint={`${formatInr(salesAll.grossMinor)} paid, less ${formatInr(salesAll.refundsMinor)} refunded`}
            />
            <StatCard
              label="This month"
              value={formatInr(salesMonth.netMinor)}
              icon={CalendarDays}
              hint={`${salesMonth.orders} ${salesMonth.orders === 1 ? 'order' : 'orders'} · after refunds`}
            />
            <StatCard
              label="Paid orders"
              value={salesAll.orders}
              icon={ShoppingBag}
              hint="all time"
            />
            <StatCard
              label="Refunds"
              value={formatInr(salesAll.refundsMinor)}
              icon={Undo2}
              tone={salesAll.refundCount > 0 ? 'warning' : 'default'}
              hint={`${salesAll.refundCount} ${salesAll.refundCount === 1 ? 'refund' : 'refunds'} processed`}
            />
          </div>
        </section>
      )}

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
