import 'server-only';

/**
 * Central, validated access to environment configuration.
 *
 * Values are read through getters, so a missing variable fails at the moment it
 * is actually needed rather than at import time — that keeps `next build` from
 * requiring production secrets on the build machine while still refusing to
 * serve a request with, say, no AUTH_SECRET.
 *
 * Nothing here is ever imported by a client component: `server-only` turns that
 * into a build error, so secrets cannot leak into the browser bundle.
 */

const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';

function required(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (process.env.NODE_ENV !== 'production' || isBuildPhase) return devFallback;
  throw new Error(
    `Missing required environment variable ${name}. See .env.example for the full list.`,
  );
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export const env = {
  get isProduction() {
    return process.env.NODE_ENV === 'production';
  },
  get appUrl() {
    return process.env.APP_URL ?? 'http://localhost:3000';
  },
  get databaseUrl() {
    return required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/scholarvault');
  },

  /** Signs auxiliary auth values. Session tokens themselves are random + hashed. */
  get authSecret() {
    return required('AUTH_SECRET', 'dev-only-auth-secret-change-me-000000000000');
  },
  /** Signs the short-lived tokens that authorise one note-content request. */
  get viewTokenSecret() {
    return required('VIEW_TOKEN_SECRET', 'dev-only-view-secret-change-me-000000000000');
  },

  session: {
    get absoluteHours() {
      return num('SESSION_ABSOLUTE_HOURS', 168);
    },
    get idleMinutes() {
      return num('SESSION_IDLE_MINUTES', 30);
    },
    /**
     * Lifetime of a "Keep me signed in" session, used as BOTH its absolute
     * lifetime and its idle window — a remembered session is one that simply
     * lives this long unless it is ended.
     *
     * This is an authentication lifetime and nothing else. It has no bearing on
     * who counts as an Active User; that is `liveWindowMinutes`, below, and the
     * two are kept deliberately independent.
     */
    get rememberDays() {
      return num('SESSION_REMEMBER_DAYS', 30);
    },
    cookieName: 'sv_session',
  },

  /**
   * Which revision of the terms and of the analytics notice a student is
   * agreeing to. Recorded per user at sign-up, so a later revision can be told
   * apart from the text someone actually saw.
   */
  consent: {
    get termsVersion() {
      return process.env.TERMS_VERSION ?? '2026-09-01';
    },
    get analyticsVersion() {
      return process.env.ANALYTICS_CONSENT_VERSION ?? '2026-09-01';
    },
  },

  /** Recency window that counts a user as "studying right now". */
  get liveWindowMinutes() {
    return num('LIVE_WINDOW_MINUTES', 5);
  },

  catalog: {
    /**
     * Preview mode. While true, any signed-in active student may open any
     * PUBLISHED note, whether or not an entitlement covers it.
     *
     * This is a deliberate, auditable *addition* to the authorisation chain, not
     * a hole in it: authentication, session validity, note status and the
     * signed view token are all still enforced, and every grant an admin makes
     * keeps working exactly as before. Set it to false and the platform becomes
     * entitlement-gated with no other change.
     */
    get openAccess() {
      return bool('OPEN_ACCESS_MODE', true);
    },
    /** Currency symbol shown next to prices. Display only. */
    get currencySymbol() {
      return process.env.PRICE_CURRENCY_SYMBOL ?? '\u20b9';
    },
  },

  storage: {
    get driver(): 'local' | 's3' {
      return process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local';
    },
    get localDir() {
      return process.env.STORAGE_LOCAL_DIR ?? './.private-storage';
    },
    s3: {
      get bucket() {
        return process.env.S3_BUCKET ?? '';
      },
      get region() {
        return process.env.S3_REGION ?? 'auto';
      },
      get endpoint() {
        return process.env.S3_ENDPOINT || undefined;
      },
      get accessKeyId() {
        return process.env.S3_ACCESS_KEY_ID ?? '';
      },
      get secretAccessKey() {
        return process.env.S3_SECRET_ACCESS_KEY ?? '';
      },
      get forcePathStyle() {
        return bool('S3_FORCE_PATH_STYLE', true);
      },
    },
  },

  uploads: {
    get maxMb() {
      return num('MAX_UPLOAD_MB', 50);
    },
    get maxBytes() {
      return num('MAX_UPLOAD_MB', 50) * 1024 * 1024;
    },
    allowedMimeTypes: ['application/pdf'] as const,
  },

  rateLimit: {
    get loginMaxAttempts() {
      return num('LOGIN_MAX_ATTEMPTS', 8);
    },
    get loginWindowMinutes() {
      return num('LOGIN_WINDOW_MINUTES', 15);
    },
    get lockoutMinutes() {
      return num('LOCKOUT_MINUTES', 15);
    },
    get registerMaxPerHour() {
      return num('REGISTER_MAX_PER_HOUR', 10);
    },
  },

  mail: {
    get driver(): 'console' | 'resend' {
      return process.env.MAIL_DRIVER === 'resend' ? 'resend' : 'console';
    },
    get from() {
      return process.env.MAIL_FROM ?? 'Cookie Notes <no-reply@example.com>';
    },
    get resendApiKey() {
      return process.env.RESEND_API_KEY ?? '';
    },
  },
};

/**
 * Configuration problems worth shouting about at boot. Surfaced by
 * `instrumentation.ts` so a misconfigured production deploy is obvious in the
 * logs on the first request rather than mysterious later.
 */
export function productionConfigWarnings(): string[] {
  const problems: string[] = [];
  if (process.env.NODE_ENV !== 'production') return problems;

  const auth = process.env.AUTH_SECRET ?? '';
  const view = process.env.VIEW_TOKEN_SECRET ?? '';

  if (!auth || auth.includes('replace-me') || auth.length < 24) {
    problems.push('AUTH_SECRET is missing or too short — generate one with `openssl rand -base64 32`.');
  }
  if (!view || view.includes('replace-me') || view.length < 24) {
    problems.push('VIEW_TOKEN_SECRET is missing or too short.');
  }
  if (auth && view && auth === view) {
    problems.push('AUTH_SECRET and VIEW_TOKEN_SECRET must be different values.');
  }
  if (env.storage.driver === 's3') {
    // Names only — never the values. A missing one of these fails at upload
    // time with an opaque browser error, so it is worth saying at boot.
    const missing = (
      [
        ['S3_BUCKET', env.storage.s3.bucket],
        ['S3_ENDPOINT', env.storage.s3.endpoint],
        ['S3_ACCESS_KEY_ID', env.storage.s3.accessKeyId],
        ['S3_SECRET_ACCESS_KEY', env.storage.s3.secretAccessKey],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      problems.push(`STORAGE_DRIVER=s3 but ${missing.join(', ')} not set.`);
    }
    if (env.storage.s3.endpoint?.includes('r2.cloudflarestorage.com') && env.storage.s3.region !== 'auto') {
      problems.push(
        `S3_REGION is "${env.storage.s3.region}" but Cloudflare R2 signs with "auto" — ` +
          'uploads will fail with SignatureDoesNotMatch.',
      );
    }
  }
  if (env.storage.driver === 'local') {
    problems.push(
      'STORAGE_DRIVER=local in production: uploaded notes will not survive a redeploy on a ' +
        'serverless host. Use STORAGE_DRIVER=s3 unless you run on a server with a persistent disk.',
    );
  }
  if (!env.appUrl.startsWith('https://')) {
    problems.push('APP_URL should be an https:// URL in production.');
  }

  // Mail. Previously unchecked, which is how a misconfigured driver could turn
  // every password reset into a line in a log nobody reads. Registration now
  // depends on mail actually leaving the building — an undelivered verification
  // code means nobody can create an account at all — so this is worth shouting
  // about at boot rather than discovering from a support message.
  if (env.mail.driver !== 'resend') {
    problems.push(
      'MAIL_DRIVER is not "resend" in production — password resets and sign-up ' +
        'verification codes will be printed to the log instead of emailed, so no ' +
        'student will be able to register or recover their account.',
    );
  } else {
    if (!env.mail.resendApiKey) {
      problems.push('MAIL_DRIVER=resend but RESEND_API_KEY is not set — no email will be sent.');
    }
    if (!process.env.MAIL_FROM) {
      problems.push(
        'MAIL_FROM is not set — the default example.com sender will be rejected by Resend.',
      );
    } else if (/@example\.(com|org|net)>?\s*$/i.test(env.mail.from)) {
      problems.push(
        'MAIL_FROM points at example.com — use a sender on a domain verified with Resend.',
      );
    }
  }

  return problems;
}
