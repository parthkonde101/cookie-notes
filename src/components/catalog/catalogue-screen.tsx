import { after } from 'next/server';
import { cookies } from 'next/headers';
import { Library } from 'lucide-react';
import { EmptyState } from '@/components/ui/feedback';
import { NotebookCard } from '@/components/catalog/notebook-card';
import { ProgramSelector } from '@/components/catalog/program-selector';
import { ProgramPanel } from '@/components/catalog/program-panel';
import { ProgramTransitionProvider } from '@/components/catalog/program-transition';
import { catalogOverview, publishedNoteCount } from '@/lib/catalog';
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
 *
 * Rendered from two routes — `/` for a signed-in visitor and `/catalog` for
 * anyone, signed in or not — so it takes no opinion on who is allowed to see
 * it. Both callers own their own `metadata` and `dynamic` exports; this is a
 * plain component, not a page.
 */
export async function CatalogueScreen({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, cookieStore] = await Promise.all([searchParams, cookies()]);
  const program = resolveProgram(params[PROGRAM_PARAM], cookieStore.get(PROGRAM_COOKIE)?.value);

  /*
   * THE CRITICAL PATH.
   *
   * `catalogOverview` is two round trips — semesters, then their subjects —
   * and every pixel below depends on them.
   *
   * `optionalUser` and `requestContext` are resolved here rather than in the
   * `after()` callback below because Next forbids reading `headers()` or
   * `cookies()` inside one ("Route / used \"headers\" inside \"after(...)\"").
   * That is not a performance compromise: `requestContext` only parses headers
   * and touches no database, and the session lookup runs concurrently with the
   * catalogue queries, so it adds no wall-clock time — it is also exactly what
   * this page did before, and what the surrounding layout does anyway.
   */
  const [semesters, auth, ctx] = await Promise.all([
    catalogOverview(program),
    optionalUser(),
    requestContext(),
  ]);

  /*
   * ANALYTICS RUNS AFTER THE RESPONSE, NOT BEFORE IT.
   *
   * This page used to await four further round trips that no pixel depends on:
   * three COUNTs from `catalogTotals` (one a two-table join through subjects
   * to semesters), of which only `.notes` was ever read, and then an INSERT
   * into `activity_events`. All four sat between the click and the first byte.
   * On a same-machine database that is invisible; against a hosted Postgres it
   * is four extra network round trips on every programme switch — the pause
   * that made switching feel slow.
   *
   * `after()` is Next's supported mechanism for exactly this: the callback runs
   * once the response is finished, but still inside the request's lifecycle, so
   * the serverless invocation is kept alive until it completes. That is the
   * difference from a bare `void recordEvent(...)`, which on a platform that
   * freezes the instance at response time can simply lose the write.
   *
   * `recordEvent` already swallows and logs its own failures, so a broken
   * analytics write can never surface as an unhandled rejection or affect the
   * page a student is reading. The two counts that were computed and discarded
   * are gone; the event itself is unchanged — same type, same fields, same
   * `notes` value.
   *
   * Everything the callback needs from the request is captured above and
   * closed over, because request APIs are not readable from inside `after()`.
   */
  after(async () => {
    const notes = await publishedNoteCount(program);

    // Recorded for analytics only — never shown to students. `program` rides
    // along so the existing event keeps describing what was on screen;
    // program-sliced analytics proper is a later phase.
    await recordEvent({
      type: 'CATALOG_VIEWED',
      userId: auth?.user.id ?? null,
      sessionId: auth?.session.id ?? null,
      ctx,
      metadata: { semesters: semesters.length, notes, program },
    });
  });

  // Counts notebooks only, and decides which get an eager image load.
  let cardIndex = 0;

  /*
   * Drives the settle-in stagger. One running index across the whole shelf —
   * heading, then its cards, then the next heading — so the catalogue arrives
   * as a single wave rather than each semester animating on its own clock.
   */
  let enterIndex = 0;
  const enterDelay = () => {
    // Capped at 8 steps: 8 x 24ms = 192ms of delay plus a 200ms animation is
    // 392ms to the last element, just inside the 400ms budget. Without the cap
    // a semester holding thirty notebooks would still be animating in well
    // after a second.
    const step = Math.min(enterIndex, 8);
    enterIndex += 1;
    return { animationDelay: `${step * 24}ms` } as const;
  };

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
         * The provider wraps both the switch and the shelf so one pending flag
         * reaches both. It carries no catalogue data — the shelf below is still
         * server-rendered and passed straight through as children.
         */}
        <ProgramTransitionProvider active={program}>
          {/*
           * The switch sits above the shelf and outside the region it controls,
           * so re-rendering the shelf never remounts it and the indicator keeps
           * its position through the transition. It is deliberately excluded
           * from the dimming: the one thing that must stay solid while the
           * catalogue changes is the control you just pressed.
           *
           * Centred at every width — it is the page's primary navigation, and
           * on a centred layout an off-axis control is the thing the eye
           * catches.
           */}
          <div className="mb-10 flex justify-center">
            <ProgramSelector active={program} controls={SHELF_ID} />
          </div>

          {/*
           * `key={program}` is what makes the swap read as a transition rather
           * than a redraw: React tears the old shelf down and mounts a new one,
           * so the per-card `animate-catalog-enter` runs again on every switch
           * instead of only on first load.
           */}
          <ProgramPanel
            key={program}
            id={SHELF_ID}
            label={`${programLabel(program)} catalogue`}
          >
            {semesters.length === 0 ? (
              <EmptyState
                className="animate-catalog-enter motion-reduce:animate-none"
                icon={Library}
                title={`${programLabel(program)} notes are being prepared`}
                description="Nothing is on this shelf yet. Try the other programme above, or create an account so you are ready when these land."
              />
            ) : (
              <div className="space-y-14">
                {semesters.map((semester) => (
                  <div key={semester.id}>
                    {/*
                     * The heading and its cards animate; the description rides
                     * with the heading rather than taking a step of its own.
                     * Animating every nested element separately is what makes a
                     * page look busy instead of composed.
                     *
                     * The heading says "Semester 1", never "B.Tech · Semester
                     * 1" — the selector states the programme once. The stored
                     * name is untouched; this is display only.
                     */}
                    <div
                      style={enterDelay()}
                      className="animate-catalog-enter motion-reduce:animate-none"
                    >
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
                    </div>

                    {/*
                     * `auto-fit` with fixed-width tracks, not `auto-fill` with
                     * `1fr`. The distinction is the whole trick: `auto-fill`
                     * keeps generating empty tracks to fill the row, so
                     * `justify-center` has nothing left to centre and a lone
                     * notebook stays pinned to the left edge. `auto-fit`
                     * collapses the empty tracks, leaving only the real cards
                     * for `justify-center` to balance — so a half-full last row
                     * sits under the middle of the one above it. The
                     * `min(…,100%)` floor still lets a card shrink rather than
                     * overflow on a narrow phone.
                     */}
                    <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(9.5rem,100%),9.5rem))] justify-center gap-4 sm:gap-5">
                      {semester.subjects.map((subject) => {
                        // Roughly the first row on a wide screen loads eagerly
                        // so the shelf paints immediately; everything below it
                        // waits until it is scrolled to.
                        const priority = cardIndex < 4;
                        cardIndex += 1;
                        return (
                          /*
                           * The wrapper animates, not the card. The card owns a
                           * `hover:-translate-y-0.5`, and an entrance transform
                           * on the same element would fight it — a notebook
                           * hovered mid-settle would snap. Two elements, two
                           * transforms, no interference.
                           */
                          <div
                            key={subject.id}
                            style={enterDelay()}
                            className="animate-catalog-enter motion-reduce:animate-none"
                          >
                            <NotebookCard
                              name={subject.name}
                              slug={subject.slug}
                              cover={subject.cover}
                              priority={priority}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ProgramPanel>
        </ProgramTransitionProvider>
      </section>
    </>
  );
}
