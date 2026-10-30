import { NextResponse, type NextRequest } from 'next/server';
import { toErrorResponse, Errors } from '@/lib/errors';
import { requireApiUser } from '@/lib/auth/guards';
import { rateLimit } from '@/lib/auth/rate-limit';
import { getOrderForUser } from '@/lib/commerce/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The state of one of the caller's own orders, for the checkout screen to poll while a
 * payment is being confirmed. An order that belongs to someone else is "not found".
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user } = await requireApiUser();

    const limit = await rateLimit(`order-status:user:${user.id}`, 600, 60);
    if (!limit.allowed) throw Errors.rateLimited();

    const result = await getOrderForUser(id, user.id);
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
