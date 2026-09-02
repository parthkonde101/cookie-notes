import Link from 'next/link';
import { AuthModalProvider } from '@/components/auth/auth-modal';
import { SiteHeader } from '@/components/layout/site-header';
import { SessionHeartbeat } from '@/components/session/heartbeat';
import { optionalUser } from '@/lib/auth/guards';
import { countLiveUsers } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * The public product shell.
 *
 * Everything a student sees lives under here: the catalogue is the destination
 * and the layout does not change when they sign in. Authentication only adds the
 * account menu and the session heartbeat.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const auth = await optionalUser();
  const liveUsers = auth ? await countLiveUsers() : undefined;

  return (
    <AuthModalProvider>
      {auth && <SessionHeartbeat />}

      <div className="flex min-h-dvh flex-col">
        <SiteHeader
          user={
            auth
              ? { name: auth.user.name, email: auth.user.email, role: auth.user.role }
              : null
          }
          liveUsers={liveUsers}
        />

        <main className="flex-1">{children}</main>

        <footer className="border-t border-border">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>© {new Date().getFullYear()} Cookie Notes</p>
            {auth && (
              <p>
                <Link
                  href="/account"
                  className="underline-offset-4 hover:text-foreground hover:underline"
                >
                  Your account
                </Link>
              </p>
            )}
          </div>
        </footer>
      </div>
    </AuthModalProvider>
  );
}
