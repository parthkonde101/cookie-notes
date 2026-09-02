import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">404</p>
      <h1 className="max-w-md text-balance text-2xl font-semibold tracking-tight">
        We could not find that page
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        It may have been moved, or it may be something your account does not have access to.
      </p>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/">Back to the catalogue</Link>
        </Button>
      </div>
    </main>
  );
}
