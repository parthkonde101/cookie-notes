'use client';

import Image from 'next/image';
import Link from 'next/link';
import { BookOpenCheck, ChevronDown, FileText, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BuyButton } from '@/components/commerce/buy-button';
import { formatInr } from '@/lib/commerce/money';
import { cn } from '@/lib/utils';

export interface BundleCardNote {
  id: string;
  title: string;
  priceMinor: number;
  isPaid: boolean;
  owned: boolean;
}

export interface BundleCardProps {
  id: string;
  title: string;
  description: string | null;
  priceMinor: number;
  featured?: boolean;
  cover: string | null;
  notes: BundleCardNote[];
  /** From `bundleSavings`: only present when there is an honest comparison. */
  savings: { separateMinor: number; savingsMinor: number; percent: number } | null;
  signedIn: boolean;
  /** Where to send a signed-out student back to after they sign in. */
  returnTo: string;
  /** Admin preview: identical look, and the button does nothing. */
  preview?: boolean;
}

/**
 * A bundle, as a student meets it at the top of a subject page.
 *
 * It is a product, not a decoration: the title, description, what it costs and what is in
 * it, then one clear way to buy. Prices come from the server; the savings line appears only
 * when a real comparison exists and is a plain difference — there is never a crossed-out
 * "was" price. What the student already owns is said out loud, not silently charged for.
 */
export function BundleCard({
  id,
  title,
  description,
  priceMinor,
  featured,
  cover,
  notes,
  savings,
  signedIn,
  returnTo,
  preview = false,
}: BundleCardProps) {
  const ownedCount = notes.filter((note) => note.owned).length;
  const allOwned = notes.length > 0 && ownedCount === notes.length;

  return (
    <article
      aria-labelledby={`bundle-${id}`}
      className={cn(
        'overflow-hidden rounded-xl border bg-card',
        featured ? 'border-primary/45 shadow-[0_0_0_1px_hsl(var(--primary)/0.12)]' : 'border-border',
      )}
    >
      <div className={cn('flex flex-col gap-5 p-4', !preview && 'sm:flex-row sm:items-stretch sm:gap-6 sm:p-5')}>
        <div className={cn('relative aspect-[3/4] w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted shadow-md', !preview && 'hidden sm:block')}>
          {cover ? (
            <Image src={cover} alt="" fill sizes="80px" className="object-cover" />
          ) : (
            <div
              aria-hidden
              className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/25 to-primary/5"
            >
              <BookOpenCheck className="size-6 text-primary/70" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {featured && (
              <Badge variant="default" className="gap-1">
                <Sparkles className="size-3" /> Featured
              </Badge>
            )}
            <span className="text-xs font-medium uppercase tracking-wider text-primary">
              Bundle · {notes.length} notes
            </span>
          </div>
          <h3 id={`bundle-${id}`} className="mt-1.5 text-pretty text-lg font-semibold leading-snug tracking-tight">
            {title}
          </h3>
          {description && (
            <p className="mt-1.5 line-clamp-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          )}

          {ownedCount > 0 && !allOwned && (
            <p className="mt-3 rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
              You already have {ownedCount} of these {notes.length} notes. The bundle still includes them, so the
              price does not change.
            </p>
          )}
        </div>

        <div className={cn('flex shrink-0 flex-row items-end justify-between gap-4', !preview && 'sm:w-48 sm:flex-col sm:items-end sm:justify-center')}>
          <div className={cn(!preview && 'sm:text-right')}>
            <p className="text-2xl font-semibold tabular-nums tracking-tight">{formatInr(priceMinor)}</p>
            {savings ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-medium text-success">Save {formatInr(savings.savingsMinor)}</span> · the notes
                cost {formatInr(savings.separateMinor)} separately
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-muted-foreground">One payment, yours to keep</p>
            )}
          </div>

          {allOwned ? (
            <Badge variant="success" className="px-3 py-1.5 text-xs">
              You own all of it
            </Badge>
          ) : (
            <BuyButton
              productType="BUNDLE"
              productId={id}
              returnTo={returnTo}
              priceMinor={priceMinor}
              signedIn={signedIn}
              preview={preview}
              label={`Buy bundle · ${formatInr(priceMinor)}`}
              openHref="/account/purchases"
              openLabel="See what’s included"
              size="lg"
              className={cn('w-full', !preview && 'sm:w-auto')}
            />
          )}
        </div>
      </div>

      <details className="group border-t border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5">
          <span>What’s included</span>
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {notes.map((note) => (
            <li key={note.id} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{note.title}</span>
              {note.owned ? (
                preview ? (
                  <Badge variant="success">Owned</Badge>
                ) : (
                  <Link href={`/notes/${note.id}`} className="shrink-0">
                    <Badge variant="success">Owned · open</Badge>
                  </Link>
                )
              ) : note.isPaid ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatInr(note.priceMinor)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
