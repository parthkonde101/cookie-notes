'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Bell,
  Check,
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { SubjectExtras } from '@/components/admin/subject-extras';
import { ProgramSelector } from '@/components/catalog/program-selector';
import {
  ADMIN_PROGRAM_COOKIE,
  programLabel,
  stripProgramPrefix,
  type Program,
} from '@/lib/program';
import {
  createSemesterAction,
  createSubjectAction,
  createUnitAction,
  deleteSemesterAction,
  deleteSubjectAction,
  deleteUnitAction,
  setUnitBakingAction,
} from '@/app/admin/_actions/catalog';
import type { CatalogSemester, CatalogUnit, PlacementOption } from '@/lib/admin/catalog';
import { cn, formatBytes, pluralize } from '@/lib/utils';

/** The region the program switch swaps, for its `aria-controls`. */
const TREE_ID = 'admin-catalogue-tree';

type DialogState =
  | { kind: 'none' }
  | { kind: 'semester' }
  | { kind: 'subject'; semesterId?: string }
  | { kind: 'unit'; subjectId: string; subjectLabel: string }
  | { kind: 'upload'; subjectId?: string; unitId?: string };

/**
 * The whole content-management surface in one screen.
 *
 * The structure is semester → subject → unit → PDF, plus each subject's past
 * papers, and the screen says exactly that. Every level can be expanded, added
 * to and uploaded into without leaving the page, and each unit row shows at a
 * glance whether its PDF is there yet, so a half-filled subject is obvious
 * rather than something to go looking for.
 *
 * A unit holds one PDF, so uploading into a unit that already has one replaces
 * it. Individual notes still have a detail page for status, pricing, access and
 * version history.
 *
 * ## Scoped to one program
 *
 * Everything on this screen belongs to `program`: the tree was loaded for it,
 * the placements were flattened from that tree, and anything created here is
 * created inside it. The selector at the top switches — an RSC navigation that
 * reloads the tree, not a client-side filter — so there is never a moment where
 * a B.Tech unit is listed while the header says Polytechnic.
 *
 * The program is stated in the dialogs as well as the header. An admin who
 * switched programs, then opened "Upload PDF" from muscle memory, should be
 * told which catalogue they are filing into before they pick a file, not after.
 */
