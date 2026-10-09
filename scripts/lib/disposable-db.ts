/**
 * Refuses to let a destructive test run against anything but a disposable local
 * database that the person running it has named explicitly.
 *
 * Some suites create and delete accounts, sessions and codes. Pointed at the
 * wrong database — and `dotenv` happily loads whatever `.env` says, which in this
 * project is a hosted Neon branch holding copied student data — that is an
 * incident. So a run needs ALL of the following, and says which one is missing:
 *
 *  - DATABASE_URL names a loopback host (127.0.0.1, localhost or ::1) — never a
 *    hosted database, Neon or otherwise;
 *  - the URL carries no query parameters that can change WHERE it connects
 *    (`host`, `hostaddr`, `port`, `options`, `service`…). Only a short allow-list
 *    of harmless ones is accepted, and the host the database driver itself would
 *    resolve from the URL is checked as well as the host written in it;
 *  - the database name says it is disposable (contains "test", "scratch" or
 *    "disposable") and is not one of the names real environments use;
 *  - VERIFY_DISPOSABLE_DB is set to that exact name — an explicit approval that
 *    cannot be given by accident, and cannot be inherited from `.env`;
 *  - VERIFY_BASE_URL is NOT set. The suite starts its own server, with exactly
 *    this DATABASE_URL, rather than trusting that some server on loopback is
 *    connected to the database that was approved here.
 *
 * It only ever reports reasons. It never prints the connection string, the host,
 * the user or the password.
 */

import { parse as parseConnectionString } from 'pg-connection-string';

export interface TargetVerdict {
  ok: boolean;
  /** Human-readable, and safe to print. */
  reasons: string[];
  /** The approved database name, when the target was accepted. */
  database?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const REAL_DATABASE_NAMES = /^(neondb|postgres|production|prod|main|master|development|dev|staging|preview|app|cookienotes|cookie_notes)$/i;
const DISPOSABLE_NAME = /(test|scratch|disposable)/i;
/**
 * The only query parameters a URL may carry. Anything else — `host`, `hostaddr`,
 * `port`, `options`, `service`, `dbname`, a second `user`… — can send the driver
 * somewhere other than the host written in the URL, so it is refused by name
 * rather than guessed at.
 */
export const ALLOWED_QUERY_PARAMETERS = new Set(['sslmode', 'connect_timeout', 'application_name']);

export function evaluateTestTarget(env: Record<string, string | undefined>): TargetVerdict {
  const reasons: string[] = [];
  const raw = env.DATABASE_URL;
  let database: string | undefined;

  if (!raw) {
    reasons.push('DATABASE_URL is not set.');
  } else {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      reasons.push('DATABASE_URL is not a valid connection URL.');
    }

    if (url) {
      if (!/^postgres(ql)?:$/.test(url.protocol)) reasons.push('DATABASE_URL is not a PostgreSQL URL.');

      if (/neon\.tech|neon\.build|neon/i.test(url.hostname)) {
        reasons.push('The target looks like a Neon database. This suite must never run against Neon.');
      }
      if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
        reasons.push('The database host is not a loopback address. Only a local, disposable database is allowed.');
      }

      const overriding = [...new Set([...url.searchParams.keys()].map((key) => key.toLowerCase()))].filter(
        (key) => !ALLOWED_QUERY_PARAMETERS.has(key),
      );
      if (overriding.length > 0) {
        reasons.push(
          `The connection URL carries parameters that can change where it connects (${overriding.join(', ')}). Only ${[...ALLOWED_QUERY_PARAMETERS].join(', ')} are allowed.`,
        );
      }

      // And ask the same parser the driver uses where it would REALLY connect.
      try {
        const driver = parseConnectionString(raw) as { host?: string | null; hostaddr?: string | null };
        const driverHost = (driver.host ?? '').toLowerCase();
        if (!LOOPBACK_HOSTS.has(driverHost) && !LOOPBACK_HOSTS.has(`[${driverHost}]`)) {
          reasons.push('The host the database driver would connect to is not a loopback address.');
        }
        if (driver.hostaddr) reasons.push('The connection URL sets a host address the driver would use instead of the host.');
      } catch {
        reasons.push('The connection URL could not be interpreted the way the database driver would.');
      }

      database = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (!database) {
        reasons.push('The connection URL names no database.');
      } else {
        if (REAL_DATABASE_NAMES.test(database)) {
          reasons.push(`The database name "${database}" is one that real environments use.`);
        }
        if (!DISPOSABLE_NAME.test(database)) {
          reasons.push('The database name does not say it is disposable (it must contain "test", "scratch" or "disposable").');
        }
        if (env.VERIFY_DISPOSABLE_DB !== database) {
          reasons.push(
            'VERIFY_DISPOSABLE_DB must be set to the exact database name to approve this run. It is not set, or it names a different database.',
          );
        }
      }
    }
  }

  if (env.VERIFY_BASE_URL) {
    reasons.push(
      'VERIFY_BASE_URL must not be set. This suite starts its own server against the approved database; it will not trust another server to be connected to it.',
    );
  }

  return reasons.length === 0 ? { ok: true, reasons, database } : { ok: false, reasons };
}

/** What the connected database says about itself, for the second line of defence. */
export interface DatabaseIdentity {
  database: string;
  serverAddress: string | null;
  /** Rows in `users` that do not belong to the suite's own fixtures. */
  foreignUsers: number;
}

/** A disposable database holds nothing but fixtures; more than this is somebody's data. */
export const MAX_FOREIGN_USERS = 25;

export function evaluateDatabaseIdentity(identity: DatabaseIdentity, approved: string): string[] {
  const reasons: string[] = [];
  if (identity.database !== approved) reasons.push('The connected database is not the one that was approved.');
  if (identity.serverAddress !== null && !['127.0.0.1', '::1'].includes(identity.serverAddress)) {
    reasons.push('The database server is not on a loopback address.');
  }
  if (identity.foreignUsers > MAX_FOREIGN_USERS) {
    reasons.push(
      `The database already holds ${identity.foreignUsers} users that are not this suite's fixtures. A disposable test database should be nearly empty; this looks like real data.`,
    );
  }
  return reasons;
}
