import 'server-only';

/**
 * The payment gateway, as the rest of the commerce code sees it.
 *
 * Nothing outside `razorpay.ts` knows what Razorpay's JSON looks like: orders,
 * payments and refunds are translated into these shapes at the edge. That keeps the
 * order, fulfilment and refund logic independent of the vendor, and it is what lets a
 * second gateway be added later without touching them.
 *
 * All amounts are integer minor units (paise).
 */

export interface GatewayOrder {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  receipt: string | null;
}

export type GatewayPaymentState = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';

export interface GatewayPayment {
  id: string;
  /** The gateway order this payment belongs to, if any. */
  orderId: string | null;
  amountMinor: number;
  currency: string;
  state: GatewayPaymentState;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  amountRefundedMinor: number;
}

export type GatewayRefundState = 'pending' | 'processed' | 'failed';

export interface GatewayRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  state: GatewayRefundState;
  receipt: string | null;
}

/**
 * A failure talking to the gateway. `retryable` separates "try again" (timeouts,
 * 5xx, rate limits) from "this will never work" (bad request, unknown id), which
 * decides whether a webhook is answered with an error so the gateway redelivers.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly options: { status?: number; code?: string; retryable: boolean },
  ) {
    super(message);
    this.name = 'GatewayError';
  }
  get retryable() {
    return this.options.retryable;
  }
  get status() {
    return this.options.status;
  }
}

export interface PaymentProvider {
  readonly name: 'razorpay';
  /** The PUBLIC key id the checkout widget needs. The secret never leaves the server. */
  readonly publicKeyId: string;

  createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;

  fetchPayment(paymentId: string): Promise<GatewayPayment>;

  /** The refunds the gateway holds against one payment (used to recognise one that already went through). */
  fetchPaymentRefunds(paymentId: string): Promise<GatewayRefund[]>;

  /** Every payment attempt the gateway has recorded against one of its orders. */
  fetchOrderPayments(gatewayOrderId: string): Promise<GatewayPayment[]>;

  refundPayment(input: {
    paymentId: string;
    /** Always sent explicitly, even for a full refund, so the amount is never ambiguous. */
    amountMinor: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayRefund>;

  /** Checks the signature the browser's checkout handler returned. Constant time. */
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;

  /** Checks a webhook's signature against the UNMODIFIED raw body. Constant time. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

export class PaymentsDisabledError extends Error {
  constructor() {
    super('Payments are not available right now.');
    this.name = 'PaymentsDisabledError';
  }
}

