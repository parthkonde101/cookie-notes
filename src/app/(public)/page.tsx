import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpen, Library } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { catalogOverview, catalogTotals } from '@/lib/catalog';
import { optionalUser } from '@/lib/auth/guards';
import { recordEvent } from '@/lib/analytics/events';
import { requestContext } from '@/lib/request';

export const metadata: Metadata = {
  title: 'Cookie Notes — baked for exams',
};
export const dynamic = 'force-dynamic';

/**
 * The product's front door and its only real destination.
 *
 * The catalogue is public and identical for everyone — no login wall, no
 * personalised filtering. The header carries the name and nothing else; the
 * catalogue itself is the pitch.
 */
export default async function CatalogHomePage() {
  const [semesters, totals, auth, ctx] = await Promise.all([
    catalogOverview(),
    catalogTotals(),
    optionalUser(),
    requestContext(),
  ]);

  // Totals are recorded for analytics only — they are not shown to students.
  await recordEvent({
    type: 'CATALOG_VIEWED',
    userId: auth?.user.id ?? null,
    sessionId: auth?.session.id ?? null,
    ctx,
    metadata: { semesters: semesters.length, notes: totals.notes },
  });

  return (
    <>
      {/* Hero — the name and the line, nothing else. */}
      <section className="relative border-b border-border">
        <div aria-hidden className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-64" />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Cookie Notes</h1>
          <p className="mt-3 text-lg text-muted-foreground sm:text-xl">Baked for exams.</p>
        </div>
      </section>

      {/* Catalogue */}
      <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {semesters.length === 0 ? (
          <EmptyState
            icon={Library}
            title="The library is being prepared"
            description="Notes are being added right now. Check back shortly — or create an account so you are ready when they land."
          />
        ) : (
          <div className="space-y-12">
            {semesters.map((semester) => (
              <div key={semester.id}>
                <div className="border-b border-border pb-3">
                  <h2 className="text-lg font-semibold tracking-tight">{semester.name}</h2>
                </div>
                {semester.description && (
                  <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
                    {semester.description}
                  </p>
                )}

                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {semester.subjects.map((subject) => (
                    <Link
                      key={subject.id}
                      href={`/subject/${subject.slug}`}
                      className="surface-interactive group flex flex-col p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <BookOpen className="size-4" />
                        </span>
                        {subject.code && <Badge variant="outline">{subject.code}</Badge>}
                      </div>

                      <h3 className="mt-3 text-pretty font-medium leading-snug transition-colors group-hover:text-primary">
                        {subject.name}
                      </h3>
                      {subject.description && (
                        <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
                          {subject.description}
                        </p>
                      )}

                      <p className="mt-auto flex items-center gap-1.5 pt-4 text-xs text-muted-foreground">
                        Open
                        <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
                      </p>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
