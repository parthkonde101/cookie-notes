import 'server-only';
import { prisma } from '@/lib/prisma';
import { AppError, Errors } from '@/lib/errors';
import { env } from '@/lib/env';
import {
  GatewayError,
  PaymentsDisabledError,
  getPaymentProvider,
  type GatewayPayment,
  type PaymentProvider,
} from '@/lib/commerce/provider';
import { resolveProduct, type ResolvedProduct } from '@/lib/commerce/products';
import { applyGatewayPayment, type ApplyPaymentResult } from '@/lib/commerce/fulfilment';
import { isPayable, isSale, type OrderStatusValue } from '@/lib/commerce/states';
import { CURRENCY } from '@/lib/commerce/money';

/**
 * Creating and confirming orders.
 *
 * What the browser may say: "I want this note/bundle" (type + id), and, after paying,
 * "here is what checkout gave me". What the server decides: the product, the price, the
 * currency, the notes delivered, who the order belongs to, and — by asking the gateway
 * itself — whether money actually arrived.
 */

/** An unpaid checkout is reused for this long, so a double-click or a retry opens one order, not two. */
const REUSE_WINDOW_MS = 30 * 60 * 1000;

export interface CheckoutSession {
  orderId: string;
  gatewayOrderId: string;
  amountMinor: number;
  currency: string;
  /** The PUBLIC key id; the secret never leaves the server. */
  keyId: string;
  title: string;
  /** Notes in the order the student already holds — shown as a notice, not discounted. */
  alreadyOwned: { noteId: string; title: string }[];
  prefill: { name: string; email: string };
  reused: boolean;
}

function providerOrThrow(): PaymentProvider {
  try {
    return getPaymentProvider();
  } catch (error) {
    if (error instanceof PaymentsDisabledError) throw paymentsUnavailable();
    throw error;
  }
}

function paymentsUnavailable(): AppError {
  return new AppError('Payments are not available right now. Please try again later.', {
    status: 503,
    code: 'payments_unavailable',
  });
}

/**
 * Opens (or re-opens) a checkout for one product.
 *
 * The whole thing runs in a transaction that first takes an advisory lock keyed on
 * (student, product): two clicks, two tabs, or a retry serialise behind each other, and
 * the second finds the first student's open order and returns it. The gateway call is
 * inside the transaction on purpose — if it fails, nothing is left behind.
 */
