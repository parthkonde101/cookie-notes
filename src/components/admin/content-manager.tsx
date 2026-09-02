'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  FilePlus2,
  FileText,
  FolderPlus,
  Layers,
  Plus,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ActionButton } from '@/components/admin/action-button';
import { ActionForm, Field } from '@/components/admin/action-form';
import { NoteUploadForm } from '@/components/admin/note-upload-form';
import {
  createSemesterAction,
  createSubjectAction,
  createTopicAction,
  createUnitAction,
  deleteSemesterAction,
  deleteSubjectAction,
  deleteUnitAction,
} from '@/app/admin/_actions/catalog';
import type { CatalogSemester, PlacementOption } from '@/lib/admin/catalog';
import { cn, formatBytes, pluralize } from '@/lib/utils';

type DialogState =
  | { kind: 'none' }
  | { kind: 'semester' }
  | { kind: 'subject'; semesterId?: string }
  | { kind: 'unit'; subjectId: string; subjectLabel: string }
  | { kind: 'topic'; unitId: string; unitLabel: string }
  | { kind: 'upload'; subjectId?: string; unitId?: string };

/**
 * The whole content-management surface in one screen.
 *
 * Semester → subject → unit → topic → note is a tree, so it is presented as one:
 * every level can be expanded, added to, and uploaded into without leaving the
 * page. Individual notes still have a detail page for editing and file
 * replacement.
 */
