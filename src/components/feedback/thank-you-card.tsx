import { Cookie } from 'lucide-react';

/**
 * The sheet the letter reveals once it's sent. Deliberately quiet — no
 * confetti, no big checkmark — the letter's own departure already carried the
 * delight; this just needs to land softly.
 */
export function ThankYouCard({
  headingRef,
  onWriteAnother,
}: {
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
  onWriteAnother: () => void;
}) {
  return (
    <div className="flex min-h-[22rem] flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-14 text-center sm:min-h-[26rem]">
      <span className="flex size-11 items-center justify-center rounded-full bg-primary/12 text-primary ring-1 ring-inset ring-primary/25">
        <Cookie className="size-5" />
      </span>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
      >
        Thank you.
      </h2>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground sm:text-base">
        Your story has been received. We&apos;ll read it carefully.
      </p>
      <button
        type="button"
        onClick={onWriteAnother}
        className="mt-8 text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        Write another letter
      </button>
    </div>
  );
}