export async function createCheckout(input: {
  userId: string;
  productType: 'NOTE' | 'BUNDLE';
  productId: string;
}): Promise<CheckoutSession> {
  const provider = providerOrThrow();

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, name: true, status: true },
  });
  if (!user || user.status !== 'ACTIVE') throw Errors.forbidden('This account cannot make purchases.');

  const product = await resolveProduct(input.productType, input.productId, user.id);
  const lockKey = `checkout:${user.id}:${product.type}:${product.productId}`;

  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

        // An open order for this very product at this very price is reused.
        const open = await tx.order.findFirst({
          where: {
            userId: user.id,
            status: { in: ['CREATED', 'PENDING', 'FAILED'] },
            amountMinor: product.unitPriceMinor,
            providerOrderId: { not: null },
            createdAt: { gt: new Date(Date.now() - REUSE_WINDOW_MS) },
            items: {
              some:
                product.type === 'NOTE'
                  ? { productType: 'NOTE', noteId: product.productId }
                  : { productType: 'BUNDLE', bundleId: product.productId },
            },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (open?.providerOrderId) {
          return session(open.id, open.providerOrderId, open.amountMinor, open.currency, product, user, true);
        }

        // Any other unpaid order for this product is superseded (the price may have changed).
        await tx.order.updateMany({
          where: {
            userId: user.id,
            status: 'CREATED',
            items: {
              some:
                product.type === 'NOTE'
                  ? { productType: 'NOTE', noteId: product.productId }
                  : { productType: 'BUNDLE', bundleId: product.productId },
            },
          },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });

        const order = await tx.order.create({
          data: {
            userId: user.id,
            status: 'CREATED',
            amountMinor: product.unitPriceMinor,
            currency: CURRENCY,
            provider: provider.name,
            customerEmail: user.email,
            customerName: user.name,
            items: {
              create: {
                productType: product.type,
                noteId: product.type === 'NOTE' ? product.productId : null,
                bundleId: product.type === 'BUNDLE' ? product.productId : null,
                title: product.title,
                quantity: 1,
                unitPriceMinor: product.unitPriceMinor,
                discountMinor: 0,
                amountMinor: product.unitPriceMinor,
                currency: CURRENCY,
                contents: product.contents as unknown as object,
              },
            },
          },
        });
        await tx.order.update({ where: { id: order.id }, data: { receipt: order.id } });

        const gatewayOrder = await provider.createOrder({
          amountMinor: order.amountMinor,
          currency: order.currency,
          receipt: order.id,
          notes: { orderId: order.id, productType: product.type, productId: product.productId },
        });
        if (gatewayOrder.amountMinor !== order.amountMinor || gatewayOrder.currency !== order.currency) {
          throw new GatewayError('The payment gateway returned an unexpected amount.', { retryable: false });
        }

        await tx.order.update({ where: { id: order.id }, data: { providerOrderId: gatewayOrder.id } });
        return session(order.id, gatewayOrder.id, order.amountMinor, order.currency, product, user, false);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (error instanceof GatewayError) {
      console.error('[checkout] gateway error', error.status ?? '', error.options.code ?? '', error.message);
      throw new AppError('We could not start the payment. Please try again in a moment.', {
        status: 502,
        code: 'gateway_error',
      });
    }
    throw error;
  }

  function session(
    orderId: string,
    gatewayOrderId: string,
    amountMinor: number,
    currency: string,
    resolved: ResolvedProduct,
    buyer: { name: string; email: string },
    reused: boolean,
  ): CheckoutSession {
    return {
      orderId,
      gatewayOrderId,
      amountMinor,
      currency,
      keyId: provider.publicKeyId,
      title: resolved.title,
      alreadyOwned: resolved.alreadyOwned.map((owned) => ({ noteId: owned.noteId, title: owned.title })),
      prefill: { name: buyer.name, email: buyer.email },
      reused,
    };
  }
}

// ---------------------------------------------------------------------------
// After the student pays
// ---------------------------------------------------------------------------

export interface OrderOutcome {
  orderId: string;
  status: OrderStatusValue;
  /** True only when the SERVER has verified the payment with the gateway. */
  paid: boolean;
  message: string;
}

function outcome(orderId: string, status: OrderStatusValue): OrderOutcome {
  const paid = isSale(status);
  return {
    orderId,
    status,
    paid,
    message: paid
      ? 'Payment confirmed.'
      : status === 'PENDING'
        ? 'Your payment is being confirmed. This usually takes a few seconds.'
        : status === 'FAILED'
          ? 'The payment did not go through. You have not been charged.'
          : status === 'CANCELLED'
            ? 'This checkout was cancelled.'
            : 'We have not received your payment yet.',
  };
}

/**
 * The browser says it paid. We do not take its word for it:
 *
 *  1. the order must be this student's;
 *  2. the checkout signature (HMAC over OUR gateway order id and the payment id) must
 *     verify — a client cannot forge it without the key secret;
 *  3. we fetch the payment from the gateway and require it to belong to this order;
 *  4. `applyGatewayPayment` checks the amount and currency against OUR record and only
 *     then grants access.
 *
 * If the gateway cannot be reached the order is marked PENDING (the signature proved a
 * payment was attempted) and the webhook, or the next status check, settles it.
 */
export async function confirmCheckout(input: {
  userId: string;
  orderId: string;
  gatewayOrderId: string;
  paymentId: string;
  signature: string;
}): Promise<OrderOutcome> {
  const provider = providerOrThrow();

  const order = await prisma.order.findFirst({
    where: { id: input.orderId, userId: input.userId },
    select: { id: true, status: true, providerOrderId: true },
  });
  if (!order || !order.providerOrderId) throw Errors.notFound('We could not find that order.');

  // The client's claim about WHICH gateway order it paid must match ours.
  if (input.gatewayOrderId !== order.providerOrderId) {
    throw Errors.validation('That payment does not belong to this order.');
  }
  // Signed over OUR stored id, never over a value the client chose.
  const signatureOk = provider.verifyCheckoutSignature({
    orderId: order.providerOrderId,
    paymentId: input.paymentId,
    signature: input.signature,
  });
  if (!signatureOk) {
    console.error('[checkout] invalid checkout signature for order', order.id);
    throw Errors.validation('We could not verify that payment.');
  }

  let payment: GatewayPayment;
  try {
    payment = await provider.fetchPayment(input.paymentId);
  } catch (error) {
    if (error instanceof GatewayError && error.retryable) {
      await markPendingIfPayable(order.id);
      return outcome(order.id, 'PENDING');
    }
    throw Errors.validation('We could not verify that payment.');
  }

  if (payment.orderId !== order.providerOrderId) {
    throw Errors.validation('That payment does not belong to this order.');
  }

  const result = await applyGatewayPayment(order.id, payment);
  return outcome(order.id, result.orderStatus);
}

async function markPendingIfPayable(orderId: string): Promise<void> {
  await prisma.order.updateMany({ where: { id: orderId, status: 'CREATED' }, data: { status: 'PENDING' } });
}

/** Re-asks the gateway about every payment on an order and applies what it says. */
export async function reconcileOrder(orderId: string): Promise<ApplyPaymentResult | null> {
  if (!env.payments.enabled) return null;
  const provider = getPaymentProvider();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, providerOrderId: true },
  });
  if (!order?.providerOrderId) return null;

  const payments = await provider.fetchOrderPayments(order.providerOrderId);
  let last: ApplyPaymentResult | null = null;
  // Captured payments first, so a late "failed" attempt cannot be applied ahead of the success.
  const ordered = [...payments].sort((a, b) => rank(b) - rank(a));
  for (const payment of ordered) last = await applyGatewayPayment(order.id, payment);
  return last;
}

