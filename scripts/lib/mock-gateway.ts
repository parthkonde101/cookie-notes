/**
 * A stand-in for Razorpay's REST API, for the commerce test suite.
 *
 * It listens on loopback only and implements the handful of endpoints the application
 * calls, with the behaviours the tests need to provoke: a payment that is captured, only
 * authorised, or failed; a payment for the wrong amount; a refund that is processed,
 * pending, refused or never answered; and refund receipts that act as idempotency keys,
 * as the real API's do. Nothing here can reach a real payment: the application only
 * honours a RAZORPAY_API_BASE on loopback, and only with a `rzp_test_` key.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';

export interface MockPayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  order_id: string | null;
  method: string;
  captured: boolean;
  error_code: string | null;
  error_description: string | null;
  amount_refunded: number;
}

export interface MockRefund {
  id: string;
  entity: 'refund';
  payment_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'processed' | 'failed';
  receipt: string | null;
}

type Fault = { kind: string; mode: 'status' | 'drop' | 'dropAfter'; status?: number; code?: string; description?: string };

export interface MockGateway {
  baseUrl: string;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  orders: Map<string, { id: string; amount: number; currency: string; receipt: string | null; status: string }>;
  payments: Map<string, MockPayment>;
  refunds: Map<string, MockRefund>;
  /** Requests received, by "METHOD /path", for assertions about what the app asked for. */
  calls: string[];
  refundMode: 'processed' | 'pending';
  /** Make the next call of this kind fail with an HTTP status, or drop the connection. */
  fault(
    kind: 'createOrder' | 'fetchPayment' | 'fetchOrderPayments' | 'refund' | 'fetchPaymentRefunds',
    fault: { status?: number; drop?: boolean; dropAfter?: boolean; description?: string },
  ): void;
  /** A payment attempt on a gateway order, as if the student had paid (or failed to). */
  pay(input: {
    orderId: string;
    state?: MockPayment['status'];
    amount?: number;
    currency?: string;
    method?: string;
  }): MockPayment;
  /** The signature the browser's checkout handler would return for this payment. */
  checkoutSignature(orderId: string, paymentId: string): string;
  /** A signed webhook body and headers for an event. */
  webhook(event: string, entities: { payment?: MockPayment; refund?: MockRefund }, eventId?: string): {
    body: string;
    headers: Record<string, string>;
  };
  stop(): Promise<void>;
}

