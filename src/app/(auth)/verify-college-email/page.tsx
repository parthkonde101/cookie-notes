import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { CollegeEmailForm } from '@/components/auth/college-email-form';
import { CollegeStudentVerification } from '@/components/auth/college-student-verification';
import { canVerifyCurrentEmail } from '@/lib/auth/current-email';
import { lastIssuedAt, OTP_PURPOSE, OTP_TTL_MINUTES } from '@/lib/auth/otp';
import { needsEmailMigration, requireUser } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Verify your MIT-WPU email' };
export const dynamic = 'force-dynamic';

/**
 * Only a path inside this app is allowed back out of `?next=`.
 *
 * The value arrives from the browser, so it is treated as untrusted: anything
 * that is not a single-slash relative path — an absolute URL, a
 * protocol-relative `//host`, a backslash trick — is discarded rather than
 * corrected, and the student simply lands on the catalogue.
 */
function safeNext(value: string | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * The one screen an unverified student can reach.
 *
 * It offers one of two flows, chosen by what the account already is:
 *
 *  - a student whose address is ALREADY on the college domain verifies that
 *    address with a code sent to it — nothing about the account changes — or,
 *    if they mistyped it when they signed up, moves to the correct college
 *    address by the same flow everyone else uses;
 *  - a student on any other domain proves a college address and moves to it.
 *
 * The choice is only about which form to draw. Both finish by checking a code
 * that was delivered to an address, never by the look of the address itself.
 *
 * `allowUnverified` is deliberate and load-bearing: every visitor here is by
 * definition someone the ordinary guard would bounce, so this page has to opt
 * out of the gate that sends them here — otherwise it would redirect to itself.
 *
 * A student who has already verified is sent away, so the prompt can never
 * reappear once it has been answered.
 */
export default async function VerifyCollegeEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { user } = await requireUser(undefined, { allowUnverified: true });
  const { next } = await searchParams;
  const nextHref = safeNext(next);

  if (!needsEmailMigration(user)) {
    redirect(user.role === 'ADMIN' ? '/admin' : nextHref);
  }

  // A live code from an earlier visit, so closing the tab does not lose it.
  const verifyingCurrent = canVerifyCurrentEmail(user);
  const sent = verifyingCurrent ? await lastIssuedAt(user.id, OTP_PURPOSE.currentEmail) : null;
  const sentAt =
    sent && Date.now() - sent.getTime() < OTP_TTL_MINUTES * 60 * 1000 ? sent.toISOString() : null;

  return (
    <Card>
      {/* The heading belongs to the form: it changes with the step, and the
          step is client state. */}
      <CardContent className="pt-6">
        {verifyingCurrent ? (
          <CollegeStudentVerification
            email={user.email}
            initialSentAt={sentAt}
            initialPending={user.pendingEmail}
            nextHref={nextHref}
          />
        ) : (
          <CollegeEmailForm initialPending={user.pendingEmail} nextHref={nextHref} />
        )}
      </CardContent>
    </Card>
  );
}
