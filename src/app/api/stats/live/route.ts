import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiUser } from '@/lib/auth/guards';
import { countLiveUsers } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireApiUser();
    return NextResponse.json(
      { liveUsers: await countLiveUsers() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
