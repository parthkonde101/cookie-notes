'use client';

import { useEffect } from 'react';
import { PROGRAM_COOKIE, PROGRAM_COOKIE_MAX_AGE, type Program } from '@/lib/program';

/**
 * Remembers which shelf the page you are on belongs to.
 *
 * Without this, "persists through navigation" has a hole: open a Polytechnic
 * subject from a shared link while your cookie still says B.Tech, press Back,
 * and the catalogue shows you the wrong shelf — the one you were never on.
 * Rendering this on a subject page closes it, by writing the program that
 * subject actually belongs to.
 *
 * Renders nothing and runs after paint, so it costs the page nothing. It is a
 * write-only breadcrumb: no state, no re-render, and nothing reads the result
 * until the next server render asks for the cookie.
 */
export function ProgramMemory({ program }: { program: Program }) {
  useEffect(() => {
    document.cookie = `${PROGRAM_COOKIE}=${program}; path=/; max-age=${PROGRAM_COOKIE_MAX_AGE}; SameSite=Lax`;
  }, [program]);

  return null;
}
