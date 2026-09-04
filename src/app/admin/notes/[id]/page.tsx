import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageContainer, PageHeader } from '@/components/layout/page-header';
import { ActionButton } from '@/components/admin/action-button';
import { NoteEditForm } from '@/components/admin/note-edit-form';
import { NoteReplaceForm } from '@/components/admin/note-replace-form';
import { deleteNoteAction } from '@/app/admin/_actions/notes';
import { revokeAccessAction } from '@/app/admin/_actions/access';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth/guards';
import { loadCatalogTree } from '@/lib/admin/catalog';
import { env } from '@/lib/env';
import { formatBytes, formatDateTime, formatDuration, relativeTime, truncateMiddle } from '@/lib/utils';

export const metadata: Metadata = { title: 'Note' };
export const dynamic = 'force-dynamic';

export default async function AdminNotePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const note = await prisma.note.findUnique({
    where: { id },
    include: {
      subject: { select: { id: true, name: true, semesterId: true } },
      unit: { select: { id: true, name: true } },
      topic: { select: { id: true, name: true } },
      uploadedBy: { select: { email: true } },
      versions: {
        orderBy: { version: 'desc' },
        select: { id: true, version: true, fileName: true, fileSize: true, createdAt: true },
      },
      entitlements: {
        orderBy: { grantedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          grantedAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });
  if (!note) notFound();

  const [catalog, viewStats, recentReaders] = await Promise.all([
    loadCatalogTree(),
    prisma.noteView.aggregate({
      where: { noteId: id },
      _count: { _all: true },
      _avg: { durationMs: true },
      _max: { maxPage: true },
    }),
    prisma.noteView.findMany({
      where: { noteId: id },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        startedAt: true,
        durationMs: true,
        maxPage: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  return (
    <PageContainer className="max-w-6xl">
      <Link
        href="/admin/notes"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> All notes
      </Link>

      <PageHeader
        title={note.title}
        description={
          <>
            {note.subject.name}
            {note.unit ? ` · ${note.unit.name}` : ''}
            {note.topic ? ` · ${note.topic.name}` : ''} · {formatBytes(note.fileSize)} · v
            {note.version} · uploaded {formatDateTime(note.createdAt)}
            {note.uploadedBy ? ` by ${note.uploadedBy.email}` : ''}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/notes/${note.id}`} target="_blank">
                <Eye className="size-4" /> Preview
              </Link>
            </Button>
            <ActionButton
              variant="destructive"
              size="sm"
              action={deleteNoteAction.bind(null, note.id)}
              confirm={{
                title: 'Delete this note?',
                description:
                  'The file and every version of it are removed from storage, along with all grants pointing at it. This cannot be undone.',
                confirmLabel: 'Delete permanently',
                destructive: true,
              }}
            >
              Delete
            </ActionButton>
          </>
        }
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <NoteEditForm
                noteId={note.id}
                catalog={catalog}
                currencySymbol={env.catalog.currencySymbol}
                initial={{
                  title: note.title,
                  description: note.description ?? '',
                  subjectId: note.subjectId,
                  unitId: note.unitId ?? '',
                  status: note.status,
                  visibility: note.visibility,
                  price: note.priceMinor / 100,
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Replace the file</CardTitle>
              <CardDescription>
                Uploads a new version. Students see the new file immediately; the old one is kept in
                version history.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <NoteReplaceForm noteId={note.id} maxMb={env.uploads.maxMb} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Who has access</CardTitle>
              <CardDescription>
                Direct grants for this note. Students may also reach it through a subject, unit or
                semester grant.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {note.entitlements.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No direct grants.{' '}
                  <Link href="/admin/users" className="underline underline-offset-4">
                    Grant it from a user’s page
                  </Link>
                </p>
              ) : (
                note.entitlements.map((entitlement) => (
                  <div
                    key={entitlement.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <Link
                      href={`/admin/users/${entitlement.user.id}`}
                      className="min-w-0 text-sm hover:text-primary"
                    >
                      <span className="block font-medium">{entitlement.user.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {entitlement.user.email} · {relativeTime(entitlement.grantedAt)}
                      </span>
                    </Link>
                    <ActionButton
                      variant="ghost"
                      size="sm"
                      action={revokeAccessAction.bind(null, entitlement.id)}
                    >
                      Revoke
                    </ActionButton>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Usage</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Opens" value={note.viewCount} />
              <Row label="Reading sessions" value={viewStats._count._all} />
              <Row
                label="Average read"
                value={formatDuration(Math.round(viewStats._avg.durationMs ?? 0))}
              />
              <Row label="Deepest page reached" value={viewStats._max.maxPage ?? '—'} />
              <Row label="Last opened" value={relativeTime(note.lastViewedAt)} />
              <Row
                label="Storage key"
                value={
                  <span className="font-mono text-xs">{truncateMiddle(note.storageKey, 26)}</span>
                }
              />
              <Row label="Checksum" value={
                note.checksum ? (
                  <span className="font-mono text-xs">{note.checksum.slice(0, 12)}…</span>
                ) : (
                  '—'
                )
              } />
              <Row label="Pages" value={note.pageCount ?? 'unknown'} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Recent readers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {recentReaders.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody has opened this yet.</p>
              ) : (
                recentReaders.map((view) => (
                  <Link
                    key={view.id}
                    href={`/admin/users/${view.user.id}`}
                    className="-mx-2 block rounded-md px-2 py-1.5 hover:bg-secondary/60"
                  >
                    <p className="truncate text-sm font-medium">{view.user.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {relativeTime(view.startedAt)} · {formatDuration(view.durationMs)} · page{' '}
                      {view.maxPage}
                    </p>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Version history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {note.versions.map((version) => (
                <div key={version.id} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate">{version.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(version.fileSize)} · {formatDateTime(version.createdAt)}
                    </p>
                  </div>
                  <Badge variant={version.version === note.version ? 'success' : 'outline'}>
                    v{version.version}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  );
}
