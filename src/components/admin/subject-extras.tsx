'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { FileUp, ImageUp, Loader2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/feedback';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/admin/action-form';
import { describeStorageFailure } from '@/components/admin/note-upload-form';
import { formatBytes } from '@/lib/utils';
import type { CatalogPyq } from '@/lib/admin/catalog';

const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const COVER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The two things a subject owns that are not notes: its notebook cover, and its
 * previous-year papers.
 *
 * Both live inside the existing semester → subject tree rather than in separate
 * top-level sections, because both are properties of a subject and belong where
 * the subject already is.
 */
export function SubjectExtras({
  subjectId,
  subjectName,
  cover,
  pyqs,
  maxUploadMb,
}: {
  subjectId: string;
  subjectName: string;
  cover: string | null;
  pyqs: CatalogPyq[];
  maxUploadMb: number;
}) {
  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-[auto,1fr]">
      <CoverManager subjectId={subjectId} subjectName={subjectName} cover={cover} />
      <PyqManager
        subjectId={subjectId}
        subjectName={subjectName}
        pyqs={pyqs}
        maxUploadMb={maxUploadMb}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

function CoverManager({
  subjectId,
  subjectName,
  cover,
}: {
  subjectId: string;
  subjectName: string;
  cover: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);

    if (!COVER_TYPES.includes(file.type)) {
      setError('Covers must be a JPG, PNG or WebP image.');
      return;
    }
    if (file.size > COVER_MAX_BYTES) {
      setError(`That image is ${formatBytes(file.size)}. The limit is 5 MB.`);
      return;
    }

    // Show the chosen image straight away rather than after the round trip.
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    setBusy(true);

    try {
      const presignResponse = await fetch('/api/admin/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'cover',
          subjectId,
          fileName: file.name,
          contentType: file.type,
          size: file.size,
        }),
      });
      const presign = (await presignResponse.json()) as
        | { mode: 'proxy' }
        | { mode: 'direct'; key: string; url: string; headers: Record<string, string> }
        | { error?: string };

      if (!presignResponse.ok) {
        throw new Error(
          ('error' in presign && presign.error) || 'Could not start the upload. Please try again.',
        );
      }

      const payload = new FormData();
      if ('mode' in presign && presign.mode === 'direct') {
        const put = await fetch(presign.url, {
          method: 'PUT',
          headers: presign.headers,
          body: file,
        }).catch(() => null);

        if (!put) throw new Error(describeStorageFailure(0, ''));
        if (!put.ok) {
          throw new Error(describeStorageFailure(put.status, await put.text().catch(() => '')));
        }
        payload.append('storageKey', presign.key);
      } else {
        payload.append('file', file);
      }

      const response = await fetch(`/api/admin/subjects/${subjectId}/cover`, {
        method: 'POST',
        body: payload,
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'The cover could not be saved.');

      toast.success('Cover updated.');
      setPreview(null);
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    } catch (uploadError) {
      setPreview(null);
      setError(uploadError instanceof Error ? uploadError.message : 'The upload failed.');
    } finally {
      URL.revokeObjectURL(objectUrl);
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/subjects/${subjectId}/cover`, { method: 'DELETE' });
      if (!response.ok) throw new Error('The cover could not be removed.');
      toast.success('Cover removed.');
      router.refresh();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  const shown = preview ?? cover;

  return (
    <div className="flex gap-3 rounded border border-border/70 bg-muted/25 p-2.5">
      <div className="relative aspect-[3/4] w-16 shrink-0 overflow-hidden rounded border border-border bg-muted">
        {shown ? (
          // A blob: preview and a same-origin API URL are both fine here; the
          // admin list is small and not worth the optimiser round trip.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown}
            alt={`Current cover for ${subjectName}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageUp aria-hidden className="size-4" />
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Loader2 aria-hidden className="size-4 animate-spin text-primary" />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col justify-center gap-1.5">
        <p className="text-xs font-medium">Notebook cover</p>
        {error ? (
          <p className="max-w-[16rem] text-[11px] leading-snug text-destructive">{error}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">JPG, PNG or WebP · up to 5 MB</p>
        )}

        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {cover ? 'Change' : 'Upload'}
          </Button>
          {cover && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label={`Upload a cover image for ${subjectName}`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PYQs
// ---------------------------------------------------------------------------

function PyqManager({
  subjectId,
  subjectName,
  pyqs,
  maxUploadMb,
}: {
  subjectId: string;
  subjectName: string;
  pyqs: CatalogPyq[];
  maxUploadMb: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(pyq: CatalogPyq) {
    setDeleting(pyq.id);
    try {
      const response = await fetch(`/api/admin/pyqs/${pyq.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      toast.success(`${pyq.year} paper deleted.`);
      router.refresh();
    } catch {
      toast.error('That paper could not be deleted.');
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="rounded border border-border/70 bg-muted/25 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">
          Previous year questions
          <span className="ml-1.5 font-normal text-muted-foreground">
            {pyqs.length === 0 ? 'none yet' : `${pyqs.length}`}
          </span>
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <FileUp className="size-3.5" />
          Add PYQ
        </Button>
      </div>

      {pyqs.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {pyqs.map((pyq) => (
            <li
              key={pyq.id}
              className="flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1"
            >
              <span className="font-mono text-xs tabular-nums">{pyq.year}</span>
              <span className="text-[10px] text-muted-foreground">{formatBytes(pyq.fileSize)}</span>
              <button
                type="button"
                aria-label={`Delete the ${pyq.year} paper for ${subjectName}`}
                disabled={deleting === pyq.id}
                onClick={() => void remove(pyq)}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
              >
                {deleting === pyq.id ? (
                  <Loader2 aria-hidden className="size-3 animate-spin" />
                ) : (
                  <Trash2 aria-hidden className="size-3" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload PYQ</DialogTitle>
            <DialogDescription>
              A previous year question paper for {subjectName}. Uploading a year that already
              exists replaces that paper.
            </DialogDescription>
          </DialogHeader>
          <PyqUploadForm
            subjectId={subjectId}
            maxUploadMb={maxUploadMb}
            existingYears={pyqs.map((pyq) => pyq.year)}
            onDone={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PyqUploadForm({
  subjectId,
  maxUploadMb,
  existingYears,
  onDone,
}: {
  subjectId: string;
  maxUploadMb: number;
  existingYears: number[];
  onDone: () => void;
}) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 12 }, (_, index) => currentYear - index);

  const fileRef = useRef<HTMLInputElement>(null);
  const [year, setYear] = useState(String(currentYear));
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const replacing = existingYears.includes(Number(year));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!file) {
      setError('Choose a PDF to upload.');
      return;
    }
    setPending(true);

    try {
      const presignResponse = await fetch('/api/admin/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: 'application/pdf',
          size: file.size,
        }),
      });
      const presign = (await presignResponse.json()) as
        | { mode: 'proxy' }
        | { mode: 'direct'; key: string; url: string; headers: Record<string, string> };
      if (!presignResponse.ok) throw new Error('Could not start the upload. Please try again.');

      const payload = new FormData();
      payload.append('subjectId', subjectId);
      payload.append('year', year);
      if (label.trim()) payload.append('label', label.trim());

      if (presign.mode === 'direct') {
        const put = await fetch(presign.url, {
          method: 'PUT',
          headers: presign.headers,
          body: file,
        }).catch(() => null);

        if (!put) throw new Error(describeStorageFailure(0, ''));
        if (!put.ok) {
          throw new Error(describeStorageFailure(put.status, await put.text().catch(() => '')));
        }
        payload.append('storageKey', presign.key);
        payload.append('fileName', file.name);
      } else {
        payload.append('file', file);
      }

      const response = await fetch('/api/admin/pyqs', { method: 'POST', body: payload });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'The upload failed.');

      toast.success(replacing ? `${year} paper replaced.` : `${year} paper added.`);
      onDone();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'The upload failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert variant="error">{error}</Alert>}

      <Field label="Year" htmlFor="pyq-year">
        <Select id="pyq-year" value={year} onChange={(event) => setYear(event.target.value)}>
          {years.map((value) => (
            <option key={value} value={value}>
              {value}
              {existingYears.includes(value) ? ' — replaces the current paper' : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Label" htmlFor="pyq-label" hint="Optional — only if the year alone is ambiguous.">
        <Input
          id="pyq-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Supplementary"
        />
      </Field>

      <Field label="PDF" htmlFor="pyq-file" hint={`Up to ${maxUploadMb} MB.`}>
        <div className="rounded-md border border-dashed border-border p-3 text-center">
          {file ? (
            <div className="flex items-center justify-center gap-2">
              <span className="min-w-0 truncate text-sm">{file.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove file"
                onClick={() => {
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = '';
                }}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              Choose PDF
            </Button>
          )}
          <input
            ref={fileRef}
            id="pyq-file"
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(event) => {
              const chosen = event.target.files?.[0] ?? null;
              setError(null);
              if (chosen && chosen.size > maxUploadMb * 1024 * 1024) {
                setError(`That file is ${formatBytes(chosen.size)}. The limit is ${maxUploadMb} MB.`);
                return;
              }
              setFile(chosen);
            }}
          />
        </div>
      </Field>

      <Button type="submit" className="w-full" loading={pending} disabled={!file}>
        {replacing ? `Replace the ${year} paper` : 'Upload PYQ'}
      </Button>
    </form>
  );
}
