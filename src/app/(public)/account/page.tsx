import type { Metadata } from 'next';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

/**
 * The account page.
 *
 * Basic profile information and nothing else. Access, entitlements, sign-in
 * history and activity are all still recorded — they live in the admin area,
 * not here. Students see who they are signed in as and how to change their
 * password.
 */
export default async function AccountPage() {
  const { user } = await requireUser('/account');

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="border-b border-border pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      </header>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <CardTitle>Your details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Detail label="Name" value={user.name} />
          <Detail label="Email" value={user.email} />
          {user.college && <Detail label="College" value={user.college} />}
          {user.program && <Detail label="Programme" value={user.program} />}
          {user.semester && <Detail label="Semester" value={`Semester ${user.semester}`} />}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/forgot-password">
                <KeyRound className="size-4" />
                Change password
              </Link>
            </Button>
            {user.role === 'ADMIN' && (
              <Button asChild size="sm">
                <Link href="/admin">Admin panel</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="font-medium">{value}</div>
    </div>
  );
}
