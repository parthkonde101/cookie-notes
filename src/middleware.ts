import { NextResponse, type NextRequest } from 'next/server';

/**
 * A cheap first pass only.
 *
 * Middleware runs on the edge without database access, so it can do no more than
 * notice that a session cookie is missing and bounce the request to /login before
 * a page render is wasted. Every real authorisation decision — is the session
 * live? is the account active? is this user an admin? may they read this note? —
 * happens server-side in `lib/auth/guards.ts` and `lib/access/entitlements.ts`.
 */

/**
 * The catalogue at `/` and `/subject/*` is deliberately public — browsing never
 * requires an account. Only reading a note and the account/admin areas do.
 */
const PROTECTED_PREFIXES = ['/notes', '/account', '/admin'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) return NextResponse.next();

  const hasCookie = Boolean(request.cookies.get('sv_session')?.value);

  if (!hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  // Bounce non-admins off /admin here so they get a real HTTP redirect rather
  // than a rendered shell. The cookie is only a hint — `requireAdmin()` on the
  // server is what actually decides, and it re-reads the role from the database.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const roleHint = request.cookies.get('sv_role')?.value;
    if (roleHint && roleHint !== 'ADMIN') {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals, the API (route handlers do their own
     * checks and must return JSON, not a redirect) and static files.
     */
    '/((?!api|_next/static|_next/image|favicon.ico|favicon.svg|vendor|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
