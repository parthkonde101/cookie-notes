import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { ActionButton } from '@/components/admin/action-button';
import { ActionForm, Field } from '@/components/admin/action-form';
import { GrantAccessForm } from '@/components/admin/grant-access-form';
import {
  deleteUserAction,
  resetUserPasswordAction,
  setUserStatusAction,
  terminateSessionAction,
  updateUserAction,
} from '@/app/admin/_actions/users';
import { revokeAccessAction } from '@/app/admin/_actions/access';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth/guards';
import { entitledNoteFilter, isPreviewMode } from '@/lib/access/entitlements';
import { describeDevice } from '@/lib/request';
import { formatDate, formatDateTime, pluralize, relativeTime } from '@/lib/utils';
import { loadCatalogTree } from '@/lib/admin/catalog';
import { resolveEntitlementLabels } from '@/lib/admin/entitlement-labels';

export const metadata: Metadata = { title: 'User' };
export const dynamic = 'force-dynamic';

const SOURCE_LABELS: Record<string, string> = {
  ADMIN_GRANT: 'Manual grant',
  PURCHASE: 'Purchase',
  PROMO: 'Promotion',
  SIGNUP_BONUS: 'Sign-up bonus',
};

/**
 * Everything about one account, including its access. This is the only place
 * entitlements are granted or revoked — the UI moved here in V2, the underlying
 * entitlement engine did not change.
 */
