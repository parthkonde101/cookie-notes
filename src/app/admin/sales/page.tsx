import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Banknote, PackageOpen, Receipt, RotateCcw, ShoppingBag, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/admin/stat-card';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guards';
import { formatInr } from '@/lib/commerce/money';
import { resolveSalesRange } from '@/lib/commerce/ranges';
import { describeStatus, type OrderStatusValue } from '@/lib/commerce/states';
import { listTransactions, salesReport, type TopProduct, type TransactionFilter } from '@/lib/commerce/reporting';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
] as const;

const FILTERS: { key: TransactionFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'paid', label: 'Paid' },
  { key: 'refunded', label: 'Refunded' },
  { key: 'problems', label: 'Needs attention' },
  { key: 'abandoned', label: 'Abandoned' },
];

const WHEN = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: env.analytics.timezone });

type Params = { range?: string; from?: string; to?: string; filter?: string; q?: string; page?: string };

/**
 * Sales: what was sold, refunded and kept, for a period, with every figure defined in
 * `lib/commerce/reporting.ts`. Pending payments are never counted as revenue, a refund is
 * counted once however many times the gateway tells us about it, and a figure that cannot be
 * computed from recorded data (a conversion rate) is not shown at all.
 */
export default async function AdminSalesPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAdmin('/admin/sales');
  const params = await searchParams;

  const range = resolveSalesRange(params, new Date(), env.analytics.timezone);
  const filter = (FILTERS.find((f) => f.key === params.filter)?.key ?? 'all') as TransactionFilter;
  const search = (params.q ?? '').slice(0, 80);
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const [report, transactions, flagged] = await Promise.all([
    salesReport(range),
    listTransactions({ range, filter, search, page }),
    prisma.paymentTransaction.findMany({
      where: { flag: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, flag: true, amountMinor: true, orderId: true, providerPaymentId: true, createdAt: true },
    }),
  ]);

  const href = (next: Partial<Params>) => {
    const merged: Params = { range: range.key, from: range.from, to: range.to, filter, q: search, page: String(page), ...next };
    const out = new URLSearchParams();
    if (merged.range) out.set('range', merged.range);
    if (merged.range === 'custom') {
      out.set('from', merged.from ?? '');
      out.set('to', merged.to ?? '');
    }
    if (merged.filter && merged.filter !== 'all') out.set('filter', merged.filter);
    if (merged.q) out.set('q', merged.q);
    if (merged.page && merged.page !== '1') out.set('page', merged.page);
    return `/admin/sales?${out.toString()}`;
  };

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Sales"
        description={
          <>
            {range.label}. Times are on the {env.analytics.timezone} clock.
            {env.payments.mode === 'test' && <> <Badge variant="warning" className="ml-1">test mode</Badge></>}
          </>
        }
      />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => (
          <Link
            key={preset.key}
            href={href({ range: preset.key, page: '1' })}
            aria-current={range.key === preset.key ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-sm transition-colors',
              range.key === preset.key ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-secondary',
            )}
          >
            {preset.label}
          </Link>
        ))}
        <form method="get" action="/admin/sales" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="range" value="custom" />
          <label className="sr-only" htmlFor="from">From</label>
          <Input id="from" name="from" type="date" defaultValue={range.from} className="h-8 w-auto" />
          <span className="text-xs text-muted-foreground">to</span>
          <label className="sr-only" htmlFor="to">To</label>
          <Input id="to" name="to" type="date" defaultValue={range.to} className="h-8 w-auto" />
          <Button type="submit" size="sm" variant={range.key === 'custom' ? 'default' : 'outline'}>
            Apply
          </Button>
        </form>
      </div>

      {report.flaggedPayments > 0 && (
        <div className="mt-5 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-warning">
            <AlertTriangle className="size-4" /> {report.flaggedPayments} {report.flaggedPayments === 1 ? 'payment needs' : 'payments need'} a look
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Money arrived that did not match an order: a wrong amount, or a second payment on an order already paid. Nothing was
            unlocked by them. Refund them from the order page.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {flagged.map((payment) => (
              <li key={payment.id}>
                <Link href={`/admin/sales/orders/${payment.orderId}`} className="underline underline-offset-4 hover:text-primary">
                  {formatInr(payment.amountMinor)} · {payment.flag?.replace('_', ' ')} · {payment.providerPaymentId}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section aria-label="Figures" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gross sales" value={formatInr(report.grossMinor)} icon={Banknote} tone="primary" hint={`${report.orders} paid ${report.orders === 1 ? 'order' : 'orders'}`} />
        <StatCard label="Refunds" value={formatInr(report.refundsMinor)} icon={RotateCcw} tone="warning" hint={`${report.refundCount} ${report.refundCount === 1 ? 'refund' : 'refunds'} issued in this period`} />
        <StatCard label="Net sales" value={formatInr(report.netMinor)} icon={TrendingUp} tone="success" hint="Gross minus refunds" />
        <StatCard label="Average order" value={report.orders > 0 ? formatInr(report.averageOrderMinor) : '—'} icon={ShoppingBag} hint="Gross ÷ paid orders" />
        <StatCard label="Notes" value={formatInr(report.noteRevenueMinor)} icon={Receipt} hint="Gross from single notes" />
        <StatCard label="Bundles" value={formatInr(report.bundleRevenueMinor)} icon={PackageOpen} hint="Gross from bundles" />
        <StatCard label="Failed payments" value={report.failedOrders} tone={report.failedOrders ? 'warning' : 'default'} hint="Orders opened in this period that failed" />
        <StatCard label="Pending payments" value={report.pendingOrders} tone={report.pendingOrders ? 'warning' : 'default'} hint={`Not counted as revenue · ${report.abandonedOrders} abandoned checkouts`} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <TopList title="Best-selling notes" rows={report.topNotes} empty="No notes sold in this period." />
        <TopList title="Best-selling bundles" rows={report.topBundles} empty="No bundles sold in this period." />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Conversion rate is not shown: product views and checkout opens are not recorded, so there is nothing real to divide by.
      </p>

      <section className="mt-8" aria-label="Transactions">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Transactions</h2>
          <form method="get" action="/admin/sales" className="flex items-center gap-2">
            <input type="hidden" name="range" value={range.key} />
            {range.key === 'custom' && <input type="hidden" name="from" value={range.from} />}
            {range.key === 'custom' && <input type="hidden" name="to" value={range.to} />}
            <Select name="filter" defaultValue={filter} wrapperClassName="w-auto" aria-label="Filter">
              {FILTERS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Input name="q" defaultValue={search} placeholder="Email, order or payment id" className="h-9 w-56" aria-label="Search transactions" />
            <Button type="submit" variant="outline" size="sm">
              Search
            </Button>
          </form>
        </div>

        {transactions.rows.length === 0 ? (
          <EmptyState className="mt-4" icon={Receipt} title="No transactions here" description="Nothing matches this period and filter." />
        ) : (
          <div className="mt-3 rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      <Link href={`/admin/sales/orders/${row.id}`} className="hover:text-primary">
                        {WHEN.format(row.paidAt ?? row.createdAt)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.customerName ?? '—'}
                      <span className="block text-xs text-muted-foreground">{row.customerEmail ?? 'deleted account'}</span>
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-sm">{row.titles.join(', ')}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={row.status === 'PAID' ? 'success' : row.status === 'FAILED' ? 'destructive' : row.status === 'PENDING' ? 'warning' : 'secondary'}>
                          {describeStatus(row.status as OrderStatusValue)}
                        </Badge>
                        {row.flagged && <AlertTriangle className="size-3.5 text-warning" aria-label="Needs attention" />}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatInr(row.amountMinor)}
                      {row.refundedMinor > 0 && <span className="block text-xs text-muted-foreground">−{formatInr(row.refundedMinor)}</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {transactions.pages > 1 && (
          <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Pages">
            <Button asChild variant="outline" size="sm" disabled={page <= 1}>
              <Link href={href({ page: String(page - 1) })}>Previous</Link>
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {transactions.pages} · {transactions.total} orders
            </span>
            <Button asChild variant="outline" size="sm" disabled={page >= transactions.pages}>
              <Link href={href({ page: String(page + 1) })}>Next</Link>
            </Button>
          </nav>
        )}
      </section>
    </PageContainer>
  );
}

function TopList({ title, rows, empty }: { title: string; rows: TopProduct[]; empty: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ol className="mt-3 divide-y divide-border">
          {rows.map((row, index) => (
            <li key={row.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="w-5 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {row.units} sold · {formatInr(row.revenueMinor)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
