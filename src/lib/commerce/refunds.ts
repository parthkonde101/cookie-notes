import 'server-only';
import { prisma } from '@/lib/prisma';
import { AppError, Errors } from '@/lib/errors';
import { GatewayError, PaymentsDisabledError, getPaymentProvider } from '@/lib/commerce/provider';
import { applyGatewayRefund, newRefundReceipt } from '@/lib/commerce/fulfilment';
import { isSale, type OrderStatusValue } from '@/lib/commerce/states';

/**
 * Refunding, from the admin side.
 *
 * Nothing here changes an order's status. It asks the gateway for a refund and records
 * what the gateway answers; the order, its totals and the access it gave are updated by
 * `applyGatewayRefund` from the GATEWAY'S report (the immediate API answer, and later the
 * `refund.processed` webhook). A local "refunded" flag set without the gateway agreeing
 * is exactly what this module exists to prevent.
 *
 * The refund row is written BEFORE the gateway is called, and its `receipt` is sent as
 * the gateway's idempotency key: if the call times out and is retried, the gateway sees the
 * same receipt and does not refund twice, and the pending row shows an admin what happened.
 */

export interface RefundRequestResult {
  refundId: string;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  amountMinor: number;
  orderStatus: OrderStatusValue;
}

export async function requestRefund(input: {
  orderId: string;
  adminId: string;
  /** Omit for the full remaining amount. */
  amountMinor?: number;
  reason?: string;
}): Promise<RefundRequestResult> {
  let provider;
  try {
    provider = getPaymentProvider();
  } catch (error) {
    if (error instanceof PaymentsDisabledError) {
      throw new AppError('Payments are not configured, so refunds cannot be made from here.', {
        status: 503,
        code: 'payments_unavailable',
      });
    }
    throw error;
  }

  const prepared = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${input.orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: input.orderId } });
      if (!order) throw Errors.notFound('That order no longer exists.');
      if (!isSale(order.status as OrderStatusValue) || order.status === 'REFUNDED') {
        throw Errors.conflict('Only a paid order that has not been fully refunded can be refunded.');
      }
      if (!order.providerPaymentId) throw Errors.conflict('This order has no recorded payment to refund.');

      const payment = await tx.paymentTransaction.findUnique({
        where: { provider_providerPaymentId: { provider: provider.name, providerPaymentId: order.providerPaymentId } },
      });
      if (!payment) throw Errors.conflict('The payment for this order is not recorded.');

      const pending = await tx.refund.aggregate({
        where: { orderId: order.id, status: 'PENDING' },
        _sum: { amountMinor: true },
      });
      const remaining = order.amountMinor - order.refundedMinor - (pending._sum.amountMinor ?? 0);
      if (remaining <= 0) throw Errors.conflict('There is nothing left to refund on this order.');

      const amountMinor = input.amountMinor ?? remaining;
      if (!Number.isInteger(amountMinor) || amountMinor < 100 || amountMinor > remaining) {
        throw Errors.validation('Enter a refund of at least ₹1 and no more than the amount still refundable.');
      }

      const refund = await tx.refund.create({
        data: {
          orderId: order.id,
          paymentTransactionId: payment.id,
          provider: provider.name,
          receipt: newRefundReceipt(),
          amountMinor,
          status: 'PENDING',
          reason: input.reason?.slice(0, 280) || null,
          initiatedById: input.adminId,
        },
      });
      return { refund, paymentId: payment.providerPaymentId, orderId: order.id };
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  return send(prepared.refund.id, prepared.paymentId, prepared.refund.receipt, prepared.refund.amountMinor, prepared.orderId);
}

async function adoptExisting(paymentId: string, receipt: string) {
  const held = await getPaymentProvider().fetchPaymentRefunds(paymentId);
  return held.find((refund) => refund.receipt === receipt) ?? null;
}

/** Re-sends a refund that never got a gateway answer, with the SAME receipt. */
export async function retryRefund(refundId: string): Promise<RefundRequestResult> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { transaction: { select: { providerPaymentId: true } } },
  });
  if (!refund) throw Errors.notFound('That refund no longer exists.');
  if (refund.status !== 'PENDING' || refund.providerRefundId) {
    throw Errors.conflict('This refund has already been sent to the gateway.');
  }
  return send(refund.id, refund.transaction.providerPaymentId, refund.receipt, refund.amountMinor, refund.orderId);
}

async function send(
  refundId: string,
  paymentId: string,
  receipt: string,
  amountMinor: number,
  orderId: string,
): Promise<RefundRequestResult> {
  const provider = getPaymentProvider();
  try {
    const gatewayRefund = await provider.refundPayment({
      paymentId,
      amountMinor,
      receipt,
      notes: { orderId, refundId },
    });
    const applied = await applyGatewayRefund(gatewayRefund);
    return { refundId, status: applied.refundStatus, amountMinor, orderStatus: applied.orderStatus };
  } catch (error) {
    if (error instanceof GatewayError) {
      // Did the gateway already take this refund (a retry after a lost answer, or a
      // "duplicate receipt" refusal)? If it holds one with our receipt, adopt it rather
      // than reporting a failure that did not happen — or sending it twice.
      const adopted = await adoptExisting(paymentId, receipt).catch(() => null);
      if (adopted) {
        const applied = await applyGatewayRefund(adopted);
        return { refundId, status: applied.refundStatus, amountMinor, orderStatus: applied.orderStatus };
      }
      if (!error.retryable) {
        // The gateway refused it outright (e.g. the payment is older than it allows).
        await prisma.refund.update({
          where: { id: refundId },
          data: { status: 'FAILED', failedAt: new Date(), failureReason: error.message.slice(0, 280) },
        });
        throw new AppError(`The payment gateway refused this refund: ${error.message}`, {
          status: 422,
          code: 'refund_refused',
        });
      }
      // A timeout or a 5xx: the request may or may not have reached the gateway. The row
      // stays PENDING; the webhook will settle it, or an admin can retry with the same receipt.
      throw new AppError(
        'The refund was requested but the gateway did not confirm it yet. It is shown as pending; check again shortly or retry it.',
        { status: 502, code: 'refund_unconfirmed' },
      );
    }
    throw error;
  }
}