function rank(payment: GatewayPayment): number {
  return payment.state === 'captured' || payment.state === 'refunded' ? 2 : payment.state === 'authorized' ? 1 : 0;
}

/** How long a lazy re-check of an unfinished order waits between asks. */
const RECONCILE_EVERY_MS = 20_000;
/** An order older than this is not worth re-checking on a page view. */
const RECONCILE_WITHIN_MS = 48 * 60 * 60 * 1000;

/**
 * An order as its owner sees it. If it is unfinished, the gateway is asked (at most
 * every 20 seconds) whether a payment arrived, so a student whose browser closed — or
 * whose webhook was delayed — gets their purchase just by coming back.
 */
export async function getOrderForUser(orderId: string, userId: string) {
  let order = await prisma.order.findFirst({ where: { id: orderId, userId } });
  if (!order) throw Errors.notFound('We could not find that order.');

  const stale =
    isPayable(order.status as OrderStatusValue) &&
    order.providerOrderId &&
    Date.now() - order.createdAt.getTime() < RECONCILE_WITHIN_MS &&
    Date.now() - order.updatedAt.getTime() > RECONCILE_EVERY_MS;

  if (stale && env.payments.enabled) {
    try {
      await reconcileOrder(order.id);
    } catch (error) {
      console.error('[orders] reconcile failed', order.id, error instanceof Error ? error.message : 'error');
    }
    // Touch updatedAt even when nothing changed, which is what throttles the next ask.
    await prisma.order.update({ where: { id: order.id }, data: { updatedAt: new Date() } });
    order = (await prisma.order.findFirst({ where: { id: orderId, userId } })) ?? order;
  }

  return outcome(order.id, order.status as OrderStatusValue);
}
