import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Short-lived, HMAC-signed authorisation for a single note-content request.
 *
 * The token binds the note, the user AND the session together and expires in
 * minutes, so a copied URL is useless almost immediately and useless entirely on
 * another account. It is a *second* gate, not the only one: the content route
 * re-checks entitlements and session validity from the database on every call,
 * which is what makes an access revocation take effect instantly.
 */

export interface ViewTokenPayload {
  /**
   * What the token authorises. A bare id is a note; a previous-year paper is
   * namespaced with `pyq:` so a token minted for one kind of document can never
   * be replayed against the other.
   */
  n: string;
  u: string; // user id
  s: string; // session id
  e: number; // expiry (unix seconds)
  j: string; // nonce
}

/** The token subject for a previous-year paper. */
export function pyqTokenSubject(pyqId: string): string {
  return `pyq:${pyqId}`;
}

const DEFAULT_TTL_SECONDS = 180;

function sign(data: string): string {
  return createHmac('sha256', env.viewTokenSecret).update(data).digest('base64url');
}

export function createViewToken(
  noteId: string,
  userId: string,
  sessionId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): { token: string; expiresAt: Date } {
  const payload: ViewTokenPayload = {
    n: noteId,
    u: userId,
    s: sessionId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
    j: randomBytes(8).toString('base64url'),
  };

  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${body}.${sign(body)}`;
  return { token, expiresAt: new Date(payload.e * 1000) };
}

export function verifyViewToken(token: string | null | undefined): ViewTokenPayload | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ViewTokenPayload;
    if (typeof payload.e !== 'number' || payload.e * 1000 < Date.now()) return null;
    if (!payload.n || !payload.u || !payload.s) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Random, URL-safe token for password resets. Stored only as a SHA-256 hash. */
export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
