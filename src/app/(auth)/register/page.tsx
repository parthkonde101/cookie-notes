import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RegisterForm } from '@/components/auth/register-form';
import { optionalUser } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  const auth = await optionalUser();
  if (auth) redirect(auth.user.role === 'ADMIN' ? '/admin' : '/');

  return (
    <Card>
      <CardHeader className="space-y-1.5 pb-4">
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>
          It takes a minute. Access to notes is granted to your account by an administrator.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RegisterForm />
      </CardContent>
    </Card>
  );
}
