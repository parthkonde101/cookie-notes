import { SessionHeartbeat } from '@/components/session/heartbeat';
import { requireUser } from '@/lib/auth/guards';

export const dynamic = 'force-dynamic';

/**
 * The reader gets the full viewport — no sidebar, no chrome competing with the
 * page being studied — but keeps the session heartbeat so a revoked or
 * superseded session is noticed while reading.
 */
export default async function ReaderLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return (
    <>
      <SessionHeartbeat />
      {children}
    </>
  );
}
