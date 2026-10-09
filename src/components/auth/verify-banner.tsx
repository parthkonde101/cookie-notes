import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EMAIL_MIGRATION_PATH } from '@/lib/auth/guards';

/**
 * A quiet reminder, shown at the top of the catalogue to a signed-in student who
 * has not yet verified a college email. It informs and points the way; the
 * guards on the notes and the feedback form are what actually enforce the rule.
 *
 * Verifying from here lands back on the catalogue.
 */
export function VerifyBanner({ next = '/catalog' }: { next?: string }) {
  return (
    <aside aria-label="Email verification" className="border-b border-border bg-card/70">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2.5 sm:px-6">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary ring-1 ring-inset ring-primary/25">
          <ShieldCheck aria-hidden className="size-3.5" />
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
          Verify your MIT-WPU email
        </p>
        <Button asChild size="sm" className="shrink-0">
          <Link href={`${EMAIL_MIGRATION_PATH}?next=${encodeURIComponent(next)}`}>
            Verify now
          </Link>
        </Button>
      </div>
    </aside>
  );
}
