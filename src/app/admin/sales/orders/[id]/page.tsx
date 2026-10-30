import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { ActionButton } from '@/components/admin/action-button';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guards';
import { formatInr } from '@/lib/commerce/money';
import { describeStatus, isSale, type OrderStatusValue } from '@/lib/commerce/states';
import type { ContentSnapshot } from '@/lib/commerce/products';
import { recheckOrderAction, refundOrderAction, retryRefundAction } from '@/app/admin/_actions/commerce';

export const metadata: Metadata = { title: 'Order' };
export const dynamic = 'force-dynamic';

const WHEN = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: env.analytics.timezone });

/**
 * One order, in full: who, what, how much, how it was paid, what was refunded, and what access
 * it gave. Refunding here asks the gateway — see `lib/commerce/refunds.ts` — and changes nothing
 * until the gateway says it happened.
 */
export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, status: true } },
      items: { include: { grants: { select: { id: true, noteId: true, revokedAt: true, revokeReason: true, userId: true } } } },
      payments: { orderBy: { createdAt: 'asc' } },
      refunds: { orderBy: { createdAt: 'asc' }, include: { initiatedBy: { select: { email: true } } } },
    },
  });
  if (!order) notFound();

  const status = order.status as OrderStatusValue;
  const pendingRefund = order.refunds.filter((refund) => refund.status === 'PENDING').reduce((total, refund) => total + refund.amountMinor, 0);
  const refundable = order.amountMinor - order.refundedMinor - pendingRefund;
  const canRefund = isSale(status) && status !== 'REFUNDED' && refundable > 0 && env.payments.enabled;
  const flagged = order.payments.filter((payment) => payment.flag);

  return (
    <PageContainer className="max-w-5xl">
      <Link href="/admin/sales" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Sales
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Order {order.id.slice(-8).toUpperCase()}
            <Badge variant={status === 'PAID' ? 'success' : status === 'FAILED' ? 'destructive' : status === 'PENDING' ? 'warning' : 'secondary'}>
              {describeStatus(status)}
            </Badge>
          </span>
        }
        description={`${formatInr(order.amountMinor)} · created ${WHEN.format(order.createdAt)}${order.paidAt ? ` · paid ${WHEN.format(order.paidAt)}` : ''}`}
        actions={
          <>
            <ActionButton variant="outline" size="sm" action={recheckOrderAction.bind(null, order.id)} disabled={!env.payments.enabled}>
              Check with gateway
            </ActionButton>
            {canRefund && (
              <ActionButton
                variant="destructive"
                size="sm"
                action={refundOrderAction.bind(null, order.id, undefined)}
                confirm={{
                  title: `Refund ${formatInr(refundable)}?`,
                  description: `This sends a real refund request to the payment gateway for ${order.customerEmail ?? 'this customer'}. The order is marked refunded only after the gateway confirms it${refundable === order.amountMinor ? ', and the student loses access to what this order gave them (access from other sources is not affected)' : ''}. It cannot be undone.`,
                  confirmLabel: `Refund ${formatInr(refundable)}`,
                  destructive: true,
                }}
              >
                Refund {formatInr(refundable)}
              </ActionButton>
            )}
          </>
        }
      />

      {flagged.length > 0 && (
        <Alert variant="warning" title="A payment on this order needs attention" className="mt-4">
          {flagged.map((payment) => (
            <p key={payment.id}>
              {payment.providerPaymentId}: {payment.flag === 'amount_mismatch' ? `the amount (${formatInr(payment.amountMinor)}) did not match the order, so nothing was unlocked.` : payment.flag === 'duplicate_payment' ? 'a second payment on an order that was already paid. Nothing more was unlocked — refund it in the gateway dashboard.' : payment.flag}
            </p>
          ))}
        </Alert>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium">{order.customerName ?? '—'}</p>
            <p className="text-muted-foreground">{order.customerEmail ?? '—'}</p>
            {order.user ? (
              <Link href={`/admin/users/${order.user.id}`} className="text-xs underline underline-offset-4 hover:text-primary">
                View account
              </Link>
            ) : (
              <p className="text-xs text-muted-foreground">The account has since been deleted; this record is kept.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Gateway order </span>
              <code className="text-xs">{order.providerOrderId ?? '—'}</code>
            </p>
            {order.payments.length === 0 ? (
              <p className="text-muted-foreground">No payment attempt has been recorded.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {order.payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0">
                      <code className="text-xs">{payment.providerPaymentId}</code>
                      <span className="block text-xs text-muted-foreground">
                        {payment.method ?? 'payment'} · {payment.errorDescription ?? WHEN.format(payment.createdAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs tabular-nums">{formatInr(payment.amountMinor)}</span>
                      <Badge variant={payment.status === 'CAPTURED' ? 'success' : payment.status === 'FAILED' ? 'destructive' : 'secondary'}>
                        {payment.status.toLowerCase().replace('_', ' ')}
                      </Badge>
                      {payment.flag && <Badge variant="warning">{payment.flag.replace('_', ' ')}</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <CardTitle>What was bought</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {order.items.map((item) => {
            const contents = (item.contents as unknown as ContentSnapshot[]) ?? [];
            return (
              <div key={item.id} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {item.title} <span className="text-xs font-normal text-muted-foreground">({item.productType.toLowerCase()} · price paid {formatInr(item.amountMinor)})</span>
                  </p>
                </div>
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {contents.map((content) => {
                    const grant = item.grants.find((g) => g.noteId === content.noteId);
                    return (
                      <li key={content.noteId} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="min-w-0 truncate">{content.title}</span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                          <span className="tabular-nums">{formatInr(content.priceMinor)} at the time</span>
                          {grant ? (
                            grant.revokedAt ? (
                              <Badge variant="outline">revoked · {grant.revokeReason}</Badge>
                            ) : (
                              <Badge variant="success">access granted</Badge>
                            )
                          ) : (
                            <Badge variant="outline">no access</Badge>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <CardTitle>Refunds</CardTitle>
        </CardHeader>
        <CardContent>
          {order.refunds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No refunds.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border text-sm">
              {order.refunds.map((refund) => (
                <li key={refund.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium tabular-nums">{formatInr(refund.amountMinor)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {WHEN.format(refund.processedAt ?? refund.createdAt)} · {refund.initiatedBy?.email ?? 'made at the gateway'}
                      {refund.reason ? ` · ${refund.reason}` : ''}
                      {refund.failureReason ? ` · ${refund.failureReason}` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={refund.status === 'PROCESSED' ? 'success' : refund.status === 'FAILED' ? 'destructive' : 'warning'}>
                      {refund.status.toLowerCase()}
                    </Badge>
                    {refund.status === 'PENDING' && !refund.providerRefundId && (
                      <ActionButton variant="outline" size="sm" action={retryRefundAction.bind(null, refund.id)}>
                        Retry
                      </ActionButton>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {order.refundedMinor > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Refunded so far: {formatInr(order.refundedMinor)} of {formatInr(order.amountMinor)}.
            </p>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
