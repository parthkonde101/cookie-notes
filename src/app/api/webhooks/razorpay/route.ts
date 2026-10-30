import { NextResponse, type NextRequest } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { handleRazorpayWebhook } from '@/lib/commerce/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Razorpay's server-to-server notifications.
 *
 * No session, no cookie, no CORS: this endpoint is authenticated by the signature over
 * the raw body alone. The body is read as TEXT, exactly as sent, because the signature is
 * computed over those bytes and re-serialising parsed JSON would break it.
 *
 * Responses: 200 once the event is processed, ignored or a recognised repeat; 400 for a
 * bad signature or body (nothing is recorded); 500 when processing failed, so the gateway
 * redelivers — the event is already saved and is retried, not lost.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const result = await handleRazorpayWebhook({
      rawBody,
      signature: request.headers.get('x-razorpay-signature'),
      eventId: request.headers.get('x-razorpay-event-id'),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
