/**
 * A server for a test suite to talk to — one the suite starts itself.
 *
 * Why not simply point the suite at "the server on localhost"? Because a server
 * on loopback tells you nothing about which database it uses. One started from
 * the project directory reads `.env`, which in this project is a hosted Neon
 * branch holding copied student data; a suite that validated its own database
 * URL could then drive a server writing to a completely different database —
 * failed sign-ins, rate-limit rows and analytics events landing somewhere nobody
 * approved.
 *
 * So the suite starts its own production server (`next start`) with an explicit,
 * minimal environment in which DATABASE_URL is the one it has already validated.
 * Process environment always wins over `.env` files, and nothing else the server
 * could use to find a database is passed along.
 *
 * `confirmServerUsesDatabase` is a second, independent check: it makes the server
 * do something observable in the approved database, and fails — closed — if that
 * does not appear.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface OwnedServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

export interface StartOptions {
  /** The disposable database URL, already approved by the caller. */
  databaseUrl: string;
  /** Must equal the suite's own AUTH_SECRET: the suite issues codes the server verifies. */
  authSecret: string;
  projectDir?: string;
  readyTimeoutMs?: number;
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * Starts `next start` on a free loopback port, connected to `databaseUrl` and
 * nothing else. Rejects (and leaves nothing running) if there is no production
 * build, or the server does not come up.
 */
export async function startOwnedServer(options: StartOptions): Promise<OwnedServer> {
  const projectDir = options.projectDir ?? process.cwd();
  const nextBin = path.join(projectDir, 'node_modules', 'next', 'dist', 'bin', 'next');

  if (!existsSync(path.join(projectDir, '.next', 'BUILD_ID'))) {
    throw new Error('There is no production build to start. Run "npm run build" first.');
  }
  if (!existsSync(nextBin)) throw new Error('Next.js is not installed in this project.');
  if (options.authSecret.length < 16) throw new Error('AUTH_SECRET is missing or too short for the server.');

  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Built from nothing: no `...process.env`. Only what the server needs, and
  // nothing that could name a different database (no PG*, no POSTGRES_*, no
  // DIRECT_URL) or a real mail provider.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    DATABASE_URL: options.databaseUrl,
    AUTH_SECRET: options.authSecret,
    VIEW_TOKEN_SECRET: randomBytes(24).toString('hex'),
    APP_URL: baseUrl,
    MAIL_DRIVER: 'console',
    MAIL_FROM: 'Cookie Notes <test@example.invalid>',
    RESEND_API_KEY: '',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: mkdtempSync(path.join(tmpdir(), 'cookie-notes-test-storage-')),
    NEXT_TELEMETRY_DISABLED: '1',
  };

  const child: ChildProcess = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: projectDir,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  // Drained, never printed: the console mail driver writes codes to this stream.
  child.stdout?.resume();
  child.stderr?.resume();

  const stop = async () => {
    if (exited) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  };
  process.once('exit', () => {
    if (!exited) child.kill('SIGKILL');
  });

  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (exited) throw new Error('The test server exited before it was ready.');
    try {
      // The sign-in page: it renders without touching the database.
      const response = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
      if (response.status === 200) return { baseUrl, stop };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await stop();
  throw new Error('The test server did not become ready in time.');
}

export interface HandshakeProbe {
  /** How many LOGIN_FAILED events in the approved database carry this marker address. */
  countMarker: (marker: string) => Promise<number>;
}

/**
 * Makes the server record something only it can record — a failed sign-in for an
 * address nobody has — and looks for that record in the approved database.
 *
 * Returns true only if it is found. Anything else — the server writes elsewhere,
 * writes nothing, is slow, or errors — is false, and the caller must stop: the
 * server's database could not be verified.
 */
export async function confirmServerUsesDatabase(
  baseUrl: string,
  probe: HandshakeProbe,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const marker = `handshake-${randomBytes(8).toString('hex')}@curtest.invalid`;
  try {
    await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.254' },
      body: JSON.stringify({ email: marker, password: 'not-a-real-password' }),
    });
    const deadline = Date.now() + (options.timeoutMs ?? 8000);
    while (Date.now() < deadline) {
      if ((await probe.countMarker(marker)) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  } catch {
    return false;
  }
}
