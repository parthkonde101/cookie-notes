import type { Metadata } from 'next';
import { Library } from 'lucide-react';
import { EmptyState } from '@/components/ui/feedback';
import { NotebookCard } from '@/components/catalog/notebook-card';
import { catalogOverview, catalogTotals } from '@/lib/catalog';
import { optionalUser } from '@/lib/auth/guards';
import { recordEvent } from '@/lib/analytics/events';
import { requestContext } from '@/lib/request';

export const metadata: Metadata = {
  title: 'Cookie Notes — baked for exams',
};
export const dynamic = 'force-dynamic';

/**
 * The shelf.
 *
 * Every subject is a notebook, grouped by semester. The catalogue is public and
 * identical for everyone — no login wall, no personalised filtering — and the
 * covers carry the personality, so the page around them stays quiet.
 *
 * The grid is `auto-fill` with a `min()` floor rather than a set of breakpoint
 * column counts. That makes the column count follow the space actually
 * available, and the `min(…,100%)` is what stops a track wider than its
 * container from forcing the page to scroll sideways on a narrow phone.
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

  let cardIndex = 0;

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

      {/* The shelf */}
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

                <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(min(9.5rem,100%),1fr))] gap-4 sm:gap-5">
                  {semester.subjects.map((subject) => {
                    // Roughly the first row on a wide screen loads eagerly so the
                    // shelf paints immediately; everything below it waits until
                    // it is scrolled to.
                    const priority = cardIndex < 4;
                    cardIndex += 1;
                    return (
                      <NotebookCard
                        key={subject.id}
                        name={subject.name}
                        slug={subject.slug}
                        cover={subject.cover}
                        priority={priority}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
