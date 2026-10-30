'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Alert } from '@/components/ui/feedback';
import { ActionForm, Field } from '@/components/admin/action-form';
import { BundleCard } from '@/components/commerce/bundle-card';
import { saveBundleAction } from '@/app/admin/_actions/commerce';
import { bundleSavings, formatInr, minorToInputValue, parsePriceInput } from '@/lib/commerce/money';
import { cn } from '@/lib/utils';

export interface EditorNote {
  id: string;
  title: string;
  subjectId: string;
  subjectName: string;
  priceMinor: number;
  isPaid: boolean;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}

export interface EditorSubject {
  id: string;
  name: string;
  semesterName: string;
  cover: string | null;
}

interface Props {
  bundle: {
    id: string;
    title: string;
    description: string;
    priceMinor: number;
    isActive: boolean;
    isFeatured: boolean;
    position: number;
    coverSubjectId: string | null;
    noteIds: string[];
    subjectIds: string[];
  };
  notes: EditorNote[];
  subjects: EditorSubject[];
}

/**
 * Compose a bundle: what it is called, what it costs, which notes are in it, and which subject
 * pages promote it. The preview on the right is the very component a student sees, fed by what
 * is currently typed — so what is checked here is what ships.
 *
 * The form saves nothing until "Save". A bundle can be kept as a draft while it is half-built;
 * switching it on is what makes it public, and the server refuses to switch on one that a
 * student could not actually buy.
 */
