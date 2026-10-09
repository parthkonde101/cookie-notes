'use client';

import { useEffect, useState } from 'react';
import {
  PDF_LOADING_MESSAGES,
  PDF_LOADING_TIMING,
} from '@/components/notes/loading-messages.config';
import { cn } from '@/lib/utils';

/**
 * The line of text under the reader's loading spinner.
 *
 * It rotates through `PDF_LOADING_MESSAGES`, one at a time, for as long as it is
 * mounted — and the reader mounts it only while the document is loading, so the
 * rotation begins when loading begins and ends the moment the reader is ready
 * or has failed. There is no timer that decides loading is "done": this simply
 * stops existing when the viewer stops showing its loading state, and every
 * timer it set is cleared with it. A fresh mount always starts at the first
 * message, so each document load starts clean.
 *
 * The text starts hidden for a short beat so a PDF that opens almost at once
 * never flashes a message; the spinner beside it is not affected by that.
 */
export function LoadingMessage() {
  const messages = PDF_LOADING_MESSAGES;
  const { firstDelayMs, showMs, fadeMs } = PDF_LOADING_TIMING;

  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(false);
  // How many messages have been shown, so a screen reader hears each one once
  // and is then left in peace for however long the load goes on.
  const [shownCount, setShownCount] = useState(0);

  useEffect(() => {
    if (messages.length === 0) return;

    // Only ever one timer pending, so clearing the latest one clears them all.
    let timer = 0;

    const hold = () => {
      // A single message has nothing to rotate to: it just stays.
      if (messages.length < 2) return;
      timer = window.setTimeout(() => {
        setShown(false);
        timer = window.setTimeout(() => {
          setIndex((current) => (current + 1) % messages.length);
          setShown(true);
          setShownCount((count) => count + 1);
          hold();
        }, fadeMs);
      }, showMs);
    };

    timer = window.setTimeout(() => {
      setShown(true);
      setShownCount(1);
      hold();
    }, firstDelayMs);

    return () => window.clearTimeout(timer);
  }, [messages, firstDelayMs, showMs, fadeMs]);

  if (messages.length === 0) return null;

  return (
    // The box is as tall as two lines on a phone and one from the `sm` breakpoint
    // up, so changing message never moves the spinner above it.
    <div className="flex min-h-10 w-full max-w-xs items-start justify-center sm:min-h-5 sm:max-w-md">
      <p
        aria-live={shownCount > 0 && shownCount <= messages.length ? 'polite' : 'off'}
        className={cn(
          'text-balance text-center text-sm leading-5',
          // Opacity and a very slight rise. Reduced motion keeps the soft fade
          // but drops the movement.
          'transition-[opacity,transform] duration-500 ease-out',
          shown
            ? 'translate-y-0 opacity-100'
            : 'translate-y-1 opacity-0 motion-reduce:translate-y-0',
        )}
      >
        {messages[index]}
      </p>
    </div>
  );
}