export function ContentManager({
  catalog,
  placements,
  program,
  maxUploadMb,
  currencySymbol,
}: {
  catalog: CatalogSemester[];
  placements: PlacementOption[];
  /** The program this whole screen is managing. */
  program: Program;
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
            // A unit matches on its own name, its subject, or the file sitting
            // in it — never filtered down to "units that have a PDF", since a
            // missing upload is exactly what an admin searches for.
            units: subject.units.filter(
              (unit) =>
                matches(unit.name) ||
                matches(subject.name) ||
                (unit.note !== null && matches(unit.note.fileName)),
            ),
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

  const label = programLabel(program);

  /*
   * The program switch, rendered above everything including the empty state —
   * an admin whose Polytechnic catalogue is empty still needs the way back to
   * B.Tech, and an empty screen with no switch on it reads as a broken page.
   *
   * Centred, because it is the one control that changes what the whole screen
   * means. Everything below it stays left-aligned: this is a management
   * surface, and a centred tree would be harder to scan, not prettier.
   */
  const selector = (
    <div className="mt-6 flex flex-col items-center gap-2 border-b border-border pb-6">
      <ProgramSelector
        active={program}
        controls={TREE_ID}
        cookieName={ADMIN_PROGRAM_COOKIE}
        label="Programme being managed"
      />
      <p className="text-xs text-muted-foreground">
        Managing the <span className="font-medium text-foreground">{label}</span> catalogue
      </p>
    </div>
  );

  // ---- Empty state --------------------------------------------------------
  if (catalog.length === 0) {
    return (
      <>
        {selector}
        <EmptyState
          className="mt-6 py-16"
          icon={Layers}
          title={`No ${label} content yet`}
          description={`Build the ${label} structure here: start with a semester, then add subjects and their units, and upload one PDF into each unit. The other programme's catalogue is managed separately.`}
          action={
            <Button onClick={() => setDialog({ kind: 'semester' })}>
              <Plus className="size-4" />
              Create {label} semester
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
      {selector}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Filter ${label} units, subjects or files`}
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
            Upload PDF
          </Button>
        </div>
      </div>

      {/* Says the shape of the thing being managed, so the two independent
          structures on this screen are not mistaken for one. */}
      <p className="mt-3 text-xs text-muted-foreground">
        Subject → units, one PDF per unit. Past papers hang off the subject itself, one per year.
      </p>

      {/*
       * `key={program}` makes switching read as a transition: the old tree is
       * unmounted and the new one fades in, rather than rows silently changing
       * underneath the cursor. It also resets the collapse state, which is
       * correct — a semester id from the other catalogue means nothing here.
       */}
      <div
        key={program}
        id={TREE_ID}
        role="tabpanel"
        aria-label={`${label} catalogue`}
        className="animate-fade-in motion-reduce:animate-none"
      >
        {filtered.length === 0 ? (
          <EmptyState className="mt-6" icon={FileText} title={`Nothing matches “${query}”`} />
        ) : (
          <div className="mt-5 space-y-3">
            {filtered.map((semester) => {
              const open = !collapsed.has(semester.id);
              // Coverage, not a note total: what an admin wants at a glance is how
              // much of the semester is still missing its PDFs.
              const units = semester.subjects.reduce(
                (sum, subject) => sum + subject.units.length,
                0,
              );
              const missing = semester.subjects.reduce(
                (sum, subject) => sum + subject.missingCount,
                0,
              );

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
                      {/* The selector above says the programme; the row need
                          not repeat it. Display only — the stored name, and
                          the one the delete confirmation quotes, are the real
                          thing. */}
                      <span className="truncate font-medium">
                        {stripProgramPrefix(semester.name, semester.program)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {pluralize(semester.subjects.length, 'subject')} ·{' '}
                        {units - missing}/{units} units uploaded
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
                                  {subject.units.length === 0
                                    ? 'no units'
                                    : `${subject.units.length - subject.missingCount}/${subject.units.length} units uploaded`}
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
                                  disabled={subject.units.length === 0}
                                  onClick={() => setDialog({ kind: 'upload', subjectId: subject.id })}
                                >
                                  <FilePlus2 className="size-3.5" />
                                  PDF
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

                            <SubjectExtras
                              subjectId={subject.id}
                              subjectName={subject.name}
                              cover={subject.cover}
                              pyqs={subject.pyqs}
                              maxUploadMb={maxUploadMb}
                            />

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
                              {subject.units.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                  No units yet — add one, then upload its PDF.
                                </p>
                              ) : (
                                subject.units.map((unit) => (
                                  <UnitRow
                                    key={unit.id}
                                    unit={unit}
                                    currencySymbol={currencySymbol}
                                    onUpload={() =>
                                      setDialog({
                                        kind: 'upload',
                                        subjectId: subject.id,
                                        unitId: unit.id,
                                      })
                                    }
                                  />
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
      </div>

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
                <DialogTitle>New {label} semester</DialogTitle>
                <DialogDescription>
                  The top level of the {label} structure. It will not appear in the other
                  programme&rsquo;s catalogue.
                </DialogDescription>
              </DialogHeader>
              <ActionForm
                action={createSemesterAction}
                submitLabel={`Create ${label} semester`}
                onSuccess={close}
              >
                {/*
                 * The program the screen is managing, submitted with the form.
                 * The action validates it rather than trusting it — this field
                 * decides which catalogue a *new* semester joins, and a new
                 * semester has no parent to derive it from.
                 */}
                <input type="hidden" name="program" value={program} />
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
                <DialogTitle>New {label} subject</DialogTitle>
                <DialogDescription>
                  Subjects hold the units and notes. Only {label} semesters are offered below —
                  a subject takes its programme from the semester it is filed under.
                </DialogDescription>
              </DialogHeader>
              <ActionForm
                action={createSubjectAction}
                submitLabel={`Create ${label} subject`}
                onSuccess={close}
              >
                {/* Compared against the chosen semester's program server-side. */}
                <input type="hidden" name="program" value={program} />
                <Field label="Semester" htmlFor="subject-semester">
                  <Select
                    id="subject-semester"
                    name="semesterId"
                    required
                    defaultValue={dialog.semesterId ?? catalog[0]?.id}
                  >
                    {catalog.map((semester) => (
                      <option key={semester.id} value={semester.id}>
                        {stripProgramPrefix(semester.name, semester.program)}
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

          {dialog.kind === 'upload' && (
            <>
              <DialogHeader>
                <DialogTitle>Upload a {label} PDF</DialogTitle>
                <DialogDescription>
                  Pick the unit it belongs to — only {label} units are listed. The PDF goes into
                  private storage; students only ever reach it through the in-app reader.
                </DialogDescription>
              </DialogHeader>
              <NoteUploadForm
                placements={placements}
                program={program}
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

/**
 * One unit, and the state of its PDF.
 *
 * The row answers the only two questions worth asking at this level — which unit
 * is this, and is its PDF here — and gives the one action that follows from the
 * answer. A unit with a file shows which file, so an admin can tell at a glance
 * that "Unit 4" is holding the file they meant to upload; a unit without one is
 * plainly marked rather than simply absent.
 */
function UnitRow({
  unit,
  currencySymbol,
  onUpload,
}: {
  unit: CatalogUnit;
  currencySymbol: string;
  onUpload: () => void;
}) {
  const note = unit.note;

  return (
    <div className="rounded border border-border/70 bg-muted/25 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold',
            note ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {unit.index}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            <span className="sr-only">Unit {unit.index}: </span>
            {unit.name}
          </p>
          {note ? (
            <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Check aria-hidden className="size-3 shrink-0 text-primary" />
              <span className="truncate">{note.fileName}</span>
              <span className="shrink-0 tabular-nums">· {formatBytes(note.fileSize)}</span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Not uploaded</p>
          )}
        </div>

        {note && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {note.priceMinor > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {currencySymbol}
                {note.priceMinor / 100}
              </span>
            )}
            <Badge
              variant={
                note.status === 'PUBLISHED'
                  ? 'success'
                  : note.status === 'DRAFT'
                    ? 'warning'
                    : 'outline'
              }
            >
              {note.status.toLowerCase()}
            </Badge>
            {note.visibility === 'FREE' && <Badge variant="secondary">free</Badge>}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onUpload}>
            <FilePlus2 className="size-3.5" />
            {note ? 'Replace' : 'Upload'}
          </Button>
          {note ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/admin/notes/${note.id}`}>Manage</Link>
            </Button>
          ) : (
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

      {/* Status controls, only while the unit is still waiting for its PDF.
          Once the file is up there is nothing to promise and nobody left to
          notify, so the row goes back to just the file. */}
      {!note && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-2">
          <BakingToggle unit={unit} />
          <SubscriberCount count={unit.subscriberCount} unitName={unit.name} />
        </div>
      )}
    </div>
  );
}

/**
 * The per-unit "Being Baked" switch.
 *
 * Optimistic: the switch moves immediately and rolls back if the server refuses,
 * because a status toggle that waits on a round trip feels broken. The server is
 * still the authority — it rejects enabling on a unit that already has a PDF.
 */
function BakingToggle({ unit }: { unit: CatalogUnit }) {
  const router = useRouter();
  const [checked, setChecked] = useState(unit.beingBaked);
  const [pending, startTransition] = useTransition();

  // A refresh elsewhere (or another admin) is the source of truth.
  useEffect(() => setChecked(unit.beingBaked), [unit.beingBaked]);

  function onChange(next: boolean) {
    const previous = checked;
    setChecked(next);
    startTransition(async () => {
      const result = await setUnitBakingAction(unit.id, next);
      if (!result.ok) {
        setChecked(previous);
        toast.error(result.error);
        return;
      }
      if (result.message) toast.success(result.message);
      router.refresh();
    });
  }

  const id = `baking-${unit.id}`;
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
        aria-label={`Being Baked — ${unit.name}`}
      />
      <Label htmlFor={id} className="cursor-pointer text-xs font-medium text-muted-foreground">
        Being Baked
      </Label>
    </div>
  );
}

/**
 * How many students are waiting on this unit.
 *
 * Informational only — it sends nothing. The count is deliberately the whole
 * story: no names, no email addresses, nothing that would turn the catalogue
 * screen into a place where one student's interest is visible to anyone.
 */
function SubscriberCount({ count, unitName }: { count: number; unitName: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={
          count === 0
            ? `No students are waiting for ${unitName}`
            : `${count} ${count === 1 ? 'student is' : 'students are'} waiting for ${unitName}`
        }
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          count > 0
            ? 'text-foreground hover:bg-secondary'
            : 'cursor-default text-muted-foreground/70',
        )}
        disabled={count === 0}
      >
        <Bell aria-hidden className="size-3.5" />
        Notify
        {count > 0 && <span className="tabular-nums">· {count}</span>}
      </button>

      {open && count > 0 && (
        <span
          role="status"
          className="absolute left-0 top-full z-20 mt-1 w-max max-w-[min(16rem,70vw)] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
        >
          {count} {count === 1 ? 'student' : 'students'} will be notified when this unit is
          published.
        </span>
      )}
    </div>
  );
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
