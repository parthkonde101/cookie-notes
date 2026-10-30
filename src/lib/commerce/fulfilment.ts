import 'server-only';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';
import type { PaymentTxStatus } from '@/generated/prisma/enums';
import {
  canTransition,
  isPayable,
  isSale,
  statusAfterRefund,
  type OrderStatusValue,
} from '@/lib/commerce/states';
import type { GatewayPayment, GatewayRefund } from '@/lib/commerce/gateway';
import type { ContentSnapshot } from '@/lib/commerce/products';

/**
 * Turning what the gateway reports into orders, access and refunds.
 *
 * Every function here is IDEMPOTENT and runs inside one database transaction that
 * first takes a row lock on the order (`SELECT … FOR UPDATE`). The same gateway
 * payment arriving twice — a browser confirmation racing a webhook, or a webhook
 * redelivered — therefore serialises on the order and the second one finds the work
 * already done. There is no path from the browser to here: callers pass in a
 * payment or refund they have just verified with the gateway.
 *
 * The rules that matter, in the order they are applied:
 *
 *  - The payment must belong to this order's gateway order, or it is refused.
 *  - A payment grants access only if it is CAPTURED *and* its amount and currency
 *    equal what the server put on the order. A mismatch is recorded and flagged for a
 *    human; it never fulfils.
 *  - Access is granted once, on the transition into PAID. A replay never grants again,
 *    and never resurrects grants that a refund revoked.
 *  - A second captured payment on an order that is already paid is recorded and
 *    flagged `duplicate_payment`; it grants nothing and is refunded by an admin.
 *  - Status never moves backwards on out-of-order events (a late "failed" cannot undo
 *    a "captured").
 */

const PROVIDER = 'razorpay';

type Tx = Prisma.TransactionClient;

async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
}

const TX_RANK: Record<PaymentTxStatus, number> = {
  PENDING: 0,
  FAILED: 1,
  AUTHORIZED: 2,
  CAPTURED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
};

