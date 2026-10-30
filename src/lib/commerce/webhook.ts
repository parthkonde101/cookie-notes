import 'server-only';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@/generated/prisma/client';
import { AppError } from '@/lib/errors';
import { PaymentsDisabledError, getPaymentProvider } from '@/lib/commerce/provider';
import { toPayment, toRefund } from '@/lib/commerce/razorpay';
import { applyGatewayPayment, applyGatewayRefund, UnknownPaymentError } from '@/lib/commerce/fulfilment';

/**
 * Razorpay webhooks.
 *
 * What makes this safe:
 *
 *  - The signature is checked against the UNMODIFIED raw body before anything is read
 *    from it. A failure is a 400 and nothing is recorded.
 *  - The delivery is written to `payment_events` (unique on the gateway's event id)
 *    BEFORE it is acted on, so a crash after receipt is recoverable: the row is still
 *    RECEIVED/FAILED, the gateway gets a non-2xx, and its redelivery is processed.
 *  - A redelivery of an event already PROCESSED is answered 200 and does nothing.
 *  - For "payment captured" the gateway is asked for the payment's current state rather
 *    than trusting the event's snapshot, so events arriving out of order cannot make an
 *    order look paid (or unpaid) when it is not.
 *  - Everything it triggers is the idempotent fulfilment code, serialised per order.
 *  - Only the few fields processing needs are kept — never the whole payload, which
 *    carries the customer's email and phone.
 */

export interface WebhookResult {
  status: 'processed' | 'duplicate' | 'ignored';
  eventType: string;
}

interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: { entity?: Record<string, unknown> };
    refund?: { entity?: Record<string, unknown> };
  };
}

export async function handleRazorpayWebhook(input: {
  rawBody: string;
  signature: string | null;
  eventId: string | null;
}): Promise<WebhookResult> {
  let provider;
  try {
    provider = getPaymentProvider();
  } catch (error) {
    if (error instanceof PaymentsDisabledError) {
      throw new AppError('Payments are not configured.', { status: 503, code: 'payments_unavailable' });
    }
    throw error;
  }

  if (!input.signature || !provider.verifyWebhookSignature(input.rawBody, input.signature)) {
    throw new AppError('Invalid signature.', { status: 400, code: 'invalid_signature' });
  }
  if (!input.eventId) {
    throw new AppError('Missing event id.', { status: 400, code: 'missing_event_id' });
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(input.rawBody) as RazorpayEvent;
  } catch {
    throw new AppError('Malformed payload.', { status: 400, code: 'malformed_payload' });
  }
  const eventType = typeof event.event === 'string' ? event.event : 'unknown';

  const payment = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;
  const minimal = {
    paymentId: typeof payment?.id === 'string' ? payment.id : null,
    gatewayOrderId: typeof payment?.order_id === 'string' ? payment.order_id : null,
    refundId: typeof refund?.id === 'string' ? refund.id : null,
    amount: typeof (payment ?? refund)?.amount === 'number' ? ((payment ?? refund)?.amount as number) : null,
    status: typeof (payment ?? refund)?.status === 'string' ? ((payment ?? refund)?.status as string) : null,
  };

  // --- record before acting ---
  let record;
  try {
    record = await prisma.paymentEvent.create({
      data: { provider: provider.name, eventId: input.eventId, eventType, status: 'RECEIVED', attempts: 1, data: minimal },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const existing = await prisma.paymentEvent.findUnique({
      where: { provider_eventId: { provider: provider.name, eventId: input.eventId } },
    });
    if (!existing) throw error;
    if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
      return { status: 'duplicate', eventType };
    }
    record = await prisma.paymentEvent.update({
      where: { id: existing.id },
      data: { attempts: { increment: 1 }, status: 'RECEIVED', errorMessage: null },
    });
  }

  try {
    const result = await process(provider, eventType, payment, refund);
    await prisma.paymentEvent.update({
      where: { id: record.id },
      data: { status: result === 'ignored' ? 'IGNORED' : 'PROCESSED', processedAt: new Date() },
    });
    return { status: result === 'ignored' ? 'ignored' : 'processed', eventType };
  } catch (error) {
    // Keep a reason a human can read; never the payload, never a secret.
    const message = (error instanceof Error ? error.message : 'error').slice(0, 280);
    await prisma.paymentEvent
      .update({ where: { id: record.id }, data: { status: 'FAILED', errorMessage: message } })
      .catch(() => undefined);
    throw error; // → 500, so the gateway redelivers
  }
}

async function process(
  provider: ReturnType<typeof getPaymentProvider>,
  eventType: string,
  paymentEntity: Record<string, unknown> | undefined,
  refundEntity: Record<string, unknown> | undefined,
): Promise<'done' | 'ignored'> {
  switch (eventType) {
    case 'payment.authorized':
    case 'payment.failed':
    case 'payment.captured':
    case 'order.paid': {
      if (!paymentEntity) return 'ignored';
      const reported = toPayment(paymentEntity as unknown as Parameters<typeof toPayment>[0]);
      if (!reported.orderId) return 'ignored';

      const order = await prisma.order.findUnique({
        where: { provider_providerOrderId: { provider: provider.name, providerOrderId: reported.orderId } },
        select: { id: true },
      });
      if (!order) return 'ignored'; // a payment on something we did not create

      // A claimed capture is confirmed with the gateway itself; the event is a nudge.
      const payment =
        eventType === 'payment.captured' || eventType === 'order.paid'
          ? await provider.fetchPayment(reported.id)
          : reported;
      if (payment.orderId !== reported.orderId) return 'ignored';

      await applyGatewayPayment(order.id, payment);
      return 'done';
    }

    case 'refund.created':
    case 'refund.processed':
    case 'refund.failed': {
      if (!refundEntity) return 'ignored';
      const refund = toRefund(refundEntity as unknown as Parameters<typeof toRefund>[0]);
      try {
        await applyGatewayRefund(refund);
      } catch (error) {
        if (!(error instanceof UnknownPaymentError)) throw error;
        // The refund arrived before we recorded the payment: record the payment, then retry.
        const payment = await provider.fetchPayment(refund.paymentId);
        if (!payment.orderId) return 'ignored';
        const order = await prisma.order.findUnique({
          where: { provider_providerOrderId: { provider: provider.name, providerOrderId: payment.orderId } },
          select: { id: true },
        });
        if (!order) return 'ignored';
        await applyGatewayPayment(order.id, payment);
        await applyGatewayRefund(refund);
      }
      return 'done';
    }

    default:
      return 'ignored';
  }
}
