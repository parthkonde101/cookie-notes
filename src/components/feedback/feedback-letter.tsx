'use client';

import { useEffect, useRef, useState } from 'react';
import { Cookie } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { ThankYouCard } from '@/components/feedback/thank-you-card';
import { cn } from '@/lib/utils';

const MIN_LENGTH = 20;
const MAX_LENGTH = 600;

// Normal-motion timeline. Each step is a distinct, visible gesture — fold,
// then the flap closes, then it's sent — rather than one blurred transition.
const FOLD_MS = 420;
const FLAP_OPEN_HOLD_MS = 60; // the flap sits visibly open before it closes
const FLAP_CLOSE_MS = 380;
const DEPART_MS = 450;
const REDUCED_MS = 220;

const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** How far the paper tips into the screen. Enough for real foreshortening on
 * the hinge, not so much that the fold looks warped. */
const FOLD_PERSPECTIVE = '1600px';

type Phase = 'writing' | 'sending' | 'folding' | 'enveloping' | 'departing' | 'revealed';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function FeedbackLetter({ name }: { name: string }) {
  const [message, setMessage] = useState('');
  const [publicConsent, setPublicConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('writing');
  const [flapClosed, setFlapClosed] = useState(false);
  const [letterHeight, setLetterHeight] = useState(420);
  const reducedMotion = usePrefersReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      scheduled.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (phase === 'revealed') headingRef.current?.focus();
  }, [phase]);

  function runDepartureSequence() {
    if (reducedMotion) {
      timers.current.push(setTimeout(() => setPhase('departing'), 10));
      timers.current.push(setTimeout(() => setPhase('revealed'), 10 + REDUCED_MS));
      return;
    }

    // Measured once, right before the paper starts moving — the fold and the
    // envelope body both need to know exactly how tall the sheet was.
    setLetterHeight(formRef.current?.getBoundingClientRect().height ?? 420);
    setFlapClosed(false);
    setPhase('folding');

    timers.current.push(setTimeout(() => setPhase('enveloping'), FOLD_MS));
    timers.current.push(
      setTimeout(() => setFlapClosed(true), FOLD_MS + FLAP_OPEN_HOLD_MS),
    );
    timers.current.push(
      setTimeout(
        () => setPhase('departing'),
        FOLD_MS + FLAP_OPEN_HOLD_MS + FLAP_CLOSE_MS,
      ),
    );
    timers.current.push(
      setTimeout(
        () => setPhase('revealed'),
        FOLD_MS + FLAP_OPEN_HOLD_MS + FLAP_CLOSE_MS + DEPART_MS,
      ),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (message.trim().length < MIN_LENGTH) {
      setError('Tell us a little more about your experience.');
      return;
    }

    setPhase('sending');
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim(), publicConsent }),
      });
      const data = await response.json().catch(() => ({}) as Record<string, unknown>);

      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not send your letter.');
        setPhase('writing');
        return;
      }

      // The animation starts only now — after the server has confirmed the
      // letter is actually stored, never before.
      runDepartureSequence();
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
      setPhase('writing');
    }
  }

  function writeAnother() {
    setMessage('');
    setPublicConsent(false);
    setError(null);
    setPhase('writing');
  }

  const sending = phase === 'sending';
  const disabled = phase !== 'writing';
  const animating = phase === 'folding' || phase === 'enveloping' || phase === 'departing';

  // The real content fades out over the first stretch of the fold — by the
  // time the hinge has rotated far enough to be visible, there is no text
  // left to look wrong mid-fold.
  const contentOpacity = phase === 'writing' || phase === 'sending' ? 1 : 0;

  const halfHeight = letterHeight / 2;
  const flapHeight = Math.max(56, halfHeight * 0.5);

  // Only "folding" needs the hinge — once it finishes, the bottom half is
  // rotated fully out of view and dropped, leaving a plain rectangle that the
  // envelope flap forms on top of.
  const hingeAngle = phase === 'folding' ? -172 : 0;

  const flapAngle = flapClosed ? 0 : -122;

  // Departure is translate + rotate + a *uniform* scale only — never a
  // non-uniform scaleX/scaleY. That distinction is what keeps the seal (and
  // now the whole envelope) from warping into an oval as it leaves.
  const departTransform =
    phase === 'departing'
      ? reducedMotion
        ? 'translateY(-8px)'
        : 'translate(32px, -64px) rotate(6deg) scale(0.9)'
      : 'none';
  const departOpacity = phase === 'departing' ? 0 : 1;
  const departTransition = reducedMotion
    ? `opacity ${REDUCED_MS}ms ease-out, transform ${REDUCED_MS}ms ease-out`
    : `transform ${DEPART_MS}ms ${EASE}, opacity ${DEPART_MS}ms ease-out`;

  const thankYouStyle: React.CSSProperties =
    phase === 'departing' || phase === 'revealed'
      ? { transform: 'none', opacity: 1 }
      : { transform: 'scale(0.96) translateY(10px)', opacity: 0 };

  const letterBody = (
    <>
      <h1 className="font-letter text-2xl font-semibold tracking-tight sm:text-3xl">
        Tell us your Cookie Notes story
      </h1>
      <p className="mt-2 font-letter text-sm text-muted-foreground sm:text-base">
        Did Cookie Notes help you prepare better, revise faster, or score higher? We&apos;d love
        to hear your story.
      </p>

      {error && (
        <Alert variant="error" className="mt-5">
          {error}
        </Alert>
      )}

      <label htmlFor="letter-message" className="sr-only">
        Your letter
      </label>
      <textarea
        id="letter-message"
        value={message}
        onChange={(event) => setMessage(event.target.value.slice(0, MAX_LENGTH))}
        disabled={disabled}
        required
        minLength={MIN_LENGTH}
        maxLength={MAX_LENGTH}
        rows={9}
        placeholder="Write your feedback here"
        aria-invalid={Boolean(error)}
        aria-describedby="letter-hint"
        className="mt-6 w-full resize-none border-0 bg-transparent font-letter text-lg leading-relaxed text-foreground caret-primary placeholder:text-muted-foreground/60 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-70 sm:text-xl"
      />
      <div className="mt-1 flex justify-end">
        <span id="letter-hint" className="text-xs text-muted-foreground">
          {message.length}/{MAX_LENGTH}
        </span>
      </div>

      <p className="mt-6 text-right font-letter text-lg italic text-foreground/80 sm:text-xl">
        — {name}
      </p>

      <label
        htmlFor="letter-consent"
        className="mt-8 flex cursor-pointer items-start gap-2.5 border-t border-border pt-6 text-sm text-foreground/90"
      >
        <input
          id="letter-consent"
          type="checkbox"
          checked={publicConsent}
          disabled={disabled}
          onChange={(event) => setPublicConsent(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <span>
          I&apos;m okay with Cookie Notes showing this feedback and my name on the website.
          <span className="mt-1 block text-xs text-muted-foreground">
            If you leave this unchecked, we&apos;ll still read it — it just won&apos;t be shown
            publicly.
          </span>
        </span>
      </label>

      <div className="mt-6 flex justify-end">
        <Button type="submit" size="lg" loading={sending} disabled={disabled}>
          {sending ? 'Sending…' : 'Send my letter'}
        </Button>
      </div>
    </>
  );

  return (
    <div className="relative grid">
      <div
        style={{ ...thankYouStyle, transition: departTransition, gridArea: '1 / 1' }}
        aria-hidden={phase !== 'revealed'}
      >
        <ThankYouCard
          headingRef={phase === 'revealed' ? headingRef : undefined}
          onWriteAnother={writeAnother}
        />
      </div>

      {/* The seal sits outside the folding/enveloping group's own transform
          chain, positioned independently. It only ever receives a uniform
          translate/rotate/scale (matching the group's departure), never the
          group's internal hinge or flap rotation — so it can never inherit a
          distorting transform, which is the fix a stretched-oval seal
          regression already taught this component once. */}
      {(phase === 'enveloping' || phase === 'departing') && (
        <div
          aria-hidden
          style={{
            gridArea: '1 / 1',
            transform: departTransform,
            opacity: departOpacity,
            transition: departTransition,
          }}
          className="pointer-events-none relative z-30"
        >
          <span
            className="absolute left-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-all duration-200 ease-out"
            style={{
              top: flapHeight * 0.62,
              opacity: flapClosed ? 1 : 0,
              transform: `translate(-50%, -50%) scale(${flapClosed ? 1 : 0.4})`,
            }}
          >
            <Cookie className="size-5" />
          </span>
        </div>
      )}

      {animating && (
        <div style={{ gridArea: '1 / 1', perspective: FOLD_PERSPECTIVE }} className="relative">
          <div
            style={{
              position: 'relative',
              transform: departTransform,
              opacity: departOpacity,
              transition: departTransition,
            }}
          >
            {/* The body — the top half of the sheet, which becomes the whole
                envelope once the bottom half has folded away. */}
            <div
              className={cn(
                'border border-border bg-card shadow-sm transition-shadow',
                phase === 'folding' ? 'rounded-t-xl border-b-0' : 'rounded-xl',
              )}
              style={{ height: halfHeight }}
            />

            {/* The hinge — the bottom half, folding up and back behind the
                body. Two faces sharing one rotation: the front is the paper
                you were just looking at, the back is blank stock. Whichever
                one is currently facing away is invisible
                (`backfaceVisibility: hidden`), so the fold reads as paper
                turning over, not a flat rectangle shrinking. */}
            {phase === 'folding' && (
              <div
                style={{
                  position: 'relative',
                  height: halfHeight,
                  transformStyle: 'preserve-3d',
                  transformOrigin: 'top center',
                  transform: `rotateX(${hingeAngle}deg)`,
                  transition: `transform ${FOLD_MS}ms ${EASE}`,
                }}
              >
                <div
                  className="absolute inset-x-0 top-0 rounded-b-xl border border-t-0 border-border bg-card"
                  style={{ height: halfHeight, backfaceVisibility: 'hidden' }}
                />
                <div
                  className="absolute inset-x-0 top-0 rounded-b-xl border border-t-0 border-border bg-muted"
                  style={{
                    height: halfHeight,
                    backfaceVisibility: 'hidden',
                    transform: 'rotateX(180deg)',
                  }}
                />
              </div>
            )}

            {/* The flap — appears once folded, swings open then closes down
                onto the body, exactly like sealing an envelope. A slightly
                darker tone than the body (not just a shared `bg-card`) plus a
                drop-shadow that follows the actual triangular silhouette —
                `clip-path` crops the box but never draws a stroke along the
                cut, so without these two cues the flap is invisible against
                a body of the same colour. */}
            {(phase === 'enveloping' || phase === 'departing') && (
              <div
                className="absolute inset-x-0 top-0 bg-muted"
                style={{
                  height: flapHeight,
                  transformStyle: 'preserve-3d',
                  transformOrigin: 'top center',
                  transform: `rotateX(${flapAngle}deg)`,
                  transition: `transform ${FLAP_CLOSE_MS}ms ${EASE}`,
                  clipPath: 'polygon(0% 0%, 100% 0%, 50% 100%)',
                  filter: 'drop-shadow(0 2px 3px rgb(0 0 0 / 0.35))',
                }}
              />
            )}
          </div>
        </div>
      )}

      {(phase === 'writing' || phase === 'sending' || phase === 'folding') && (
        <div
          style={{
            gridArea: '1 / 1',
            opacity: contentOpacity,
            transition: phase === 'folding' ? `opacity ${FOLD_MS * 0.55}ms ease-out` : undefined,
          }}
          className="relative z-10"
        >
          <form
            ref={formRef}
            onSubmit={submit}
            className="relative overflow-hidden rounded-xl border border-border bg-card px-6 py-8 shadow-sm sm:px-10 sm:py-12"
          >
            <div className={cn(sending && 'pointer-events-none')}>{letterBody}</div>
          </form>
        </div>
      )}
    </div>
  );
}
