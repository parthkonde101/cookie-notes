'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useAuthModal } from '@/components/auth/auth-modal';
import { useVerificationGate } from '@/components/auth/verification-gate';
import { type CardAccessState } from '@/components/catalog/note-card';
import { BakingCookie, NotifyMeButton } from '@/components/catalog/baking';
import { cn } from '@/lib/utils';

export interface UnitCardProps {
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
 * A unit, in one of its three states.
 *
 *   PDF uploaded        → a normal card you open
 *   no PDF, baking      → "Being Baked", with a reminder you can ask for
 *   no PDF, not baking  → "Not uploaded yet", inert
 *
 * One unit is one PDF, so the unit is the thing you open — there is no note
 * listed underneath it and no intermediate page. Clicking the card goes straight
 * to the reader. That is also why the card carries no file name, page count or
 * upload date: none of it helps a student choose a unit, and all of it would
 * make the card look like a file browser.
 *
 * A unit with nothing uploaded is still shown, so the notebook reads as complete
 * and a student can see what is still to come rather than wondering whether a
 * unit exists at all.
 *
 * Access is not decided here. `access` is a display hint computed on the server;
 * opening the note still runs the full authorisation chain. The card is a real
 * link so it can be opened in a new tab like any other, and a visitor who is not
 * signed in gets the sign-in modal instead of a redirect they have to come back
 * from.
 */
export function UnitCard({
  index,
  name,
  description,
  note,
  unitId,
  beingBaked = false,
  subscribed = false,
}: UnitCardProps) {
  const { requestAuth } = useAuthModal();
  const { allowNoteOpen } = useVerificationGate();

  const access: CardAccessState | null = note?.access ?? null;
  const openable = access?.kind === 'open' || access?.kind === 'sign_in_required';
  // A baking unit is not openable, but it is not greyed out either — it is
  // deliberately the most alive-looking of the two empty states.
  const baking = !note && beingBaked;
  const inert = !openable && !baking;
  const href = note ? `/notes/${note.id}` : '#';

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
    <article
      className={cn(
        'surface-interactive group relative flex h-full min-w-0 flex-col p-4',
        'focus-within:border-primary/50',
        inert && 'opacity-70 hover:border-border hover:shadow-none',
        // Warm, not loud: a hint of the brand brown so a baking unit reads as
        // "coming" rather than "broken", without competing with a real card.
        baking && 'border-primary/30 bg-primary/[0.04] hover:border-primary/45',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded font-mono text-xs font-semibold',
            inert ? 'bg-muted text-muted-foreground' : 'bg-primary/20 text-primary',
          )}
        >
          {index}
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="text-pretty text-[0.95rem] font-medium leading-snug">
            {openable ? (
              <Link
                href={href}
                onClick={onClick}
                // The pseudo-element makes the whole card clickable while
                // keeping exactly one tab stop and one accessible name.
                className="text-left outline-none transition-colors after:absolute after:inset-0 group-hover:text-primary focus-visible:text-primary"
              >
                <span className="sr-only">Unit {index}: </span>
                {name}
              </Link>
            ) : (
              <span className="text-left">
                <span className="sr-only">Unit {index}: </span>
                {name}
              </span>
            )}
          </h3>
          {description && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>

      {/* Being Baked. The cookie is decorative; the words carry the state, so
          nothing here depends on the animation being seen or running. */}
      {baking && (
        <div className="mt-3 flex items-center gap-2.5">
          <BakingCookie />
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">Being Baked</p>
            <p className="text-xs leading-snug text-muted-foreground">
              Fresh notes are on the way…
            </p>
          </div>
        </div>
      )}

      <div
        className={cn(
          'mt-auto flex flex-wrap items-center gap-2 pt-4',
          baking ? 'justify-start' : 'justify-end',
        )}
      >
        {baking ? (
          <NotifyMeButton
            unitId={unitId}
            unitLabel={`Unit ${index} — ${name}`}
            subscribed={subscribed}
          />
        ) : note === null ? (
          <span className="rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground">
            Not uploaded yet
          </span>
        ) : access?.kind === 'unavailable' ? (
          <span className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">
            Unavailable
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-primary">
            Open
            <ArrowRight aria-hidden className="size-3 transition-transform group-hover:translate-x-0.5" />
          </span>
        )}
      </div>
    </article>
  );
}
