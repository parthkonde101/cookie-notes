import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/feedback';
import { ResetPasswordForm } from '@/components/auth/password-reset-forms';

export const metadata: Metadata = { title: 'Choose a new password' };
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-xl">Reset link missing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="error">
            This page needs a valid reset link. Request a new one and open it from your email.
          </Alert>
          <Button asChild variant="outline" className="w-full">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1.5 pb-4">
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>
          For your security, this signs you out everywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResetPasswordForm token={token} />
      </CardContent>
    </Card>
  );
}
