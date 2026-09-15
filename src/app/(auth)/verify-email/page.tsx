import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { VerifyEmailForm } from '@/components/auth/verify-email-form';
import { optionalUser } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Verify your email' };
export const dynamic = 'force-dynamic';

/**
 * Step two of signing up.
 *
 * The address arrives in the query string purely so the form knows which
 * account it is confirming — it is not a credential and grants nothing. Anyone
 * can put any address here; without the code that was mailed to it, nothing
 * happens.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const auth = await optionalUser();
  if (auth) redirect(auth.user.role === 'ADMIN' ? '/admin' : '/');

  const { email } = await searchParams;
  // Nothing to verify without knowing which address — send them to sign in,
  // where they can start again.
  if (!email) redirect('/login');

  return (
    <Card>
      <CardHeader className="space-y-1.5 pb-4">
        <CardTitle className="text-xl">Check your email</CardTitle>
        <CardDescription>One code and your account is ready.</CardDescription>
      </CardHeader>
      <CardContent>
        <VerifyEmailForm email={email.trim().toLowerCase()} />
      </CardContent>
    </Card>
  );
}
