import Link from 'next/link';
import { AuthModalProvider } from '@/components/auth/auth-modal';
import { VerificationGateProvider } from '@/components/auth/verification-gate';
import { SiteHeader } from '@/components/layout/site-header';
import { SessionHeartbeat } from '@/components/session/heartbeat';
import { MailWarning } from 'lucide-react';
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
  // Browsing the catalogue stays public and ungated — it always was. But a
  // student who is signed in and cannot yet open anything deserves to know why
  // before they click a unit, and to be told at the moment they click it.
  //
  // Both the banner and the dialog read this one value, which comes from the
  // same helper the server guards use, so what the catalogue says and what the
  // reader enforces cannot drift apart.
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

          {mustVerify && (
            <div className="border-b border-warning/30 bg-warning/10">
              <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm sm:px-6">
                <MailWarning aria-hidden className="size-4 shrink-0 text-warning" />
                <p className="min-w-0 flex-1 text-foreground/90">
                  Verify your MIT-WPU email to open notes again.
                </p>
                <Link
                  href={EMAIL_MIGRATION_PATH}
                  className="shrink-0 font-medium text-foreground underline underline-offset-4"
                >
                  Verify now
                </Link>
              </div>
            </div>
          )}

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
