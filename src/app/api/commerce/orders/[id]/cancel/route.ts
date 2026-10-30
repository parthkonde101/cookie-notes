import { NextResponse, type NextRequest } from 'next/server';
import { toErrorResponse, Errors } from '@/lib/errors';
import { requireApiUser } from '@/lib/auth/guards';
import { rateLimit } from '@/lib/auth/rate-limit';
import { cancelUnstartedOrder } from '@/lib/commerce/fulfilment';
import { assertJsonSameOrigin } from '@/lib/commerce/request-guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The student closed checkout without paying. This only ever abandons the caller's own
 * unpaid order — it grants nothing, and a payment that completes anyway still pays it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertJsonSameOrigin(request);
    const { id } = await params;
    const { user } = await requireApiUser();

    const limit = await rateLimit(`checkout-cancel:user:${user.id}`, 120, 60);
    if (!limit.allowed) throw Errors.rateLimited();

    try {
      const status = await cancelUnstartedOrder(id, user.id);
      return NextResponse.json({ ok: true, status }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof Error && error.message === 'not found') throw Errors.notFound('We could not find that order.');
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
