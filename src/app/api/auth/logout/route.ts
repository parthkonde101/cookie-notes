import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requestContext } from '@/lib/request';
import { clearSessionCookie, endSession, getSessionState } from '@/lib/auth/session';
import { recordEvent } from '@/lib/analytics/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const state = await getSessionState({ touch: false });
    if (state.status === 'authenticated') {
      await endSession(state.session.id, 'LOGGED_OUT', 'user_logout');
      await recordEvent({
        type: 'LOGOUT',
        userId: state.user.id,
        sessionId: state.session.id,
        ctx: await requestContext(),
      });
    }
    await clearSessionCookie();
    return NextResponse.json({ ok: true, redirectTo: '/login' });
  } catch (error) {
    return toErrorResponse(error);
  }
}
