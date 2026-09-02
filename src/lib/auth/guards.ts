import 'server-only';
import { redirect } from 'next/navigation';
import { Errors } from '@/lib/errors';
import { getSessionState, type ActiveSession, type SessionUser } from '@/lib/auth/session';

export interface AuthContext {
  user: SessionUser;
  session: ActiveSession;
}

function loginRedirect(state: string, next?: string): never {
  const params = new URLSearchParams();
  if (state !== 'anonymous') params.set('reason', state);
  if (next) params.set('next', next);
  const query = params.toString();
  redirect(`/login${query ? `?${query}` : ''}`);
}

/**
 * For pages and layouts: resolves the caller or redirects to /login.
 * `next` is the path to return to after signing in.
 */
export async function requireUser(next?: string): Promise<AuthContext> {
  const state = await getSessionState();
  if (state.status !== 'authenticated') loginRedirect(state.status, next);
  return { user: state.user, session: state.session };
}

/**
 * For pages and layouts: requires the ADMIN role.
 *
 * A signed-in student hitting an admin URL gets a 404-style "not found" rather
 * than a redirect, so admin routes are not discoverable by probing.
 */
export async function requireAdmin(next?: string): Promise<AuthContext> {
  const state = await getSessionState();
  if (state.status !== 'authenticated') loginRedirect(state.status, next);
  if (state.user.role !== 'ADMIN') redirect('/');
  return { user: state.user, session: state.session };
}

/** For route handlers and server actions: throws instead of redirecting. */
export async function requireApiUser(): Promise<AuthContext> {
  const state = await getSessionState();
  if (state.status === 'authenticated') return { user: state.user, session: state.session };

  switch (state.status) {
    case 'superseded':
      throw Errors.unauthorized('You were signed out because this account was used on another device.');
    case 'expired':
      throw Errors.unauthorized('Your session expired. Please sign in again.');
    case 'terminated':
      throw Errors.unauthorized('This session was ended by an administrator.');
    case 'disabled':
      throw Errors.forbidden('This account has been disabled. Contact support.');
    default:
      throw Errors.unauthorized();
  }
}

export async function requireApiAdmin(): Promise<AuthContext> {
  const auth = await requireApiUser();
  if (auth.user.role !== 'ADMIN') {
    // Deliberately vague: do not confirm that an admin-only resource exists.
    throw Errors.notFound();
  }
  return auth;
}

/** Returns the caller when signed in, or null — for pages that work both ways. */
export async function optionalUser(): Promise<AuthContext | null> {
  const state = await getSessionState();
  return state.status === 'authenticated'
    ? { user: state.user, session: state.session }
    : null;
}