export async function startMockGateway(keyId: string, keySecret: string, webhookSecret: string): Promise<MockGateway> {
  const orders: MockGateway['orders'] = new Map();
  const payments: MockGateway['payments'] = new Map();
  const refunds: MockGateway['refunds'] = new Map();
  const calls: string[] = [];
  const faults: Fault[] = [];
  let sequence = 1000;
  let eventSequence = 1;

  const gateway: MockGateway = {
    baseUrl: '',
    keyId,
    keySecret,
    webhookSecret,
    orders,
    payments,
    refunds,
    calls,
    refundMode: 'processed',
    fault(kind, fault) {
      faults.push({
        kind,
        mode: fault.drop ? 'drop' : fault.dropAfter ? 'dropAfter' : 'status',
        status: fault.status ?? 500,
        description: fault.description,
      });
    },
    pay({ orderId, state = 'captured', amount, currency, method = 'upi' }) {
      const order = orders.get(orderId);
      if (!order) throw new Error(`mock gateway: no order ${orderId}`);
      const payment: MockPayment = {
        id: `pay_mock_${sequence++}`,
        entity: 'payment',
        amount: amount ?? order.amount,
        currency: currency ?? order.currency,
        status: state,
        order_id: orderId,
        method,
        captured: state === 'captured',
        error_code: state === 'failed' ? 'BAD_REQUEST_ERROR' : null,
        error_description: state === 'failed' ? 'Payment failed' : null,
        amount_refunded: 0,
      };
      payments.set(payment.id, payment);
      if (state === 'captured') order.status = 'paid';
      return payment;
    },
    checkoutSignature(orderId, paymentId) {
      return createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    },
    webhook(event, entities, eventId) {
      const body = JSON.stringify({
        entity: 'event',
        account_id: 'acc_mock',
        event,
        contains: Object.keys(entities),
        payload: Object.fromEntries(Object.entries(entities).map(([key, entity]) => [key, { entity }])),
        created_at: Math.floor(Date.now() / 1000),
      });
      return {
        body,
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': createHmac('sha256', webhookSecret).update(body).digest('hex'),
          'x-razorpay-event-id': eventId ?? `evt_mock_${eventSequence++}`,
        },
      };
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  function takeFault(kind: string): Fault | undefined {
    const index = faults.findIndex((fault) => fault.kind === kind);
    return index >= 0 ? faults.splice(index, 1)[0] : undefined;
  }

  function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  const fail = (res: ServerResponse, status: number, description: string, code = 'BAD_REQUEST_ERROR') =>
    send(res, status, { error: { code, description } });

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      calls.push(route);

      const expected = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
      if (req.headers.authorization !== expected) return fail(res, 401, 'Authentication failed');

      const path = url.pathname.replace(/^\/v1/, '');

      const kind = (() => {
        if (req.method === 'POST' && path === '/orders') return 'createOrder';
        if (req.method === 'GET' && /^\/orders\/[^/]+\/payments$/.test(path)) return 'fetchOrderPayments';
        if (req.method === 'GET' && /^\/payments\/[^/]+$/.test(path)) return 'fetchPayment';
        if (req.method === 'POST' && /^\/payments\/[^/]+\/refund$/.test(path)) return 'refund';
        if (req.method === 'GET' && /^\/payments\/[^/]+\/refunds$/.test(path)) return 'fetchPaymentRefunds';
        return 'other';
      })();
      const fault = takeFault(kind);
      if (fault?.mode === 'drop') {
        req.socket.destroy();
        return;
      }
      if (fault?.mode === 'status') return fail(res, fault.status ?? 500, fault.description ?? 'Gateway fault', 'SERVER_ERROR');
      const dropAfterProcessing = fault?.mode === 'dropAfter';

      if (req.method === 'POST' && path === '/orders') {
        const body = await readBody(req);
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount < 100) return fail(res, 400, 'Order amount less than minimum amount allowed');
        const order = {
          id: `order_mock_${sequence++}`,
          amount,
          currency: String(body.currency ?? 'INR'),
          receipt: typeof body.receipt === 'string' ? body.receipt : null,
          status: 'created',
        };
        orders.set(order.id, order);
        return send(res, 200, { ...order, entity: 'order', amount_paid: 0, amount_due: amount, attempts: 0 });
      }

      const orderPayments = path.match(/^\/orders\/([^/]+)\/payments$/);
      if (req.method === 'GET' && orderPayments) {
        const items = [...payments.values()].filter((payment) => payment.order_id === orderPayments[1]);
        return send(res, 200, { entity: 'collection', count: items.length, items });
      }

      const paymentRefunds = path.match(/^\/payments\/([^/]+)\/refunds$/);
      if (req.method === 'GET' && paymentRefunds) {
        const items = [...refunds.values()].filter((refund) => refund.payment_id === paymentRefunds[1]);
        return send(res, 200, { entity: 'collection', count: items.length, items });
      }

      const onePayment = path.match(/^\/payments\/([^/]+)$/);
      if (req.method === 'GET' && onePayment) {
        const payment = payments.get(onePayment[1]);
        return payment ? send(res, 200, payment) : fail(res, 400, 'The id provided does not exist');
      }

      const refundPath = path.match(/^\/payments\/([^/]+)\/refund$/);
      if (req.method === 'POST' && refundPath) {
        const payment = payments.get(refundPath[1]);
        if (!payment) return fail(res, 400, 'The id provided does not exist');
        if (!payment.captured) return fail(res, 400, 'The payment has not been captured');
        const body = await readBody(req);
        const amount = Number(body.amount ?? payment.amount - payment.amount_refunded);
        const receipt = typeof body.receipt === 'string' ? body.receipt : null;
        if (receipt && [...refunds.values()].some((refund) => refund.receipt === receipt && refund.payment_id === payment.id)) {
          return fail(res, 400, 'Refund receipt must be unique for the payment');
        }
        if (!Number.isInteger(amount) || amount < 100) return fail(res, 400, 'The refund amount is invalid');
        if (amount > payment.amount - payment.amount_refunded) {
          return fail(res, 400, 'The refund amount provided is greater than amount captured');
        }
        const refund: MockRefund = {
          id: `rfnd_mock_${sequence++}`,
          entity: 'refund',
          payment_id: payment.id,
          amount,
          currency: payment.currency,
          status: gateway.refundMode,
          receipt,
        };
        refunds.set(refund.id, refund);
        payment.amount_refunded += amount;
        if (payment.amount_refunded >= payment.amount) payment.status = 'refunded';
        if (dropAfterProcessing) {
          // The refund happened, but the answer never reaches the caller.
          req.socket.destroy();
          return;
        }
        return send(res, 200, refund);
      }

      return fail(res, 404, 'Not found');
    } catch (error) {
      return fail(res, 500, error instanceof Error ? error.message : 'error', 'SERVER_ERROR');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock gateway failed to bind');
  gateway.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return gateway;
}
