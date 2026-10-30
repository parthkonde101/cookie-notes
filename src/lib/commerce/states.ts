/**
 * The order state machine.
 *
 *            ┌───────────────┐
 *   CREATED ─┤ student opens ├─► PENDING ─► PAID ─► PARTIALLY_REFUNDED ─► REFUNDED
 *      │     │   checkout    │      │         └──────────────────────────────▲
 *      │     └───────────────┘      ▼
 *      ├────────────────────────► FAILED ──► (a retry) PENDING / PAID
 *      └────────────────────────► CANCELLED ─► (a late payment) PAID
 *
 * Two rules sit above the table:
 *
 *  1. Only a server that has VERIFIED a payment with the gateway moves an order to
 *     PAID. A browser redirect, a checkout dismissal or an API request from the
 *     student is never evidence of payment; the one thing a student can do is
 *     withdraw (CREATED → CANCELLED), and that grants nothing.
 *  2. Money that actually arrived wins. A payment can complete after the student
 *     closed the window or after an earlier attempt failed, so FAILED and CANCELLED
 *     both lead to PAID. REFUNDED is the only dead end.
 *
 * No string comparison on statuses should appear outside this file.
 */

export type OrderStatusValue =
  | 'CREATED'
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'CANCELLED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

const TRANSITIONS: Record<OrderStatusValue, readonly OrderStatusValue[]> = {
  CREATED: ['PENDING', 'PAID', 'FAILED', 'CANCELLED'],
  PENDING: ['PAID', 'FAILED'],
  FAILED: ['PENDING', 'PAID', 'CANCELLED'],
  CANCELLED: ['PENDING', 'PAID'],
  PAID: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  REFUNDED: [],
};

export function canTransition(from: OrderStatusValue, to: OrderStatusValue): boolean {
  if (from === to) return true; // idempotent: re-applying the same state is a no-op
  return TRANSITIONS[from].includes(to);
}

/** A sale happened: money was received (and may since have been returned). */
export function isSale(status: OrderStatusValue): boolean {
  return status === 'PAID' || status === 'PARTIALLY_REFUNDED' || status === 'REFUNDED';
}

/** Statuses in which the student may still complete payment on this order. */
export function isPayable(status: OrderStatusValue): boolean {
  return status === 'CREATED' || status === 'PENDING' || status === 'FAILED';
}

/** What a refund total does to the order's status. */
export function statusAfterRefund(amountMinor: number, refundedMinor: number): OrderStatusValue {
  if (refundedMinor <= 0) return 'PAID';
  return refundedMinor >= amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}

/**
 * Wording for a student. Deliberately plain, and honest about "pending": the
 * payment may still be confirmed.
 */
export function describeStatus(status: OrderStatusValue): string {
  switch (status) {
    case 'CREATED':
      return 'Not completed';
    case 'PENDING':
      return 'Confirming payment';
    case 'PAID':
      return 'Paid';
    case 'FAILED':
      return 'Payment failed';
    case 'CANCELLED':
      return 'Cancelled';
    case 'PARTIALLY_REFUNDED':
      return 'Partly refunded';
    case 'REFUNDED':
      return 'Refunded';
  }
}
