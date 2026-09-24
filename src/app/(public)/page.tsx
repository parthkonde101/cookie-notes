import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Library } from 'lucide-react';
import { EmptyState } from '@/components/ui/feedback';
import { NotebookCard } from '@/components/catalog/notebook-card';
import { ProgramSelector } from '@/components/catalog/program-selector';
import { catalogOverview, catalogTotals } from '@/lib/catalog';
import {
  PROGRAM_COOKIE,
  PROGRAM_PARAM,
  programLabel,
  resolveProgram,
  stripProgramPrefix,
} from '@/lib/program';
import { optionalUser } from '@/lib/auth/guards';
import { recordEvent } from '@/lib/analytics/events';
import { requestContext } from '@/lib/request';

export const metadata: Metadata = {
  title: 'Cookie Notes — baked for exams',
};
export const dynamic = 'force-dynamic';

/** The region the selector swaps, so it can point `aria-controls` at it. */
const SHELF_ID = 'programme-shelf';

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
 *
 * ## Two shelves
 *
 * B.Tech and Polytechnic are two stretches of catalogue, not two audiences.
 * Which one is drawn comes from `?program=` if present, then the remembered
 * cookie, then B.Tech — resolved on the server, so the first paint is already
 * the right shelf and the selector has nothing to correct. Switching is an RSC
 * navigation: this function runs again and the shelf below is replaced, while
 * the header, the hero and the scroll position stay where they are.
 *
 * No part of this restricts anybody. A signed-out visitor and a signed-in
 * student see the same two shelves, and the selector is a view preference.
 */
export default async function CatalogHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, cookieStore] = await Promise.all([searchParams, cookies()]);
  const program = resolveProgram(params[PROGRAM_PARAM], cookieStore.get(PROGRAM_COOKIE)?.value);

  const [semesters, totals, auth, ctx] = await Promise.all([
    catalogOverview(program),
    catalogTotals(program),
    optionalUser(),
    requestContext(),
  ]);

  // Totals are recorded for analytics only — they are not shown to students.
  // `program` rides along so the existing event keeps describing what was on
  // screen; program-sliced analytics proper is a later phase.
  await recordEvent({
    type: 'CATALOG_VIEWED',
    userId: auth?.user.id ?? null,
    sessionId: auth?.session.id ?? null,
    ctx,
    metadata: { semesters: semesters.length, notes: totals.notes, program },
  });

  let cardIndex = 0;

  return (
    <>
      {/*
       * Hero — the name and the line, centred over the glow.
       *
       * The glow is already symmetrical about the page, so centring the type
       * puts the two on the same axis; left-aligned type across a centred glow
       * was the one thing on this page that looked unplaced.
       */}
      <section className="relative border-b border-border">
        <div aria-hidden className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-64" />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-14 text-center sm:px-6 sm:py-20">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Cookie Notes</h1>
          <p className="mt-3 text-lg text-muted-foreground sm:text-xl">Baked for exams.</p>
        </div>
      </section>

      {/* The shelf */}
      <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/*
         * The switch sits above the shelf and outside the region it controls,
         * so re-rendering the shelf never remounts it and the indicator keeps
         * its position through the transition.
         *
         * Centred at every width — it is the page's primary navigation, and on
         * a centred layout an off-axis control is the thing the eye catches.
         */}
        <div className="mb-10 flex justify-center">
          <ProgramSelector active={program} controls={SHELF_ID} />
        </div>

        {/*
         * `key={program}` is what makes the swap read as a transition rather
         * than a redraw: React tears the old shelf down and mounts a new one,
         * so `animate-fade-in` runs again on every switch instead of only on
         * first load. The keyframe is opacity plus a 4px rise, and
         * `motion-reduce` drops it for anyone who has asked for less movement.
         */}
        <div
          key={program}
          id={SHELF_ID}
          role="tabpanel"
          aria-label={`${programLabel(program)} catalogue`}
          className="animate-fade-in motion-reduce:animate-none"
        >
          {semesters.length === 0 ? (
            <EmptyState
              icon={Library}
              title={`${programLabel(program)} notes are being prepared`}
              description="Nothing is on this shelf yet. Try the other programme above, or create an account so you are ready when these land."
            />
          ) : (
            <div className="space-y-14">
              {semesters.map((semester) => (
                <div key={semester.id}>
                  {/*
                   * The heading says "Semester 1", never "B.Tech · Semester 1".
                   * The selector above states the programme once; repeating it
                   * on every heading underneath is noise. The stored name is
                   * untouched — this is display only.
                   */}
                  <div className="border-b border-border pb-3 text-center">
                    <h2 className="text-lg font-semibold tracking-tight">
                      {stripProgramPrefix(semester.name, program)}
                    </h2>
                  </div>
                  {semester.description && (
                    <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted-foreground">
                      {semester.description}
                    </p>
                  )}

                  {/*
                   * `auto-fit` with fixed-width tracks, not `auto-fill` with
                   * `1fr`. The distinction is the whole trick: `auto-fill`
                   * keeps generating empty tracks to fill the row, so
                   * `justify-center` has nothing left to centre and a lone
                   * notebook stays pinned to the left edge. `auto-fit`
                   * collapses the empty tracks, leaving only the real cards for
                   * `justify-center` to balance — so a half-full last row sits
                   * under the middle of the one above it. The `min(…,100%)`
                   * floor still lets a card shrink rather than overflow on a
                   * narrow phone.
                   */}
                  <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(9.5rem,100%),9.5rem))] justify-center gap-4 sm:gap-5">
                    {semester.subjects.map((subject) => {
                      // Roughly the first row on a wide screen loads eagerly so
                      // the shelf paints immediately; everything below it waits
                      // until it is scrolled to.
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
        </div>
      </section>
    </>
  );
}