export function ContentManager({
  catalog,
  placements,
  maxUploadMb,
  currencySymbol,
}: {
  catalog: CatalogSemester[];
  placements: PlacementOption[];
  maxUploadMb: number;
  currencySymbol: string;
}) {
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  // Track what is *collapsed* rather than what is expanded, so a semester created
  // after mount shows its contents immediately instead of arriving folded shut.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');

  const close = () => setDialog({ kind: 'none' });

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog;

    const matches = (value: string) => value.toLowerCase().includes(needle);

    return catalog
      .map((semester) => ({
        ...semester,
        subjects: semester.subjects
          .map((subject) => ({
            ...subject,
            units: subject.units
              .map((unit) => ({
                ...unit,
                notes: unit.notes.filter(
                  (note) => matches(note.title) || matches(unit.name) || matches(subject.name),
                ),
              }))
              .filter((unit) => unit.notes.length > 0 || matches(unit.name)),
            looseNotes: subject.looseNotes.filter((note) => matches(note.title)),
          }))
          .filter(
            (subject) =>
              matches(subject.name) ||
              subject.units.length > 0 ||
              subject.looseNotes.length > 0,
          ),
      }))
      .filter((semester) => matches(semester.name) || semester.subjects.length > 0);
  }, [catalog, query]);

  // ---- Empty state --------------------------------------------------------
  if (catalog.length === 0) {
    return (
      <>
        <EmptyState
          className="mt-8 py-16"
          icon={Layers}
          title="No academic content yet"
          description="Build your college's structure here: start with a semester, then add subjects, units and topics, and upload notes into them."
          action={
            <Button onClick={() => setDialog({ kind: 'semester' })}>
              <Plus className="size-4" />
              Create semester
            </Button>
          }
        />
        {renderDialog()}
      </>
    );
  }

  // ---- Tree ---------------------------------------------------------------
  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by note, unit or subject"
          className="min-w-[200px] max-w-sm flex-1"
          aria-label="Filter content"
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'semester' })}>
            <Plus className="size-4" />
            Semester
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'subject' })}>
            <FolderPlus className="size-4" />
            Subject
          </Button>
          <Button size="sm" onClick={() => setDialog({ kind: 'upload' })}>
            <FilePlus2 className="size-4" />
            Upload note
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState className="mt-6" icon={FileText} title={`Nothing matches “${query}”`} />
      ) : (
        <div className="mt-5 space-y-3">
          {filtered.map((semester) => {
            const open = !collapsed.has(semester.id);

            return (
              <section key={semester.id} className="overflow-hidden rounded-lg border border-border">
                <div className="flex flex-wrap items-center gap-2 bg-card/60 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(semester.id)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        'size-4 shrink-0 text-muted-foreground transition-transform',
                        open && 'rotate-90',
                      )}
                    />
                    <span className="truncate font-medium">{semester.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {pluralize(semester.subjects.length, 'subject')} ·{' '}
                      {pluralize(semester.noteCount, 'note')}
                    </span>
                    {semester.isArchived && <Badge variant="outline">archived</Badge>}
                  </button>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDialog({ kind: 'subject', semesterId: semester.id })}
                    >
                      <Plus className="size-3.5" />
                      Subject
                    </Button>
                    {semester.subjects.length === 0 && (
                      <ActionButton
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${semester.name}`}
                        action={deleteSemesterAction.bind(null, semester.id)}
                        confirm={{
                          title: `Delete ${semester.name}?`,
                          description: 'It has no subjects, so nothing else is affected.',
                          confirmLabel: 'Delete',
                          destructive: true,
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </ActionButton>
                    )}
                  </div>
                </div>

                {open && (
                  <div className="space-y-3 border-t border-border p-3">
                    {semester.subjects.length === 0 ? (
                      <p className="px-1 py-3 text-sm text-muted-foreground">
                        No subjects yet.{' '}
                        <button
                          type="button"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                          onClick={() => setDialog({ kind: 'subject', semesterId: semester.id })}
                        >
                          Add the first one
                        </button>
                        .
                      </p>
                    ) : (
                      semester.subjects.map((subject) => (
                        <div key={subject.id} className="rounded-md border border-border bg-card p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="truncate font-medium">{subject.name}</span>
                              {subject.code && <Badge variant="outline">{subject.code}</Badge>}
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {pluralize(subject.noteCount, 'note')}
                              </span>
                            </div>

                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setDialog({
                                    kind: 'unit',
                                    subjectId: subject.id,
                                    subjectLabel: subject.name,
                                  })
                                }
                              >
                                <Plus className="size-3.5" />
                                Unit
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDialog({ kind: 'upload', subjectId: subject.id })}
                              >
                                <FilePlus2 className="size-3.5" />
                                Note
                              </Button>
                              {subject.noteCount === 0 && subject.units.length === 0 && (
                                <ActionButton
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Delete ${subject.name}`}
                                  action={deleteSubjectAction.bind(null, subject.id)}
                                  confirm={{
                                    title: `Delete ${subject.name}?`,
                                    description: 'It has no units or notes.',
                                    confirmLabel: 'Delete',
                                    destructive: true,
                                  }}
                                >
                                  <Trash2 className="size-3.5" />
                                </ActionButton>
                              )}
                            </div>
                          </div>

                          {subject.looseNotes.length > 0 && (
                            <div className="mt-3 space-y-1">
                              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                                Unfiled
                              </p>
                              {subject.looseNotes.map((note) => (
                                <NoteRow
                                  key={note.id}
                                  note={note}
                                  currencySymbol={currencySymbol}
                                />
                              ))}
                            </div>
                          )}

                          <div className="mt-3 space-y-2">
                            {subject.units.length === 0 && subject.looseNotes.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                No units yet — add one, or upload a note directly to the subject.
                              </p>
                            ) : (
                              subject.units.map((unit) => (
                                <div
                                  key={unit.id}
                                  className="rounded border border-border/70 bg-muted/25 p-2.5"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-sm font-medium">{unit.name}</p>
                                      <p className="text-xs text-muted-foreground">
                                        {pluralize(unit.notes.length, 'note')}
                                        {unit.topics.length > 0 &&
                                          ` · ${unit.topics.map((topic) => topic.name).join(', ')}`}
                                      </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          setDialog({
                                            kind: 'topic',
                                            unitId: unit.id,
                                            unitLabel: `${subject.name} · ${unit.name}`,
                                          })
                                        }
                                      >
                                        <Plus className="size-3.5" />
                                        Topic
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          setDialog({
                                            kind: 'upload',
                                            subjectId: subject.id,
                                            unitId: unit.id,
                                          })
                                        }
                                      >
                                        <FilePlus2 className="size-3.5" />
                                        Note
                                      </Button>
                                      {unit.notes.length === 0 && (
                                        <ActionButton
                                          variant="ghost"
                                          size="icon-sm"
                                          aria-label={`Delete ${unit.name}`}
                                          action={deleteUnitAction.bind(null, unit.id)}
                                        >
                                          <Trash2 className="size-3.5" />
                                        </ActionButton>
                                      )}
                                    </div>
                                  </div>

                                  {unit.notes.length > 0 && (
                                    <div className="mt-2 space-y-1">
                                      {unit.notes.map((note) => (
                                        <NoteRow
                                          key={note.id}
                                          note={note}
                                          currencySymbol={currencySymbol}
                                        />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {renderDialog()}
    </>
  );

  function renderDialog() {
    return (
      <Dialog open={dialog.kind !== 'none'} onOpenChange={(open) => !open && close()}>
        <DialogContent className={dialog.kind === 'upload' ? 'max-w-2xl' : 'max-w-md'}>
          {dialog.kind === 'semester' && (
            <>
              <DialogHeader>
                <DialogTitle>New semester</DialogTitle>
                <DialogDescription>The top level of your academic structure.</DialogDescription>
              </DialogHeader>
              <ActionForm
                action={createSemesterAction}
                submitLabel="Create semester"
                onSuccess={close}
              >
                <Field label="Name" htmlFor="semester-name">
                  <Input id="semester-name" name="name" placeholder="Semester 6" required autoFocus />
                </Field>
                <Field label="Description" htmlFor="semester-description">
                  <Textarea id="semester-description" name="description" rows={2} />
                </Field>
                <Field label="Sort position" htmlFor="semester-position" hint="Lower numbers appear first.">
                  <Input id="semester-position" name="position" type="number" min={0} defaultValue={catalog.length} />
                </Field>
              </ActionForm>
            </>
          )}

          {dialog.kind === 'subject' && (
            <>
              <DialogHeader>
                <DialogTitle>New subject</DialogTitle>
                <DialogDescription>Subjects hold the units and notes.</DialogDescription>
              </DialogHeader>
              <ActionForm action={createSubjectAction} submitLabel="Create subject" onSuccess={close}>
                <Field label="Semester" htmlFor="subject-semester">
                  <Select
                    id="subject-semester"
                    name="semesterId"
                    required
                    defaultValue={dialog.semesterId ?? catalog[0]?.id}
                  >
                    {catalog.map((semester) => (
                      <option key={semester.id} value={semester.id}>
                        {semester.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Name" htmlFor="subject-name">
                  <Input id="subject-name" name="name" placeholder="Machine Learning" required autoFocus />
                </Field>
                <Field label="Code" htmlFor="subject-code">
                  <Input id="subject-code" name="code" placeholder="CS601" />
                </Field>
                <Field label="Description" htmlFor="subject-description">
                  <Textarea id="subject-description" name="description" rows={2} />
                </Field>
              </ActionForm>
            </>
          )}

          {dialog.kind === 'unit' && (
            <>
              <DialogHeader>
                <DialogTitle>New unit</DialogTitle>
                <DialogDescription>Adding to {dialog.subjectLabel}.</DialogDescription>
              </DialogHeader>
              <ActionForm action={createUnitAction} submitLabel="Create unit" onSuccess={close}>
                <input type="hidden" name="subjectId" value={dialog.subjectId} />
                <Field label="Name" htmlFor="unit-name">
                  <Input id="unit-name" name="name" placeholder="Unit 1 — Introduction" required autoFocus />
                </Field>
                <Field label="Description" htmlFor="unit-description">
                  <Textarea id="unit-description" name="description" rows={2} />
                </Field>
              </ActionForm>
            </>
          )}

          {dialog.kind === 'topic' && (
            <>
              <DialogHeader>
                <DialogTitle>New topic</DialogTitle>
                <DialogDescription>Adding to {dialog.unitLabel}.</DialogDescription>
              </DialogHeader>
              <ActionForm action={createTopicAction} submitLabel="Create topic" onSuccess={close}>
                <input type="hidden" name="unitId" value={dialog.unitId} />
                <Field label="Name" htmlFor="topic-name">
                  <Input id="topic-name" name="name" placeholder="Decision Trees" required autoFocus />
                </Field>
              </ActionForm>
            </>
          )}

          {dialog.kind === 'upload' && (
            <>
              <DialogHeader>
                <DialogTitle>Upload a note</DialogTitle>
                <DialogDescription>
                  The PDF goes into private storage. Students only ever reach it through the
                  in-app reader.
                </DialogDescription>
              </DialogHeader>
              <NoteUploadForm
                placements={placements}
                maxMb={maxUploadMb}
                currencySymbol={currencySymbol}
                defaultSubjectId={dialog.subjectId}
                defaultUnitId={dialog.unitId}
                onUploaded={close}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    );
  }
}

function NoteRow({
  note,
  currencySymbol,
}: {
  note: CatalogSemester['subjects'][number]['looseNotes'][number];
  currencySymbol: string;
}) {
  return (
    <Link
      href={`/admin/notes/${note.id}`}
      className="flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-secondary"
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{note.title}</span>

      {note.topicName && (
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {note.topicName}
        </span>
      )}
      {note.priceMinor > 0 && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {currencySymbol}
          {note.priceMinor / 100}
        </span>
      )}
      <Badge
        variant={
          note.status === 'PUBLISHED' ? 'success' : note.status === 'DRAFT' ? 'warning' : 'outline'
        }
      >
        {note.status.toLowerCase()}
      </Badge>
      {note.visibility === 'FREE' && <Badge variant="secondary">free</Badge>}
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:inline">
        {note.viewCount} views · {formatBytes(note.fileSize)}
      </span>
    </Link>
  );
}
