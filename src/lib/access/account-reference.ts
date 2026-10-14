import 'server-only';
import { createHmac, hkdfSync } from 'node:crypto';
import { env } from '@/lib/env';
import { prisma } from '@/lib/prisma';

/**
 * The opaque account reference printed in the footer of every page a student
 * reads — `CN-7K2M9QXA` — so a leaked copy can be traced to an account without
 * naming anyone.
 *
 * ## What it is
 *
 * 40 bits of an HMAC-SHA256 over the account's id, written in Crockford base32
 * (no I, L, O or U, so it reads cleanly off a screenshot). It is:
 *
 *  - STABLE: the same account always gets the same reference, on every page,
 *    every note and every visit;
 *  - OPAQUE: it contains no part of the id, the email or the name, and cannot be
 *    reversed or guessed without the server's secret;
 *  - SERVER-DERIVED: it is computed here from the authenticated session's user —
 *    nothing the browser sends can name a reference;
 *  - LOOKUP-ABLE: an admin pastes it — or the whole footer line — into the users search and
 *    finds the account (`parseReference`, `userIdsForReference`).
 *
 * The key comes from AUTH_SECRET through its own HKDF label, so it is never the
 * same key as anything else derived from that secret. Rotating AUTH_SECRET would
 * change every reference — treat it as long-lived.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REFERENCE_PATTERN = /^CN-[0-9A-HJKMNP-TV-Z]{8}$/;

let cached: { secret: string; key: Buffer } | null = null;

function referenceKey(): Buffer {
  const secret = env.authSecret;
  if (cached?.secret === secret) return cached.key;
  const key = Buffer.from(hkdfSync('sha256', secret, 'cookie-notes', 'account-ref/v1', 32));
  cached = { secret, key };
  return key;
}

export function accountReference(userId: string): string {
  const digest = createHmac('sha256', referenceKey()).update(`account-ref/v1|${userId}`).digest();
  // First 40 bits → eight 5-bit characters.
  let bits = 0n;
  for (let i = 0; i < 5; i += 1) bits = (bits << 8n) | BigInt(digest[i]);
  let out = '';
  for (let i = 7; i >= 0; i -= 1) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `CN-${out}`;
}

/** The look-alikes Crockford base32 reads as their digits, so a code misread off a screenshot still resolves. */
const LOOK_ALIKES: Record<string, string> = { O: '0', I: '1', L: '1' };

/**
 * Finds a reference in whatever an admin typed or pasted, and returns it in canonical form
 * (`CN-7K2M9QXA`), or null if there is none.
 *
 * It accepts what really gets pasted: the code alone, the whole footer line
 * (`CN-7K2M9QXA · Page 3`), any case, a space or no dash after `CN`, and the characters the
 * alphabet leaves out because they are easily confused (an O or an I or an L read off a
 * screenshot is taken as the 0 or 1 it must have been). A bare eight-character code with no
 * `CN` is accepted too. Anything else — a name, an email — is not a reference.
 */
export function parseReference(text: string): string | null {
  const upper = text.toUpperCase();
  const prefixed = /(?:^|[^0-9A-Z])CN[\s\-\u2013\u2014_.]*([0-9A-Z]{8})(?![0-9A-Z])/.exec(upper);
  const bare = /^[0-9A-Z]{8}$/.test(upper.trim()) ? upper.trim() : null;
  const candidate = prefixed?.[1] ?? bare;
  if (!candidate) return null;
  const code = `CN-${[...candidate].map((c) => LOOK_ALIKES[c] ?? c).join('')}`;
  return REFERENCE_PATTERN.test(code) ? code : null;
}

/** Which accounts carry this reference (normally one). Empty for anything that is not a reference. */
export async function userIdsForReference(reference: string): Promise<string[]> {
  const wanted = parseReference(reference);
  if (!wanted) return [];
  const users = await prisma.user.findMany({ select: { id: true } });
  return users.filter((user) => accountReference(user.id) === wanted).map((user) => user.id);
}
