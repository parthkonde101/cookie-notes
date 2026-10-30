import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { toErrorResponse, Errors } from '@/lib/errors';
import { requireApiUser } from '@/lib/auth/guards';
import { rateLimit } from '@/lib/auth/rate-limit';
import { confirmCheckout } from '@/lib/commerce/orders';
import { assertJsonSameOrigin } from '@/lib/commerce/request-guards';
import { firstError } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const bodySchema = z.object({
  razorpay_order_id: z.string().trim().min(1).max(100),
  razorpay_payment_id: z.string().trim().min(1).max(100),
  razorpay_signature: z.string().trim().min(1).max(200),
});

/**
 * The browser reports what checkout returned. This is a CLAIM, not proof: the signature
 * is verified here, the payment is fetched from the gateway, and only a payment the server
 * has verified can mark the order paid. The response says `paid: true` only in that case.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertJsonSameOrigin(request);
    const { id } = await params;
    const { user } = await requireApiUser();

    const limit = await rateLimit(`checkout-confirm:user:${user.id}`, 60, 60, { failClosed: true });
    if (!limit.allowed) throw Errors.rateLimited();

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const result = await confirmCheckout({
      userId: user.id,
      orderId: id,
      gatewayOrderId: parsed.data.razorpay_order_id,
      paymentId: parsed.data.razorpay_payment_id,
      signature: parsed.data.razorpay_signature,
    });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
