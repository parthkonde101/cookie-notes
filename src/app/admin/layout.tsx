import { AdminShell } from '@/components/admin/admin-shell';
import { SessionHeartbeat } from '@/components/session/heartbeat';
import { requireAdmin } from '@/lib/auth/guards';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Role is verified here on the server for every admin page, and again inside
  // every admin action and API route.
  const { user } = await requireAdmin();

  return (
    <>
      <SessionHeartbeat />
      <AdminShell user={{ name: user.name, email: user.email }}>{children}</AdminShell>
    </>
  );
}
