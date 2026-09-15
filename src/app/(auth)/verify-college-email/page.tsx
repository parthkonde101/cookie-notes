import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { CollegeEmailForm } from '@/components/auth/college-email-form';
import { needsEmailMigration, requireUser } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Update your college email' };
export const dynamic = 'force-dynamic';

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
export default async function VerifyCollegeEmailPage() {
  const { user } = await requireUser(undefined, { allowUnverified: true });

  if (!needsEmailMigration(user)) {
    redirect(user.role === 'ADMIN' ? '/admin' : '/');
  }

  return (
    <Card>
      {/* The heading belongs to the form: it changes with the step, and the
          step is client state. */}
      <CardContent className="pt-6">
        <CollegeEmailForm currentEmail={user.email} initialPending={user.pendingEmail} />
      </CardContent>
    </Card>
  );
}
