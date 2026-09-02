'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';

/**
 * Users see a plain apology and a way forward. The real error goes to the
 * console (and therefore the server/host logs), never onto the page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ui] unhandled error', error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <h1 className="max-w-md text-balance text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        The page could not be loaded. Trying again usually helps — if it keeps happening, let us
        know.
      </p>

      {error.digest && (
        <Alert variant="info" className="max-w-sm text-left">
          Reference: <code className="font-mono text-xs">{error.digest}</code>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Back to the catalogue</Link>
        </Button>
      </div>
    </main>
  );
}
