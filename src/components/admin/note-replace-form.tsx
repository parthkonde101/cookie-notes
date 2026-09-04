'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { describeStorageFailure } from '@/components/admin/note-upload-form';
import { formatBytes } from '@/lib/utils';

export function NoteReplaceForm({ noteId, maxMb }: { noteId: string; maxMb: number }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    if (!file) return;
    setError(null);
    setPending(true);

    try {
      const presignResponse = await fetch('/api/admin/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: 'application/pdf', size: file.size }),
      });
      const presign = (await presignResponse.json()) as
        | { mode: 'proxy' }
        | { mode: 'direct'; key: string; url: string; headers: Record<string, string> };
      if (!presignResponse.ok) throw new Error('Could not start the upload.');

      const payload = new FormData();
      if (presign.mode === 'direct') {
        const put = await fetch(presign.url, {
          method: 'PUT',
          headers: presign.headers,
          body: file,
        }).catch(() => null);

        // A null response means the request never produced one — same
        // CORS/network case the upload form reports as status 0.
        if (!put) throw new Error(describeStorageFailure(0, ''));
        if (!put.ok) {
          throw new Error(describeStorageFailure(put.status, await put.text().catch(() => '')));
        }
        payload.append('storageKey', presign.key);
        payload.append('fileName', file.name);
      } else {
        payload.append('file', file);
      }

      const response = await fetch(`/api/admin/notes/${noteId}/replace`, {
        method: 'POST',
        body: payload,
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; version?: number };
      if (!response.ok) throw new Error(data.error ?? 'The replacement failed.');

      toast.success(`Replaced — now version ${data.version}.`);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    } catch (replaceError) {
      setError(replaceError instanceof Error ? replaceError.message : 'The replacement failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert variant="error">{error}</Alert>}

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
        onChange={(event) => {
          const next = event.target.files?.[0] ?? null;
          setError(null);
          if (next && next.size > maxMb * 1024 * 1024) {
            setError(`That file is ${formatBytes(next.size)}. The limit is ${maxMb} MB.`);
            setFile(null);
            return;
          }
          setFile(next);
        }}
      />

      <Button onClick={() => void submit()} disabled={!file} loading={pending} variant="outline">
        Replace file
      </Button>
    </div>
  );
}
