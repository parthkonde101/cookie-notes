import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { CollegeEmailForm } from '@/components/auth/college-email-form';
import { needsEmailMigration, requireUser } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Update your college email' };
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

  return (
    <Card>
      {/* The heading belongs to the form: it changes with the step, and the
          step is client state. */}
      <CardContent className="pt-6">
        <CollegeEmailForm initialPending={user.pendingEmail} nextHref={nextHref} />
      </CardContent>
    </Card>
  );
}
