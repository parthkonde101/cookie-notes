import 'server-only';
import type { NextRequest } from 'next/server';
import { Errors } from '@/lib/errors';

/**
 * Cheap, explicit protections for the state-changing commerce endpoints.
 *
 * The session cookie is `SameSite=lax`, which already keeps a cross-site POST from
 * carrying it. These add two checks that do not depend on that: the request must say it
 * is JSON (a cross-site HTML form cannot send `application/json`), and if the browser
 * names an Origin it must be this site's own.
 */
export function assertJsonSameOrigin(request: NextRequest): void {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw Errors.validation('Expected a JSON request.');
  }
  const origin = request.headers.get('origin');
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw Errors.forbidden('Request origin not allowed.');
    }
    const own = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (!own || host !== own) throw Errors.forbidden('Request origin not allowed.');
  }
}
