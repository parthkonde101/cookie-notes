import Link from 'next/link';
import { AuthModalProvider } from '@/components/auth/auth-modal';
import { VerificationGateProvider } from '@/components/auth/verification-gate';
import { SiteHeader } from '@/components/layout/site-header';
import { SessionHeartbeat } from '@/components/session/heartbeat';
import { EMAIL_MIGRATION_PATH, needsEmailMigration, optionalUser } from '@/lib/auth/guards';
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
  // Browsing the catalogue stays public and ungated — it always was. A student
  // who is signed in but unverified is told why at the moment they try to open
  // a note or write feedback, in words that match what they tried.
  //
  // The dialog reads this one value, which comes from the same helper the
  // server guards use, so what the pages say and what the guards enforce cannot
  // drift apart.
  const mustVerify = auth ? needsEmailMigration(auth.user) : false;

  return (
    <AuthModalProvider>
      <VerificationGateProvider mustVerify={mustVerify} verifyPath={EMAIL_MIGRATION_PATH}>
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
      </VerificationGateProvider>
    </AuthModalProvider>
  );
}
