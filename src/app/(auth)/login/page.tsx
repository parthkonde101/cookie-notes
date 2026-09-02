import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from '@/components/auth/login-form';
import { optionalUser } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; next?: string }>;
}) {
  const auth = await optionalUser();
  if (auth) redirect(auth.user.role === 'ADMIN' ? '/admin' : '/');

  const { reason, next } = await searchParams;

  return (
    <Card>
      <CardHeader className="space-y-1.5 pb-4">
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>Sign in to open your notes.</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm reason={reason} next={next} />
      </CardContent>
    </Card>
  );
}
