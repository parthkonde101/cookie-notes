import 'server-only';
import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Constant-ish work even when the account does not exist, so response timing
 * does not reveal whether an email is registered.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.5Yc6QeCVzXhBHf5cnnaFhs4ekWDZ2Nq';
export async function fakeVerify(): Promise<void> {
  await bcrypt.compare('not-a-real-password', DUMMY_HASH);
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
  score: 0 | 1 | 2 | 3 | 4;
}

const COMMON = new Set([
  'password',
  'password1',
  'passw0rd',
  '12345678',
  '123456789',
  'qwerty123',
  'iloveyou',
  'admin123',
  'letmein1',
  'welcome1',
  'student1',
  'notesapp',
]);

/** Shared by the API and the client-side strength meter. */
export function checkPasswordStrength(password: string, email?: string): PasswordCheck {
  const problems: string[] = [];

  if (password.length < 10) problems.push('Use at least 10 characters.');
  if (!/[a-z]/.test(password)) problems.push('Add a lowercase letter.');
  if (!/[A-Z]/.test(password)) problems.push('Add an uppercase letter.');
  if (!/[0-9]/.test(password)) problems.push('Add a number.');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Add a symbol.');
  if (COMMON.has(password.toLowerCase())) problems.push('That password is too common.');
  if (email) {
    const local = email.split('@')[0]?.toLowerCase();
    if (local && local.length > 2 && password.toLowerCase().includes(local)) {
      problems.push('Do not use your email address in the password.');
    }
  }
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.');

  const passed = 5 - Math.min(problems.length, 5);
  const score = Math.max(0, Math.min(4, passed - 1)) as PasswordCheck['score'];

  return { ok: problems.length === 0, problems, score };
}
