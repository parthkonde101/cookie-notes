'use client';

import { useRouter } from 'next/navigation';
import { ArrowRight, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthModal } from '@/components/auth/auth-modal';
import { cn } from '@/lib/utils';

export type CardAccessState =
  | { kind: 'sign_in_required' }
  | { kind: 'open'; via: 'admin' | 'free' | 'entitlement' | 'preview' }
  | { kind: 'unavailable' };

export interface NoteCardProps {
  id: string;
  title: string;
  description: string | null;
  context: string | null;
  pageCount: number | null;
  access: CardAccessState;
}

/**
 * One note in the catalogue.
 *
 * Every visitor sees every card, and every card looks the same. Nothing here
 * mentions price, purchase, plans or why a note is or is not open — the only
 * signal is whether the card can be opened. A visitor who is signed out gets
 * the sign-in modal when they click; that is the whole interaction.
 *
 * Access itself is not decided here. `access` is a display hint computed on the
 * server, and opening a note still runs the full authorisation chain.
 */
export function NoteCard({ id, title, description, context, pageCount, access }: NoteCardProps) {
  const router = useRouter();
  const { requestAuth } = useAuthModal();

  const href = `/notes/${id}`;
  const unavailable = access.kind === 'unavailable';

  function activate() {
    if (access.kind === 'open') {
      router.push(href);
      return;
    }
    if (access.kind === 'sign_in_required') {
      requestAuth(href);
    }
    // 'unavailable' does nothing — the card is inert.
  }

  return (
    <article
      className={cn(
        'surface-interactive group relative flex h-full flex-col p-4',
        'focus-within:border-primary/50',
        unavailable && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md',
            unavailable ? 'bg-muted text-muted-foreground' : 'bg-primary/12 text-primary',
          )}
          aria-hidden
        >
          <FileText className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="text-pretty text-[0.95rem] font-medium leading-snug">
            {unavailable ? (
              <span className="text-left">{title}</span>
            ) : (
              <button
                type="button"
                onClick={activate}
                className="text-left outline-none transition-colors after:absolute after:inset-0 group-hover:text-primary focus-visible:text-primary"
              >
                {title}
              </button>
            )}
          </h3>
          {context && <p className="mt-1 truncate text-xs text-muted-foreground">{context}</p>}
        </div>
      </div>

      {description && (
        <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {pageCount ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : ''}
        </p>

        {unavailable ? (
          <span className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">
            Unavailable
          </span>
        ) : (
          <Button
            size="sm"
            onClick={activate}
            className="relative z-10 shrink-0"
            tabIndex={-1}
          >
            Open
            <ArrowRight className="size-3.5" />
          </Button>
        )}
      </div>
    </article>
  );
}
