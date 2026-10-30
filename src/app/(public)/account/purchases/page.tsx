import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth/guards';
import { env } from '@/lib/env';
import { getOrderForUser } from '@/lib/commerce/orders';
import { formatInr } from '@/lib/commerce/money';
import { describeStatus, isSale, type OrderStatusValue } from '@/lib/commerce/states';
import type { ContentSnapshot } from '@/lib/commerce/products';

export const metadata: Metadata = { title: 'My purchases' };
export const dynamic = 'force-dynamic';

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/**
 * Everything the signed-in student has bought: what, when, how much, and a way in.
 *
 * Their own orders only (the query is scoped to the session's user and nothing from the URL
 * names whose to show). An order whose payment may have gone through while the browser was
 * closed is re-checked with the gateway here, so coming back to this page is itself a way
 * to recover a purchase.
 */
export default async function PurchasesPage() {
  const { user } = await requireUser('/account/purchases');

  // Orders that might have been paid without us hearing yet: ask the gateway, a few at most.
  if (env.payments.enabled) {
    const unfinished = await prisma.order.findMany({
      where: { userId: user.id, status: { in: ['CREATED', 'PENDING', 'FAILED'] }, createdAt: { gt: new Date(Date.now() - 48 * 3600_000) }, providerOrderId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true },
    });
    for (const order of unfinished) await getOrderForUser(order.id, user.id).catch(() => undefined);
  }

  const orders = await prisma.order.findMany({
    where: { userId: user.id, status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING'] } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      items: { include: { grants: { where: { userId: user.id }, select: { noteId: true, revokedAt: true } } } },
      payments: { where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, select: { providerPaymentId: true }, take: 1 },
    },
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="border-b border-border pb-6">
        <Link href="/account" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← Account
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">My purchases</h1>
        <p className="mt-1 text-sm text-muted-foreground">Notes and bundles you have bought. They are yours to keep.</p>
      </header>

      {orders.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={Receipt}
          title="No purchases yet"
          description="When you buy a note or a bundle it appears here, with a link straight to it."
        />
      ) : (
        <ul className="mt-6 space-y-4">
          {orders.map((order) => {
            const status = order.status as OrderStatusValue;
            const sale = isSale(status);
            return (
              <li key={order.id}>
                <Card>
                  <CardContent className="space-y-4 p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">
                          {DATE.format(order.paidAt ?? order.createdAt)} · Order {order.id.slice(-8).toUpperCase()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={status === 'PAID' ? 'success' : status === 'PENDING' ? 'warning' : status === 'REFUNDED' ? 'outline' : 'secondary'}>
                          {describeStatus(status)}
                        </Badge>
                        <span className="text-sm font-medium tabular-nums">{formatInr(order.amountMinor)}</span>
                      </div>
                    </div>

                    {order.items.map((item) => {
                      const contents = (item.contents as unknown as ContentSnapshot[]) ?? [];
                      const live = new Set(item.grants.filter((grant) => !grant.revokedAt).map((grant) => grant.noteId));
                      return (
                        <div key={item.id} className="space-y-2">
                          <div className="flex items-center gap-2">
                            <h2 className="min-w-0 text-base font-medium leading-snug">{item.title}</h2>
                            {item.productType === 'BUNDLE' && <Badge variant="outline">bundle · {contents.length} notes</Badge>}
                          </div>
                          {sale ? (
                            <ul className="divide-y divide-border rounded-md border border-border">
                              {contents.map((content) => (
                                <li key={content.noteId} className="flex items-center gap-3 px-3 py-2 text-sm">
                                  <span className="min-w-0 flex-1 truncate">{content.title}</span>
                                  {live.has(content.noteId) ? (
                                    <Button asChild size="sm" variant="outline">
                                      <Link href={`/notes/${content.noteId}`}>
                                        Open <ArrowRight className="size-3.5" />
                                      </Link>
                                    </Button>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">{status === 'REFUNDED' ? 'Refunded' : 'Unavailable'}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              We are confirming this payment with the bank. It unlocks automatically the moment it is confirmed —
                              there is nothing you need to do, and you will not be charged twice.
                            </p>
                          )}
                        </div>
                      );
                    })}

                    {(order.refundedMinor > 0 || order.payments[0]) && (
                      <p className="text-xs text-muted-foreground">
                        {order.payments[0] && <>Payment reference {order.payments[0].providerPaymentId}</>}
                        {order.refundedMinor > 0 && <> · Refunded {formatInr(order.refundedMinor)}</>}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