export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      entitlements: {
        orderBy: { grantedAt: 'desc' },
        include: { grantedBy: { select: { email: true } } },
      },
      sessions: { orderBy: { createdAt: 'desc' }, take: 8 },
      _count: { select: { noteViews: true, events: true } },
    },
  });
  if (!user) notFound();

  const entitledFilter = await entitledNoteFilter(user.id);

  const [events, catalog, labels, reachableNotes] = await Promise.all([
    prisma.activityEvent.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, type: true, createdAt: true },
    }),
    loadCatalogTree(),
    resolveEntitlementLabels(user.entitlements),
    prisma.note.count({ where: entitledFilter }),
  ]);

  const now = new Date();

  return (
    <PageContainer className="max-w-6xl">
      <Link
        href="/admin/users"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> All users
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {user.name}
            <Badge variant={user.status === 'ACTIVE' ? 'success' : 'destructive'}>
              {user.status.toLowerCase()}
            </Badge>
            {user.role === 'ADMIN' && <Badge>admin</Badge>}
          </span>
        }
        description={`${user.email} · joined ${formatDateTime(user.createdAt)} · ${user._count.noteViews} reading sessions`}
        actions={
          <>
            {user.status === 'ACTIVE' ? (
              <ActionButton
                variant="outline"
                size="sm"
                action={setUserStatusAction.bind(null, user.id, 'DISABLED')}
                confirm={{
                  title: 'Disable this account?',
                  description:
                    'They are signed out immediately and cannot sign in until you reactivate the account.',
                  confirmLabel: 'Disable account',
                  destructive: true,
                }}
              >
                Disable
              </ActionButton>
            ) : (
              <ActionButton
                variant="outline"
                size="sm"
                action={setUserStatusAction.bind(null, user.id, 'ACTIVE')}
              >
                Reactivate
              </ActionButton>
            )}
            <ActionButton
              variant="destructive"
              size="sm"
              action={deleteUserAction.bind(null, user.id)}
              confirm={{
                title: 'Delete this account permanently?',
                description:
                  'Sessions, grants and reading history are removed. The audit log keeps a record of the deletion.',
                confirmLabel: 'Delete permanently',
                destructive: true,
              }}
            >
              Delete
            </ActionButton>
          </>
        }
      />

      {/* ---- Access: the centre of this page ------------------------------ */}
      <Card className="mt-6 border-primary/25">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            Access
          </CardTitle>
          <CardDescription>
            What this account can open. Grants take effect immediately, and revoking one blocks
            the very next request — including a note already on screen.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
            <span>
              <span className="font-semibold tabular-nums">{user.entitlements.length}</span>{' '}
              <span className="text-muted-foreground">
                {user.entitlements.length === 1 ? 'grant' : 'grants'}
              </span>
            </span>
            <span>
              <span className="font-semibold tabular-nums">{reachableNotes}</span>{' '}
              <span className="text-muted-foreground">notes reachable by entitlement</span>
            </span>
            {isPreviewMode() && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                Open preview is on — every published note opens for signed-in students
              </span>
            )}
          </div>

          <GrantAccessForm catalog={catalog} fixedUser={{ id: user.id, label: user.email }} />

          {user.entitlements.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No access granted yet"
              description="Use the form above to give this account a semester, a subject, a unit or a single note."
            />
          ) : (
            <div className="rounded-md border border-border">
              <Table minWidthClass="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Content</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Granted</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {user.entitlements.map((entitlement) => {
                    const label = labels.get(entitlement.id);
                    const expired = entitlement.expiresAt !== null && entitlement.expiresAt <= now;

                    return (
                      <TableRow key={entitlement.id}>
                        <TableCell>
                          <p className={label?.resolved === false ? 'text-muted-foreground' : 'font-medium'}>
                            {label?.title ?? '—'}
                          </p>
                          {label?.context && (
                            <p className="text-xs text-muted-foreground">{label.context}</p>
                          )}
                          {entitlement.note && (
                            <p className="mt-0.5 text-xs italic text-muted-foreground">
                              “{entitlement.note}”
                            </p>
                          )}
                        </TableCell>

                        <TableCell>
                          <Badge variant="secondary">{entitlement.scope.toLowerCase()}</Badge>
                        </TableCell>

                        <TableCell className="text-sm">
                          {SOURCE_LABELS[entitlement.source] ?? entitlement.source}
                          {entitlement.orderId && (
                            <span className="block font-mono text-xs text-muted-foreground">
                              order {entitlement.orderId.slice(-8)}
                            </span>
                          )}
                        </TableCell>

                        <TableCell className="text-sm text-muted-foreground">
                          {formatDate(entitlement.grantedAt)}
                          {entitlement.grantedBy && (
                            <span className="block text-xs">by {entitlement.grantedBy.email}</span>
                          )}
                        </TableCell>

                        <TableCell className="text-sm">
                          {entitlement.expiresAt ? (
                            <span className={expired ? 'text-destructive' : 'text-muted-foreground'}>
                              {formatDate(entitlement.expiresAt)}
                              {expired && <span className="block text-xs">expired</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Never</span>
                          )}
                        </TableCell>

                        <TableCell className="text-right">
                          <ActionButton
                            variant="ghost"
                            size="sm"
                            action={revokeAccessAction.bind(null, entitlement.id)}
                            confirm={{
                              title: 'Revoke this access?',
                              description: `${user.email} loses it immediately, including any note currently open in their browser.`,
                              confirmLabel: 'Revoke',
                              destructive: true,
                            }}
                          >
                            Revoke
                          </ActionButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Profile & credentials ---------------------------------------- */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateUserAction.bind(null, user.id)} submitLabel="Save changes">
              <Field label="Full name" htmlFor="name">
                <Input id="name" name="name" defaultValue={user.name} required />
              </Field>
              <Field label="Role" htmlFor="role">
                <Select id="role" name="role" defaultValue={user.role}>
                  <option value="STUDENT">Student</option>
                  <option value="ADMIN">Admin</option>
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="College" htmlFor="college">
                  <Input id="college" name="college" defaultValue={user.college ?? ''} />
                </Field>
                <Field label="Programme" htmlFor="program">
                  <Input id="program" name="program" defaultValue={user.program ?? ''} />
                </Field>
              </div>
              <Field label="Semester" htmlFor="semester">
                <Input
                  id="semester"
                  name="semester"
                  type="number"
                  min={1}
                  max={12}
                  defaultValue={user.semester ?? ''}
                />
              </Field>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Set a new password</CardTitle>
            <CardDescription>Ends every active session for this account.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={resetUserPasswordAction.bind(null, user.id)}
              submitLabel="Update password"
              resetOnSuccess
            >
              <Field
                label="New password"
                htmlFor="password"
                hint="At least 10 characters with mixed case, a number and a symbol."
              >
                <Input id="password" name="password" type="text" required />
              </Field>
            </ActionForm>
          </CardContent>
        </Card>
      </div>

      {/* ---- Sessions & activity ------------------------------------------ */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Sessions</CardTitle>
            <CardDescription>Most recent first. Only one may be active at a time.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {user.sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sessions recorded.</p>
            ) : (
              user.sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2.5"
                >
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{describeDevice(session)}</p>
                    <p className="text-xs text-muted-foreground">
                      {session.ipAddress ?? 'unknown IP'} · started{' '}
                      {formatDateTime(session.createdAt)} · active{' '}
                      {relativeTime(session.lastActivityAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={session.status === 'ACTIVE' ? 'success' : 'outline'}>
                      {session.status.toLowerCase().replace('_', ' ')}
                    </Badge>
                    {session.status === 'ACTIVE' && (
                      <ActionButton
                        variant="ghost"
                        size="sm"
                        action={terminateSessionAction.bind(null, session.id)}
                      >
                        End
                      </ActionButton>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Activity</CardTitle>
            <CardDescription>
              Last 20 of {pluralize(user._count.events, 'recorded event')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity recorded.</p>
            ) : (
              <ol className="text-sm">
                {events.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2 last:border-0"
                  >
                    <span className="font-mono text-xs">{event.type}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {user.status !== 'ACTIVE' && (
        <Alert variant="warning" className="mt-6" title="This account is disabled">
          They cannot sign in, and any live session was ended when the account was disabled.
        </Alert>
      )}
    </PageContainer>
  );
}