export function BundleEditor({ bundle, notes, subjects }: Props) {
  const [title, setTitle] = useState(bundle.title);
  const [description, setDescription] = useState(bundle.description);
  const [price, setPrice] = useState(minorToInputValue(bundle.priceMinor));
  const [active, setActive] = useState(bundle.isActive);
  const [featured, setFeatured] = useState(bundle.isFeatured);
  const [noteIds, setNoteIds] = useState(() => new Set(bundle.noteIds));
  const [subjectIds, setSubjectIds] = useState(() => new Set(bundle.subjectIds));
  const [coverSubjectId, setCoverSubjectId] = useState(bundle.coverSubjectId ?? '');
  const [query, setQuery] = useState('');

  const parsedPrice = parsePriceInput(price);
  const priceMinor = parsedPrice.ok ? parsedPrice.minor : bundle.priceMinor;

  const selected = useMemo(() => notes.filter((note) => noteIds.has(note.id)), [notes, noteIds]);
  const savings = bundleSavings(priceMinor, selected);
  const combined = selected.filter((note) => note.isPaid).reduce((total, note) => total + note.priceMinor, 0);

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, { name: string; notes: EditorNote[] }>();
    for (const note of notes) {
      if (needle && !`${note.title} ${note.subjectName}`.toLowerCase().includes(needle) && !noteIds.has(note.id)) continue;
      const group = groups.get(note.subjectId) ?? { name: note.subjectName, notes: [] };
      group.notes.push(note);
      groups.set(note.subjectId, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [notes, query, noteIds]);

  const coverFromSubject = subjects.find((subject) => subject.id === (coverSubjectId || [...subjectIds][0]))?.cover ?? null;

  const problems: string[] = [];
  if (selected.length < 2) problems.push('Add at least two notes.');
  if (selected.some((note) => note.status !== 'PUBLISHED')) problems.push('Every note in it must be published.');
  if (subjectIds.size === 0) problems.push('Choose at least one subject page to promote it on.');
  if (!parsedPrice.ok) problems.push(parsedPrice.error);

  function toggle(set: Set<string>, setter: (next: Set<string>) => void, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px] [&>*]:min-w-0">
      <ActionForm action={saveBundleAction.bind(null, bundle.id)} submitLabel="Save bundle">
        <Field label="Title" htmlFor="title">
          <Input id="title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
        </Field>

        <Field label="Description" htmlFor="description" hint="What a student gets, in a sentence or two.">
          <Textarea id="description" name="description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Bundle price (₹)"
            htmlFor="price"
            hint={
              parsedPrice.ok
                ? combined > 0
                  ? `The notes cost ${formatInr(combined)} separately.`
                  : 'Set independently of the notes’ own prices.'
                : parsedPrice.error
            }
          >
            <Input id="price" name="price" inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </Field>
          <Field label="Display order" htmlFor="position" hint="Lower numbers come first. Featured bundles lead.">
            <Input id="position" name="position" type="number" min={0} max={9999} defaultValue={bundle.position} />
          </Field>
        </div>

        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">Active bundles appear on their subject pages and can be bought.</p>
            </div>
            <Switch checked={active} onCheckedChange={setActive} aria-label="Active" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Featured</p>
              <p className="text-xs text-muted-foreground">Shown before other bundles on the same page.</p>
            </div>
            <Switch checked={featured} onCheckedChange={setFeatured} aria-label="Featured" />
          </div>
          <input type="hidden" name="isActive" value={active ? 'on' : ''} />
          <input type="hidden" name="isFeatured" value={featured ? 'on' : ''} />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            Notes in this bundle <span className="font-normal text-muted-foreground">({noteIds.size} selected)</span>
          </legend>
          <p className="text-xs text-muted-foreground">Only notes that are for sale can be bundled.</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              placeholder="Find a note…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
              aria-label="Find a note"
            />
          </div>
          <div className="max-h-80 space-y-3 overflow-y-auto rounded-md border border-border p-2">
            {notes.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                No notes are for sale yet. Set a price on a note first (open it from Notes → “Access and price”).
              </p>
            ) : grouped.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No notes match.</p>
            ) : (
              grouped.map((group) => (
                <div key={group.name}>
                  <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{group.name}</p>
                  {group.notes.map((note) => (
                    <label
                      key={note.id}
                      className={cn('flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-secondary/60', noteIds.has(note.id) && 'bg-primary/5')}
                    >
                      <input
                        type="checkbox"
                        name="noteIds"
                        value={note.id}
                        checked={noteIds.has(note.id)}
                        onChange={() => toggle(noteIds, setNoteIds, note.id)}
                        className="size-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate">{note.title}</span>
                      {note.status !== 'PUBLISHED' && <Badge variant="warning">{note.status.toLowerCase()}</Badge>}
                      {!note.isPaid && <Badge variant="outline">not for sale</Badge>}
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{note.isPaid ? formatInr(note.priceMinor) : ''}</span>
                    </label>
                  ))}
                </div>
              ))
            )}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Promote on these subject pages</legend>
          <div className="grid gap-1 rounded-md border border-border p-2 sm:grid-cols-2">
            {subjects.map((subject) => (
              <label key={subject.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-secondary/60">
                <input
                  type="checkbox"
                  name="subjectIds"
                  value={subject.id}
                  checked={subjectIds.has(subject.id)}
                  onChange={() => toggle(subjectIds, setSubjectIds, subject.id)}
                  className="size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0 truncate">
                  {subject.name} <span className="text-xs text-muted-foreground">· {subject.semesterName}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Cover" htmlFor="coverSubjectId" hint="Uses an existing notebook cover. By default, the first promoted subject’s.">
          <Select id="coverSubjectId" name="coverSubjectId" value={coverSubjectId} onChange={(e) => setCoverSubjectId(e.target.value)}>
            <option value="">First promoted subject’s cover</option>
            {subjects.filter((subject) => subject.cover).map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </Select>
        </Field>
      </ActionForm>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div>
          <h2 className="text-sm font-medium">Preview</h2>
          <p className="text-xs text-muted-foreground">Exactly what a student sees on the subject page.</p>
        </div>

        <BundleCard
          id={bundle.id}
          title={title || 'Untitled bundle'}
          description={description || null}
          priceMinor={priceMinor}
          featured={featured}
          cover={coverFromSubject}
          notes={selected.map((note) => ({ id: note.id, title: note.title, priceMinor: note.priceMinor, isPaid: note.isPaid, owned: false }))}
          savings={savings}
          signedIn
          returnTo="/"
          preview
        />

        <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={active && problems.length === 0 ? 'success' : active ? 'warning' : 'outline'}>
              {active ? (problems.length === 0 ? 'Will be live' : 'Cannot go live yet') : 'Draft'}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Savings shown</span>
            <span>{savings ? `${formatInr(savings.savingsMinor)} (${savings.percent}%)` : 'None'}</span>
          </div>
          {!savings && selected.length >= 2 && parsedPrice.ok && (
            <p className="text-xs text-muted-foreground">
              No saving is displayed because this bundle is not cheaper than buying the notes separately. Nothing is invented.
            </p>
          )}
        </div>

        {problems.length > 0 && (
          <Alert variant={active ? 'warning' : 'info'} title={active ? 'Fix these before it can go live' : 'Before you switch it on'}>
            <ul className="list-disc space-y-0.5 pl-4">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
      </aside>
    </div>
  );
}
