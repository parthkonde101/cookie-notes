import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';
import type { SalesRange } from '@/lib/commerce/ranges';

/**
 * What the sales dashboard shows, and exactly how each number is defined.
 *
 *   Gross sales      the amounts of orders PAID in the period (by the time payment was
 *                    confirmed), counting every order that was paid and has not been
 *                    voided — including ones refunded later, which the refund line takes back.
 *   Refunds          refunds PROCESSED in the period, whatever month the order was in.
 *   Net sales        gross − refunds, for the same period.
 *   Orders           the number of orders in gross.
 *   Average order    gross ÷ orders.
 *   Failed / pending orders OPENED in the period that failed or are still confirming. They are
 *                    never revenue. Orders merely opened and abandoned are counted apart.
 *   By type          the gross, split by what was sold (a note or a bundle).
 *   Best sellers     the most-bought notes and bundles among orders that are still sales
 *                    (fully refunded orders are left out of the ranking).
 *
 * Everything is a database aggregate over persisted rows, so a duplicate webhook — which
 * writes nothing new — cannot move a number, and nothing is totalled in the browser. A
 * conversion rate is deliberately absent: product views and checkout opens are not recorded,
 * so there is nothing to divide by.
 */

const SALE_STATUSES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export interface TopProduct {
  id: string;
  title: string;
  units: number;
  revenueMinor: number;
}

export interface SalesReport {
  grossMinor: number;
  orders: number;
  refundsMinor: number;
  refundCount: number;
  netMinor: number;
  averageOrderMinor: number;
  failedOrders: number;
  pendingOrders: number;
  abandonedOrders: number;
  noteRevenueMinor: number;
  bundleRevenueMinor: number;
  topNotes: TopProduct[];
  topBundles: TopProduct[];
  flaggedPayments: number;
}

export interface SalesTotals {
  grossMinor: number;
  orders: number;
  refundsMinor: number;
  refundCount: number;
  netMinor: number;
}

/**
 * Just the money lines, for places that only need a headline (the admin overview). Defined
 * exactly as in `salesReport` — paid-in-period gross, processed-in-period refunds, net — but
 * three aggregates instead of the whole dashboard. With no `range` it is all time.
 */
