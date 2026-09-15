import 'server-only';
import { redirect } from 'next/navigation';
import { Errors } from '@/lib/errors';
import { getSessionState, type ActiveSession, type SessionUser } from '@/lib/auth/session';

export interface AuthContext {
  user: SessionUser;
  session: ActiveSession;
}

/** Where a student finishes moving to a verified college address. */
export const EMAIL_MIGRATION_PATH = '/verify-college-email';

export interface GuardOptions {
  /**
   * Let a student through who has not yet verified a college email.
   *
   * Only the migration flow itself should set this — it needs an authenticated
   * caller precisely because that caller is unverified. Everything else leaves
   * it alone and gets the gate, which is the safe default: a route added later
   * is protected without anyone remembering to protect it.
   */
  allowUnverified?: boolean;
}

/**
 * Whether this account still has to prove a college address before it may read
 * anything.
 *
 * Students only. Admins are never gated — a verification bug must not be able
 * to lock the operator out of their own production system — and an account that
 * has already verified is done forever. `emailVerifiedAt` is the single source
 * of truth: once it is set, this returns false for good, so the prompt cannot
 * reappear.
 *
 * Note what this deliberately does NOT consult: `verificationRequired`. That
 * flag distinguishes *how* an account was created, and a legacy student has it
 * false. The migration applies to every unverified student however they got
 * here, so the test is simply "student, not yet verified".
 */
export function needsEmailMigration(user: {
  role: SessionUser['role'];
  emailVerifiedAt: Date | null;
}): boolean {
  return user.role === 'STUDENT' && user.emailVerifiedAt === null;
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
export async function requireUser(
  next?: string,
  options: GuardOptions = {},
): Promise<AuthContext> {
  const state = await getSessionState();
  if (state.status !== 'authenticated') loginRedirect(state.status, next);

  // The gate sits here rather than in `getSessionState` on purpose: the student
  // IS authenticated — they typed the right password — they simply may not read
  // anything yet. Treating them as anonymous would break the very flow that
  // lets them fix it.
  //
  // Because it is in the shared guard, a remembered 30-day session gets exactly
  // the same treatment as a fresh one. Staying signed in was never a way to
  // skip this.
  if (!options.allowUnverified && needsEmailMigration(state.user)) {
    redirect(EMAIL_MIGRATION_PATH);
  }

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
export async function requireApiUser(options: GuardOptions = {}): Promise<AuthContext> {
  const state = await getSessionState();
  if (state.status === 'authenticated') {
    // Same gate as the page guard, so the API cannot be used to fetch note
    // bytes that the UI is refusing to show. 403 rather than 401: the session
    // is perfectly valid, there is just one thing left to do.
    if (!options.allowUnverified && needsEmailMigration(state.user)) {
      throw Errors.forbidden(
        'Please verify your MIT-WPU email address to continue.',
        'email_migration_required',
      );
    }
    return { user: state.user, session: state.session };
  }

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
