'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useAuthModal } from '@/components/auth/auth-modal';
import { useVerificationGate } from '@/components/auth/verification-gate';
import { type CardAccessState } from '@/components/catalog/note-card';
import { BakingCookie, NotifyMeButton } from '@/components/catalog/baking';
import { cn } from '@/lib/utils';

export interface UnitRowProps {
  /** 1-based position in the notebook — the "3" in "Unit 3". */
  index: number;
  name: string;
  description: string | null;
  /** The unit's PDF. `null` means nothing has been uploaded to this unit yet. */
  note: { id: string; access: CardAccessState } | null;
  /** Needed only for the "Notify me" action while the unit is baking. */
  unitId: string;
  /** "Being Baked" — the notes are on the way. Never true alongside `note`. */
  beingBaked?: boolean;
  /** Whether the viewer has already asked to be notified about this unit. */
  subscribed?: boolean;
}

/**
 * Unit titles are often stored as "Unit 3 - Network Layer" or "Unit 3: Network
 * Layer". The row already shows the number, so repeating it in the title would
 * read "03 · Unit 3 · Unit 3 - Network Layer". Only a leading label that matches
 * this unit's own position is removed; anything else is left exactly as written.
 */
export function unitTitle(name: string, index: number): string {
  const stripped = name.replace(/^\s*unit\s*(\d+)\s*[:.)\-–—]?\s*/i, (whole, digits: string) =>
    Number(digits) === index ? '' : whole,
  );
  return stripped.trim() || name;
}

/**
 * One unit, as a line in the notebook's table of contents.
 *
 * A subject has a handful of units, read in order, so they are a numbered list
 * rather than a grid of cards: a large zero-padded numeral, the unit's title,
 * and on the right the one thing you can do with it. The rows share a single
 * ruled surface, like the contents page of a book.
 *
 * A unit is in one of three states:
 *
 *   PDF uploaded        → a row you open
 *   no PDF, baking      → "Being Baked", with a reminder you can ask for
 *   no PDF, not baking  → "Not uploaded yet", inert
 *
 * One unit is one PDF, so the unit is the thing you open — there is no note
 * listed underneath it and no intermediate page. Clicking the row goes straight
 * to the reader. That is also why the row carries no file name, page count or
 * upload date: none of it helps a student choose a unit, and all of it would
 * make the list look like a file browser.
 *
 * A unit with nothing uploaded is still shown, so the notebook reads as complete
 * and a student can see what is still to come rather than wondering whether a
 * unit exists at all.
 *
 * Access is not decided here. `access` is a display hint computed on the server;
 * opening the note still runs the full authorisation chain. The row is a real
 * link so it can be opened in a new tab like any other, and a visitor who is not
 * signed in gets the sign-in modal instead of a redirect they have to come back
 * from.
 */
export function UnitRow({
  index,
  name,
  description,
  note,
  unitId,
  beingBaked = false,
  subscribed = false,
}: UnitRowProps) {
  const { requestAuth } = useAuthModal();
  const { allowNoteOpen } = useVerificationGate();

  const access: CardAccessState | null = note?.access ?? null;
  const openable = access?.kind === 'open' || access?.kind === 'sign_in_required';
  // A baking unit is not openable, but it is not greyed out either — it is
  // deliberately the most alive-looking of the two empty states.
  const baking = !note && beingBaked;
  const inert = !openable && !baking;
  const href = note ? `/notes/${note.id}` : '#';
  const title = unitTitle(name, index);

  function onClick(event: React.MouseEvent) {
    if (!note) return;
    // Let a modified click (new tab, new window) through — the reader itself
    // applies the same rules, so nothing is lost by not intercepting it.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

    if (note.access.kind === 'sign_in_required') {
      event.preventDefault();
      requestAuth(href);
      return;
    }
    // Signed in but unverified: the dialog, not the reader. The reader would
    // refuse them anyway; this is so they find out here, with a way forward.
    if (!allowNoteOpen(href)) event.preventDefault();
  }

  return (
    <li
      className={cn(
        'group relative flex flex-col gap-3 px-4 py-4 transition-colors sm:flex-row sm:items-center sm:gap-5 sm:px-5',
        'focus-within:bg-accent/25',
        openable && 'hover:bg-accent/25',
        baking && 'bg-primary/[0.04]',
      )}
    >
      {/* A warm edge that appears on the row you are about to open. */}
      {openable && (
        <span
          aria-hidden
          className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        />
      )}

      <div className="flex min-w-0 flex-1 items-start gap-4 sm:items-center sm:gap-5">
        <span
          aria-hidden
          className={cn(
            'w-9 shrink-0 text-right font-mono text-2xl font-semibold leading-none tabular-nums tracking-tight transition-colors sm:w-11 sm:text-[1.75rem]',
            inert ? 'text-muted-foreground/40' : 'text-primary/55 group-hover:text-primary',
          )}
        >
          {String(index).padStart(2, '0')}
        </span>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-[0.68rem] font-medium uppercase tracking-[0.14em]',
              inert ? 'text-muted-foreground/60' : 'text-muted-foreground',
            )}
          >
            Unit {index}
          </p>
          <h3
            className={cn(
              'mt-0.5 text-pretty text-base font-medium leading-snug',
              inert && 'text-muted-foreground',
            )}
          >
            {openable ? (
              <Link
                href={href}
                onClick={onClick}
                // The pseudo-element makes the whole row clickable while
                // keeping exactly one tab stop and one accessible name.
                className="text-left outline-none transition-colors after:absolute after:inset-0 group-hover:text-primary focus-visible:text-primary"
              >
                <span className="sr-only">Unit {index}: </span>
                {title}
              </Link>
            ) : (
              <span className="text-left">
                <span className="sr-only">Unit {index}: </span>
                {title}
              </span>
            )}
          </h3>
          {description && (
            <p className="mt-1 line-clamp-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>

      {/* The one thing you can do with this unit. Aligned under the title on a
          phone, to the right of the row from `sm` up. */}
      <div className="flex items-center gap-3 pl-[3.25rem] sm:shrink-0 sm:justify-end sm:pl-0">
        {baking ? (
          // Being Baked. The cookie is decorative; the words carry the state, so
          // nothing here depends on the animation being seen or running.
          <>
            <div className="flex items-center gap-2">
              <BakingCookie />
              <p className="text-sm font-medium text-primary">Being baked</p>
            </div>
            <NotifyMeButton
              unitId={unitId}
              unitLabel={`Unit ${index} — ${title}`}
              subscribed={subscribed}
            />
          </>
        ) : note === null ? (
          <span className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground">
            Not uploaded yet
          </span>
        ) : access?.kind === 'unavailable' ? (
          <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            Unavailable
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors group-hover:border-primary/50 group-hover:bg-primary/10 group-hover:text-primary">
            Open
            <ArrowRight
              aria-hidden
              className="size-3 transition-transform group-hover:translate-x-0.5"
            />
          </span>
        )}
      </div>
    </li>
  );
}
