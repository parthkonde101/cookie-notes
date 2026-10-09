import { isStudentEmail } from '@/lib/validation';

/**
 * Whether this account should be offered "Verify my current email".
 *
 * That is a student who has not verified yet and whose address is ALREADY on the
 * college domain. They have no new address to move to, so the migration flow —
 * which proves a different address and then adopts it — cannot help them; what
 * they need is to prove they can read the mailbox they already sign in with.
 *
 * The domain only decides which screen to show. It is never evidence of
 * ownership: the account is marked verified by a code that was delivered to the
 * address, and by nothing else. A student on any other domain, an admin, and
 * anyone already verified are all outside this path.
 */
export function canVerifyCurrentEmail(user: {
  role: 'STUDENT' | 'ADMIN';
  email: string;
  emailVerifiedAt: Date | null;
}): boolean {
  return user.role === 'STUDENT' && user.emailVerifiedAt === null && isStudentEmail(user.email);
}