/** The state a gateway payment maps to. Refund bookkeeping is ours, not the gateway's. */
function txStatusFor(payment: GatewayPayment): PaymentTxStatus {
  switch (payment.state) {
    case 'captured':
    case 'refunded': // it was captured before it was refunded; our own refund rows say the rest
      return 'CAPTURED';
    case 'authorized':
      return 'AUTHORIZED';
    case 'failed':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

function isCaptured(payment: GatewayPayment): boolean {
  return payment.state === 'captured' || payment.state === 'refunded';
}

export interface ApplyPaymentResult {
  orderStatus: OrderStatusValue;
  /** Access was granted by THIS call (false on a replay or when nothing was owed). */
  fulfilled: boolean;
  /** Something about the payment needs a human; see PaymentTransaction.flag. */
  flag: string | null;
}

/**
 * Records a payment the caller has already verified with the gateway, and — only if
 * it is a genuine, correct, captured payment — marks the order paid and grants access.
 */
export async function applyGatewayPayment(
  orderId: string,
  payment: GatewayPayment,
): Promise<ApplyPaymentResult> {
  return prisma.$transaction(
    async (tx) => {
      await lockOrder(tx, orderId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new Error('Order not found while recording a payment.');

      if (!order.providerOrderId || payment.orderId !== order.providerOrderId) {
        throw new Error('Payment does not belong to this order.');
      }

      const existing = await tx.paymentTransaction.findUnique({
        where: { provider_providerPaymentId: { provider: PROVIDER, providerPaymentId: payment.id } },
      });
      if (existing && existing.orderId !== order.id) {
        throw new Error('Payment is already recorded against a different order.');
      }

      const incoming = txStatusFor(payment);
      const status: PaymentTxStatus =
        existing && TX_RANK[existing.status] > TX_RANK[incoming] ? existing.status : incoming;

      const captured = isCaptured(payment) || (existing ? TX_RANK[existing.status] >= TX_RANK.CAPTURED : false);
      const amountsMatch = payment.amountMinor === order.amountMinor && payment.currency === order.currency;

      // A sale is already on this order, made by a different payment.
      const soldByAnother = isSale(order.status as OrderStatusValue) && order.providerPaymentId !== payment.id;

      let flag = existing?.flag ?? null;
      if (captured && !amountsMatch) flag = 'amount_mismatch';
      else if (captured && soldByAnother) flag = 'duplicate_payment';

      const failedNow = payment.state === 'failed' && status === 'FAILED';
      await tx.paymentTransaction.upsert({
        where: { provider_providerPaymentId: { provider: PROVIDER, providerPaymentId: payment.id } },
        create: {
          orderId: order.id,
          provider: PROVIDER,
          providerPaymentId: payment.id,
          providerOrderId: payment.orderId,
          status,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          method: payment.method,
          errorCode: payment.errorCode,
          errorDescription: payment.errorDescription?.slice(0, 300) ?? null,
          flag,
          capturedAt: captured ? new Date() : null,
          failedAt: failedNow ? new Date() : null,
        },
        update: {
          status,
          method: payment.method ?? undefined,
          flag,
          ...(existing?.capturedAt || !captured ? {} : { capturedAt: new Date() }),
          ...(failedNow && !existing?.failedAt ? { failedAt: new Date() } : {}),
          ...(payment.state === 'failed' && status === 'FAILED'
            ? { errorCode: payment.errorCode, errorDescription: payment.errorDescription?.slice(0, 300) ?? null }
            : {}),
        },
      });

      const current = order.status as OrderStatusValue;

      // --- a genuine, correct, captured payment: this is what pays an order ---
      if (captured && amountsMatch && !soldByAnother) {
        if (isSale(current)) {
          // Replay of the payment that already paid this order: nothing to do.
          return { orderStatus: current, fulfilled: false, flag };
        }
        if (!canTransition(current, 'PAID')) {
          return { orderStatus: current, fulfilled: false, flag };
        }

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'PAID',
            paidAt: new Date(),
            providerPaymentId: payment.id,
            failedAt: null,
            cancelledAt: null,
          },
        });

        if (order.userId) {
          const wanted = order.items.flatMap((item) =>
            ((item.contents as unknown as ContentSnapshot[]) ?? []).map((content) => ({
              userId: order.userId as string,
              noteId: content.noteId,
              orderItemId: item.id,
            })),
          );
          // A note deleted between checkout and payment cannot be granted; the rest are.
          const existingNotes = new Set(
            (
              await tx.note.findMany({
                where: { id: { in: wanted.map((row) => row.noteId) } },
                select: { id: true },
              })
            ).map((note) => note.id),
          );
          const grants = wanted.filter((row) => existingNotes.has(row.noteId));
          if (grants.length > 0) await tx.purchaseGrant.createMany({ data: grants, skipDuplicates: true });
          if (grants.length < wanted.length) {
            await tx.paymentTransaction.update({
              where: { provider_providerPaymentId: { provider: PROVIDER, providerPaymentId: payment.id } },
              data: { flag: 'content_missing' },
            });
          }
        }
        return { orderStatus: 'PAID', fulfilled: true, flag };
      }

      // --- captured but not fulfilled: recorded and flagged, never silently dropped ---
      if (captured) {
        if (current === 'CREATED' && canTransition(current, 'PENDING')) {
          await tx.order.update({ where: { id: order.id }, data: { status: 'PENDING' } });
          return { orderStatus: 'PENDING', fulfilled: false, flag };
        }
        return { orderStatus: current, fulfilled: false, flag };
      }

      // --- authorised: money is held, not yet captured ---
      if (payment.state === 'authorized') {
        if (isPayable(current) && current !== 'PENDING' && canTransition(current, 'PENDING')) {
          await tx.order.update({ where: { id: order.id }, data: { status: 'PENDING' } });
          return { orderStatus: 'PENDING', fulfilled: false, flag };
        }
        return { orderStatus: current, fulfilled: false, flag };
      }

      // --- failed: the order fails only if nothing else is in flight or paid ---
      if (payment.state === 'failed') {
        const live = await tx.paymentTransaction.count({
          where: {
            orderId: order.id,
            status: { in: ['AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          },
        });
        if (live === 0 && isPayable(current) && current !== 'FAILED' && canTransition(current, 'FAILED')) {
          await tx.order.update({ where: { id: order.id }, data: { status: 'FAILED', failedAt: new Date() } });
          return { orderStatus: 'FAILED', fulfilled: false, flag };
        }
      }
      return { orderStatus: current, fulfilled: false, flag };
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export interface ApplyRefundResult {
  orderId: string;
  orderStatus: OrderStatusValue;
  refundStatus: 'PENDING' | 'PROCESSED' | 'FAILED';
  revokedGrants: number;
}

/**
 * Records a refund the gateway has reported (one an admin asked for here, or one made
 * in the gateway's own dashboard), updates the totals, and — only when the order is
 * now refunded IN FULL — revokes the access that exact order delivered.
 *
 * A partial refund leaves access in place: the student paid for the content and was
 * returned part of the price. Revocation touches `purchase_grants` rows of this order's
 * items only, so an admin grant or a promotion for the same note is never affected.
 */
export async function applyGatewayRefund(refund: GatewayRefund): Promise<ApplyRefundResult> {
  const transaction = await prisma.paymentTransaction.findUnique({
    where: { provider_providerPaymentId: { provider: PROVIDER, providerPaymentId: refund.paymentId } },
    select: { id: true, orderId: true },
  });
  if (!transaction) throw new UnknownPaymentError(refund.paymentId);

  return prisma.$transaction(
    async (tx) => {
      await lockOrder(tx, transaction.orderId);
      const order = await tx.order.findUnique({ where: { id: transaction.orderId } });
      if (!order) throw new Error('Order not found while recording a refund.');

      // Our own request is found by its receipt; one made at the gateway is new to us.
      const byGateway = await tx.refund.findUnique({
        where: { provider_providerRefundId: { provider: PROVIDER, providerRefundId: refund.id } },
      });
      const byReceipt =
        !byGateway && refund.receipt
          ? await tx.refund.findUnique({ where: { receipt: refund.receipt } })
          : null;
      const known = byGateway ?? byReceipt;

      // Never move a settled refund backwards (a late "pending" after "processed").
      const nextStatus: 'PENDING' | 'PROCESSED' | 'FAILED' =
        known?.status === 'PROCESSED' ? 'PROCESSED' : refund.state === 'processed' ? 'PROCESSED' : refund.state === 'failed' ? 'FAILED' : 'PENDING';

      let row = known;
      if (!row) {
        row = await tx.refund.create({
          data: {
            orderId: order.id,
            paymentTransactionId: transaction.id,
            provider: PROVIDER,
            providerRefundId: refund.id,
            receipt: refund.receipt && refund.receipt.length <= 40 ? refund.receipt : `ext_${refund.id}`,
            amountMinor: refund.amountMinor,
            status: nextStatus,
            reason: 'Made in the gateway dashboard',
            processedAt: nextStatus === 'PROCESSED' ? new Date() : null,
            failedAt: nextStatus === 'FAILED' ? new Date() : null,
          },
        });
      } else {
        row = await tx.refund.update({
          where: { id: row.id },
          data: {
            providerRefundId: refund.id,
            status: nextStatus,
            processedAt: nextStatus === 'PROCESSED' && !row.processedAt ? new Date() : undefined,
            failedAt: nextStatus === 'FAILED' && !row.failedAt ? new Date() : undefined,
          },
        });
      }

      // Totals are recomputed from the refund rows, so applying the same event twice
      // yields the same numbers.
      const processed = await tx.refund.findMany({
        where: { orderId: order.id, status: 'PROCESSED' },
        select: { amountMinor: true, paymentTransactionId: true },
      });
      const refundedMinor = Math.min(
        order.amountMinor,
        processed.reduce((total, r) => total + r.amountMinor, 0),
      );
      const paymentRow = await tx.paymentTransaction.findUnique({
        where: { id: transaction.id },
        select: { amountMinor: true },
      });
      const paymentRefunded = Math.min(
        paymentRow?.amountMinor ?? 0,
        processed
          .filter((r) => r.paymentTransactionId === transaction.id)
          .reduce((total, r) => total + r.amountMinor, 0),
      );
      await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          refundedMinor: paymentRefunded,
          status:
            paymentRefunded <= 0
              ? undefined
              : paymentRefunded >= (paymentRow?.amountMinor ?? 0)
                ? 'REFUNDED'
                : 'PARTIALLY_REFUNDED',
        },
      });

      const current = order.status as OrderStatusValue;
      let orderStatus = current;
      let revoked = 0;
      if (isSale(current) && refundedMinor > 0) {
        const target = statusAfterRefund(order.amountMinor, refundedMinor);
        if (target !== 'PAID' && canTransition(current, target)) orderStatus = target;
        await tx.order.update({
          where: { id: order.id },
          data: { refundedMinor, status: orderStatus },
        });

        if (orderStatus === 'REFUNDED') {
          const result = await tx.purchaseGrant.updateMany({
            where: { orderItem: { orderId: order.id }, revokedAt: null },
            data: { revokedAt: new Date(), revokeReason: 'refund', refundId: row.id },
          });
          revoked = result.count;
        }
      } else if (refundedMinor !== order.refundedMinor) {
        await tx.order.update({ where: { id: order.id }, data: { refundedMinor } });
      }

      return { orderId: order.id, orderStatus, refundStatus: nextStatus, revokedGrants: revoked };
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
}

/** The refund names a payment we have not recorded yet; the caller fetches it first. */
export class UnknownPaymentError extends Error {
  constructor(readonly paymentId: string) {
    super('Refund refers to a payment that has not been recorded yet.');
    this.name = 'UnknownPaymentError';
  }
}

/** A short, unique, gateway-safe receipt (≤ 40 characters) for a refund request. */
export function newRefundReceipt(): string {
  return `rf_${randomBytes(9).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Student withdrawal
// ---------------------------------------------------------------------------

/**
 * The student closed checkout. Marks a never-started order CANCELLED; it grants
 * nothing, and a payment that completes anyway still pays the order (see states.ts).
 * Safe for a client to call because the worst it can do is abandon its own order.
 */
export async function cancelUnstartedOrder(orderId: string, userId: string): Promise<OrderStatusValue> {
  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findFirst({ where: { id: orderId, userId } });
    if (!order) throw new Error('not found');
    const current = order.status as OrderStatusValue;
    if (current !== 'CREATED' && current !== 'FAILED') return current;
    const payments = await tx.paymentTransaction.count({
      where: { orderId, status: { in: ['AUTHORIZED', 'CAPTURED'] } },
    });
    if (payments > 0) return current;
    await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    return 'CANCELLED';
  });
}
