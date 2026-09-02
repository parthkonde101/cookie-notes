/**
 * Creates (or promotes) the first administrator.
 *
 *   npm run create:admin
 *
 * Interactive by default — the password is prompted for and never echoed, so it
 * does not end up in your shell history. For CI or a one-shot server setup, set
 * ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME in the environment and the script
 * runs without prompting.
 *
 * No credentials are hard-coded anywhere in this repository.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function checkPassword(password: string, email: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('at least 10 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length > 2 && password.toLowerCase().includes(local)) {
    problems.push('no part of your email address');
  }
  return problems;
}

/** Reads a line without echoing it back to the terminal. */
async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);

  const ETX = '\u0003'; // Ctrl+C
  const EOT = '\u0004'; // Ctrl+D
  const DEL = '\u007f'; // Backspace

  return new Promise((resolve) => {
    let buffer = '';

    const onData = (chunk: Buffer) => {
      const char = chunk.toString('utf8');

      if (char === '\n' || char === '\r' || char === EOT) {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buffer);
        return;
      }
      if (char === ETX) {
        process.stdout.write('\n');
        process.exit(1);
      }
      if (char === DEL || char === '\b') {
        buffer = buffer.slice(0, -1);
        return;
      }
      buffer += char;
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  const envEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD;
  const envName = process.env.ADMIN_NAME?.trim();

  let email: string;
  let password: string;
  let name: string;

  if (envEmail && envPassword) {
    email = envEmail;
    password = envPassword;
    name = envName || 'Platform Admin';
    console.log(`Using ADMIN_EMAIL from the environment (${email}).`);
  } else {
    if (!stdin.isTTY) {
      console.error(
        'This script needs a terminal, or ADMIN_EMAIL and ADMIN_PASSWORD set in the environment.',
      );
      process.exit(1);
    }

    const rl = createInterface({ input: stdin, output: stdout });
    email = (await rl.question('Admin email: ')).trim().toLowerCase();
    name = (await rl.question('Full name [Platform Admin]: ')).trim() || 'Platform Admin';
    rl.close();

    password = await promptHidden('Password (hidden): ');
    const confirm = await promptHidden('Confirm password: ');

    if (password !== confirm) {
      console.error('\nThose passwords do not match.');
      process.exit(1);
    }
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('That does not look like a valid email address.');
    process.exit(1);
  }

  const problems = checkPassword(password, email);
  if (problems.length > 0) {
    console.error(`\nThe password needs ${problems.join(', ')}.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    await prisma.user.update({
      where: { email },
      data: { role: 'ADMIN', status: 'ACTIVE', passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    await prisma.auditLog.create({
      data: {
        action: 'USER_UPDATED',
        actorEmail: email,
        targetType: 'user',
        targetId: existing.id,
        targetLabel: email,
        metadata: { via: 'create-admin script', promotedToAdmin: true },
      },
    });
    console.log(`\n✓ ${email} is now an active admin (password updated).`);
  } else {
    const created = await prisma.user.create({
      data: { email, name, passwordHash, role: 'ADMIN', status: 'ACTIVE' },
    });
    await prisma.auditLog.create({
      data: {
        action: 'USER_CREATED',
        actorEmail: email,
        targetType: 'user',
        targetId: created.id,
        targetLabel: email,
        metadata: { via: 'create-admin script', role: 'ADMIN' },
      },
    });
    console.log(`\n✓ Admin created: ${email}`);
  }

  console.log('  Sign in at /login, then go to /admin.\n');

  if (envPassword) {
    console.log('Remember to remove ADMIN_PASSWORD from your environment now.\n');
  }
}

main()
  .catch((error) => {
    console.error('\nFailed:', error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