export async function salesTotals(range?: Pick<SalesRange, 'start' | 'end'>): Promise<SalesTotals> {
  const [gross, refunds] = await Promise.all([
    prisma.order.aggregate({
      where: {
        status: { in: [...SALE_STATUSES] },
        paidAt: range ? { gte: range.start, lt: range.end } : { not: null },
      },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    prisma.refund.aggregate({
      where: {
        status: 'PROCESSED',
        processedAt: range ? { gte: range.start, lt: range.end } : { not: null },
      },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
  ]);
  const grossMinor = gross._sum.amountMinor ?? 0;
  const refundsMinor = refunds._sum.amountMinor ?? 0;
  return {
    grossMinor,
    orders: gross._count._all,
    refundsMinor,
    refundCount: refunds._count._all,
    netMinor: grossMinor - refundsMinor,
  };
}

export async function salesReport(range: SalesRange): Promise<SalesReport> {
  const paid: Prisma.OrderWhereInput = {
    status: { in: [...SALE_STATUSES] },
    paidAt: { gte: range.start, lt: range.end },
  };
  const opened: Prisma.OrderWhereInput = { createdAt: { gte: range.start, lt: range.end } };

  const [gross, refunds, failed, pending, abandoned, byType, topNotes, topBundles, flagged] = await Promise.all([
    prisma.order.aggregate({ where: paid, _sum: { amountMinor: true }, _count: { _all: true } }),
    prisma.refund.aggregate({
      where: { status: 'PROCESSED', processedAt: { gte: range.start, lt: range.end } },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    prisma.order.count({ where: { ...opened, status: 'FAILED' } }),
    prisma.order.count({ where: { ...opened, status: 'PENDING' } }),
    prisma.order.count({ where: { ...opened, status: { in: ['CREATED', 'CANCELLED'] } } }),
    prisma.orderItem.groupBy({
      by: ['productType'],
      where: { order: paid },
      _sum: { amountMinor: true },
    }),
    top('noteId', range),
    top('bundleId', range),
    prisma.paymentTransaction.count({ where: { flag: { not: null } } }),
  ]);

  const grossMinor = gross._sum.amountMinor ?? 0;
  const orders = gross._count._all;
  const refundsMinor = refunds._sum.amountMinor ?? 0;
  const typeSum = (type: 'NOTE' | 'BUNDLE') => byType.find((row) => row.productType === type)?._sum.amountMinor ?? 0;

  return {
    grossMinor,
    orders,
    refundsMinor,
    refundCount: refunds._count._all,
    netMinor: grossMinor - refundsMinor,
    averageOrderMinor: orders > 0 ? Math.round(grossMinor / orders) : 0,
    failedOrders: failed,
    pendingOrders: pending,
    abandonedOrders: abandoned,
    noteRevenueMinor: typeSum('NOTE'),
    bundleRevenueMinor: typeSum('BUNDLE'),
    topNotes,
    topBundles,
    flaggedPayments: flagged,
  };
}

/** The best sellers of one kind. `column` is a fixed identifier, never user input. */
async function top(column: 'noteId' | 'bundleId', range: SalesRange): Promise<TopProduct[]> {
  const rows =
    column === 'noteId'
      ? await prisma.$queryRaw<{ id: string; title: string; units: bigint; revenue: bigint }[]>`
          SELECT oi."noteId" AS id,
                 (array_agg(oi."title" ORDER BY o."paidAt" DESC))[1] AS title,
                 count(*) AS units,
                 COALESCE(sum(oi."amountMinor"), 0) AS revenue
          FROM "order_items" oi
          JOIN "orders" o ON o."id" = oi."orderId"
          WHERE oi."noteId" IS NOT NULL
            AND o."status" IN ('PAID', 'PARTIALLY_REFUNDED')
            AND o."paidAt" >= ${range.start} AND o."paidAt" < ${range.end}
          GROUP BY oi."noteId"
          ORDER BY count(*) DESC, sum(oi."amountMinor") DESC
          LIMIT 5`
      : await prisma.$queryRaw<{ id: string; title: string; units: bigint; revenue: bigint }[]>`
          SELECT oi."bundleId" AS id,
                 (array_agg(oi."title" ORDER BY o."paidAt" DESC))[1] AS title,
                 count(*) AS units,
                 COALESCE(sum(oi."amountMinor"), 0) AS revenue
          FROM "order_items" oi
          JOIN "orders" o ON o."id" = oi."orderId"
          WHERE oi."bundleId" IS NOT NULL
            AND o."status" IN ('PAID', 'PARTIALLY_REFUNDED')
            AND o."paidAt" >= ${range.start} AND o."paidAt" < ${range.end}
          GROUP BY oi."bundleId"
          ORDER BY count(*) DESC, sum(oi."amountMinor") DESC
          LIMIT 5`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    units: Number(row.units),
    revenueMinor: Number(row.revenue),
  }));
}

export type TransactionFilter = 'all' | 'paid' | 'refunded' | 'problems' | 'abandoned';

export interface TransactionRow {
  id: string;
  createdAt: Date;
  paidAt: Date | null;
  status: string;
  amountMinor: number;
  refundedMinor: number;
  customerEmail: string | null;
  customerName: string | null;
  titles: string[];
  flagged: boolean;
}

export const TRANSACTIONS_PER_PAGE = 20;

/** One page of orders opened in the period, newest first. Paginated in the database. */
export async function listTransactions(input: {
  range: SalesRange;
  filter: TransactionFilter;
  search: string;
  page: number;
}): Promise<{ rows: TransactionRow[]; total: number; pages: number }> {
  const statusFilter: Prisma.OrderWhereInput =
    input.filter === 'paid'
      ? { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } }
      : input.filter === 'refunded'
        ? { status: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } }
        : input.filter === 'problems'
          ? { OR: [{ status: { in: ['FAILED', 'PENDING'] } }, { payments: { some: { flag: { not: null } } } }] }
          : input.filter === 'abandoned'
            ? { status: { in: ['CREATED', 'CANCELLED'] } }
            : {};

  const term = input.search.trim();
  const where: Prisma.OrderWhereInput = {
    createdAt: { gte: input.range.start, lt: input.range.end },
    ...statusFilter,
    ...(term
      ? {
          OR: [
            { id: { contains: term, mode: 'insensitive' } },
            { customerEmail: { contains: term, mode: 'insensitive' } },
            { customerName: { contains: term, mode: 'insensitive' } },
            { providerPaymentId: { contains: term, mode: 'insensitive' } },
            { items: { some: { title: { contains: term, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (Math.max(1, input.page) - 1) * TRANSACTIONS_PER_PAGE,
      take: TRANSACTIONS_PER_PAGE,
      select: {
        id: true,
        createdAt: true,
        paidAt: true,
        status: true,
        amountMinor: true,
        refundedMinor: true,
        customerEmail: true,
        customerName: true,
        items: { select: { title: true } },
        payments: { where: { flag: { not: null } }, select: { id: true }, take: 1 },
      },
    }),
  ]);

  return {
    total,
    pages: Math.max(1, Math.ceil(total / TRANSACTIONS_PER_PAGE)),
    rows: orders.map((order) => ({
      id: order.id,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      status: order.status,
      amountMinor: order.amountMinor,
      refundedMinor: order.refundedMinor,
      customerEmail: order.customerEmail,
      customerName: order.customerName,
      titles: order.items.map((item) => item.title),
      flagged: order.payments.length > 0,
    })),
  };
}
