import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import {
  countLiveUsers,
  getSessionState,
  setRoleHintCookie,
  touchSession,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Called by the app shell every minute while a tab is visible.
 *
 * Two jobs: keep this session's `lastActivityAt` fresh (so the account is not
 * treated as idle), and tell the client whether the session is still valid — the
 * signal that makes "signed out because you logged in elsewhere" appear promptly
 * instead of at the next navigation.
 */
export async function POST() {
  try {
    const state = await getSessionState({ touch: false });

    if (state.status !== 'authenticated') {
      return NextResponse.json({ ok: false, status: state.status }, { status: 401 });
    }

    await touchSession(state.session.id, state.user.id);
    // Keep the middleware role hint in step with the database.
    await setRoleHintCookie(state.user.role);

    return NextResponse.json({
      ok: true,
      status: 'authenticated',
      liveUsers: await countLiveUsers(),
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
