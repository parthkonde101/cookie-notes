import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GatewayError,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayPaymentState,
  type GatewayRefund,
  type GatewayRefundState,
  type PaymentProvider,
} from '@/lib/commerce/gateway';

/**
 * Razorpay, over its documented REST API (https://razorpay.com/docs/api/).
 *
 * Plain `fetch` with HTTP Basic authentication (key id : key secret), no SDK — the
 * surface used is four calls and the signature rules, and keeping them here makes
 * them easy to read against the documentation:
 *
 *   POST /orders                  create the order the checkout widget pays against
 *   GET  /payments/:id            the authoritative state of a payment
 *   POST /payments/:id/refund     refund; `receipt` acts as an idempotency key
 *
 *   checkout signature   HMAC-SHA256( order_id + "|" + payment_id, KEY_SECRET ), hex
 *   webhook signature    HMAC-SHA256( raw request body,            WEBHOOK_SECRET ), hex,
 *                        in the X-Razorpay-Signature header
 *
 * The key secret and the webhook secret are held by this object and used only to
 * sign or verify; neither is ever returned, logged, or put in an error message.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  constructor(
    private readonly config: {
      keyId: string;
      keySecret: string;
      webhookSecret: string;
      apiBase: string;
    },
  ) {}

  get publicKeyId() {
    return this.config.keyId;
  }

  // --- signatures --------------------------------------------------------

  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    if (!input.orderId || !input.paymentId || !input.signature) return false;
    const expected = createHmac('sha256', this.config.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest('hex');
    return safeHexEqual(expected, input.signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
    return safeHexEqual(expected, signature);
  }

  // --- API ---------------------------------------------------------------

  async createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder> {
    const body = await this.request<RazorpayOrder>('POST', '/orders', {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    });
    return {
      id: body.id,
      amountMinor: body.amount,
      currency: body.currency,
      status: body.status,
      receipt: body.receipt ?? null,
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const body = await this.request<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
    return toPayment(body);
  }

  async fetchPaymentRefunds(paymentId: string): Promise<GatewayRefund[]> {
    const body = await this.request<{ items?: RazorpayRefund[] }>(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}/refunds`,
    );
    return (body.items ?? []).map(toRefund);
  }

  async fetchOrderPayments(gatewayOrderId: string): Promise<GatewayPayment[]> {
    const body = await this.request<{ items?: RazorpayPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(gatewayOrderId)}/payments`,
    );
    return (body.items ?? []).map(toPayment);
  }

  async refundPayment(input: {
    paymentId: string;
    amountMinor: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayRefund> {
    const body = await this.request<RazorpayRefund>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      { amount: input.amountMinor, speed: 'normal', receipt: input.receipt, notes: input.notes },
    );
    return toRefund(body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        // A checkout must not hang on the gateway; an unanswered call is retryable.
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new GatewayError(`The payment gateway could not be reached (${name}).`, { retryable: true });
    }

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) {
      const error = (json as { error?: { code?: string; description?: string } } | null)?.error;
      // 4xx other than 429 will never succeed on retry; 5xx and 429 might.
      const retryable = response.status >= 500 || response.status === 429;
      // The gateway's own description is safe to log; it contains no credentials.
      throw new GatewayError(error?.description ?? `The payment gateway answered ${response.status}.`, {
        status: response.status,
        code: error?.code,
        retryable,
      });
    }
    return json as T;
  }
}

function safeHexEqual(expectedHex: string, givenHex: string): boolean {
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(givenHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- Razorpay wire shapes (only the fields used) ---------------------------

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string | null;
}

interface RazorpayPayment {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  captured?: boolean;
  error_code?: string | null;
  error_description?: string | null;
  amount_refunded?: number;
}

interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency?: string;
  status: string;
  receipt?: string | null;
}

export function toPayment(body: RazorpayPayment): GatewayPayment {
  return {
    id: body.id,
    orderId: body.order_id ?? null,
    amountMinor: body.amount,
    currency: body.currency,
    state: paymentState(body.status),
    method: body.method ?? null,
    errorCode: body.error_code ?? null,
    errorDescription: body.error_description ?? null,
    amountRefundedMinor: body.amount_refunded ?? 0,
  };
}

export function toRefund(body: RazorpayRefund): GatewayRefund {
  return {
    id: body.id,
    paymentId: body.payment_id,
    amountMinor: body.amount,
    currency: body.currency ?? 'INR',
    state: refundState(body.status),
    receipt: body.receipt ?? null,
  };
}

function paymentState(status: string): GatewayPaymentState {
  switch (status) {
    case 'captured':
      return 'captured';
    case 'authorized':
      return 'authorized';
    case 'failed':
      return 'failed';
    case 'refunded':
      return 'refunded';
    default:
      return 'created';
  }
}

function refundState(status: string): GatewayRefundState {
  if (status === 'processed') return 'processed';
  if (status === 'failed') return 'failed';
  return 'pending';
}
