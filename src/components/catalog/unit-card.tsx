'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useAuthModal } from '@/components/auth/auth-modal';
import { type CardAccessState } from '@/components/catalog/note-card';
import { cn } from '@/lib/utils';

export interface UnitCardProps {
  /** 1-based position in the notebook — the "3" in "Unit 3". */
  index: number;
  name: string;
  description: string | null;
  /** The unit's PDF. `null` means nothing has been uploaded to this unit yet. */
  note: { id: string; access: CardAccessState } | null;
}

/**
 * A unit, and the one PDF behind it.
 *
 * One unit is one PDF, so the unit is the thing you open — there is no note
 * listed underneath it and no intermediate page. Clicking the card goes straight
 * to the reader. That is also why the card carries no file name, page count or
 * upload date: none of it helps a student choose a unit, and all of it would
 * make the card look like a file browser.
 *
 * A unit with nothing uploaded is still shown, inert, so the notebook reads as
 * complete and a student can see what is still to come rather than wondering
 * whether a unit exists at all.
 *
 * Access is not decided here. `access` is a display hint computed on the server;
 * opening the note still runs the full authorisation chain. The card is a real
 * link so it can be opened in a new tab like any other, and a visitor who is not
 * signed in gets the sign-in modal instead of a redirect they have to come back
 * from.
 */
export function UnitCard({ index, name, description, note }: UnitCardProps) {
  const { requestAuth } = useAuthModal();

  const access: CardAccessState | null = note?.access ?? null;
  const openable = access?.kind === 'open' || access?.kind === 'sign_in_required';
  const inert = !openable;
  const href = note ? `/notes/${note.id}` : '#';

  function onClick(event: React.MouseEvent) {
    if (!note || note.access.kind !== 'sign_in_required') return;
    // Let a modified click (new tab, new window) through — the reader itself
    // will ask them to sign in.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    requestAuth(href);
  }

  return (
    <article
      className={cn(
        'surface-interactive group relative flex h-full min-w-0 flex-col p-4',
        'focus-within:border-primary/50',
        inert && 'opacity-70 hover:border-border hover:shadow-none',
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

      <div className="mt-auto flex items-center justify-end pt-4">
        {note === null ? (
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
