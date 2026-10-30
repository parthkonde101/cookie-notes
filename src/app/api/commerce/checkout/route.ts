import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { toErrorResponse, Errors } from '@/lib/errors';
import { requireApiUser } from '@/lib/auth/guards';
import { rateLimit } from '@/lib/auth/rate-limit';
import { createCheckout } from '@/lib/commerce/orders';
import { assertJsonSameOrigin } from '@/lib/commerce/request-guards';
import { firstError } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const bodySchema = z.object({
  productType: z.enum(['NOTE', 'BUNDLE']),
  productId: z.string().trim().min(1).max(64),
});

/**
 * Opens a checkout for one note or bundle.
 *
 * The body names a product and nothing else — the price, the currency, the contents and
 * the buyer are all decided on the server from the signed-in session and the database.
 */
export async function POST(request: NextRequest) {
  try {
    assertJsonSameOrigin(request);
    const { user } = await requireApiUser();

    // Fail closed: if the limiter itself cannot run, no order is created.
    const limit = await rateLimit(`checkout:user:${user.id}`, 30, 60, { failClosed: true });
    if (!limit.allowed) throw Errors.rateLimited('You are starting checkouts too quickly. Please wait a little.');

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const session = await createCheckout({
      userId: user.id,
      productType: parsed.data.productType,
      productId: parsed.data.productId,
    });
    return NextResponse.json({ ok: true, ...session }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
