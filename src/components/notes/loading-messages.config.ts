/**
 * The messages shown, one at a time, while a PDF is loading.
 *
 * Each entry is a single sentence and is displayed exactly as written. To add a
 * message, add a string here — the rotation picks it up with no other change.
 */
export const PDF_LOADING_MESSAGES: readonly string[] = [
  'Cookie Notes are copyrighted. Every copy is traceable.',
  'Use a laptop for best viewing experience.',
];

/** How the messages are paced, in milliseconds. */
export const PDF_LOADING_TIMING = {
  /**
   * Nothing is shown for this long, so a PDF that opens almost at once never
   * flashes a message the reader has no time to read. The spinner is not
   * delayed: it appears immediately, as it always has.
   */
  firstDelayMs: 350,
  /** How long each message stays fully visible. */
  showMs: 4000,
  /** The fade between one message and the next. Also the length of the CSS transition. */
  fadeMs: 500,
} as const;
