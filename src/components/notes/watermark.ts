export interface WatermarkIdentity {
  email: string;
  sessionRef: string;
  dateLabel: string;
}

/**
 * Paints the reader's email diagonally across a rendered page.
 *
 * ## What it is for
 *
 * Not prevention — attribution. A student is meant to read the whole unit
 * freely, which means a determined one can always photograph the screen or use
 * Safari's full-page capture. What this guarantees is that whatever comes out
 * the other end still carries the address of the account that opened it.
 *
 * ## Why it is drawn here and not in the DOM
 *
 * It is composited into the page canvas itself, in the same pixels as the
 * content, after pdf.js has finished painting. An HTML overlay would be one
 * `display: none` away from a clean copy and would not necessarily appear in a
 * canvas capture; this cannot be separated from the page without also
 * destroying the page.
 *
 * ## Weight
 *
 * Near-black at low alpha, regular weight, one line. The mark has to be legible
 * in a screenshot taken weeks later, and no heavier than that — these are
 * somebody's revision notes, and every extra gram of ink is read through.
 *
 * ## Why exactly one mark, and only the email
 *
 * Earlier this tiled two lines of identity across the whole page. That was
 * heavier to read through than it was useful: repetition only helps against
 * cropping, and someone cropping a page has already lost the content they
 * wanted. One large diagonal line survives an ordinary screenshot just as well
 * and leaves the notes legible, which is what the page is actually for.
 *
 * The line carries the email and nothing else. A name, a session reference or a
 * timestamp would add no attribution the email does not already give, and every
 * extra character is more ink over somebody's notes.
 *
 * Note this never touches the Cookie Notes branding already inside the source
 * PDFs — that is page content, rendered by pdf.js before this runs.
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  identity: WatermarkIdentity,
): void {
  const email = identity.email.trim();
  if (!email) return;

  const diagonal = Math.hypot(width, height);

  // Sized against the canvas, never the viewport: the mark is measured and
  // fitted to a fixed fraction of this page's own diagonal, so it lands the
  // same way on A4, on a wide landscape scan and on a half-height page — and
  // it stays put when the browser zooms or the render resolution is stepped
  // back for Safari's canvas limit.
  const target = diagonal * 0.62;

  ctx.save();

  const probe = 100;
  ctx.font = `400 ${probe}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const measured = ctx.measureText(email).width || 1;

  // Clamped so a very long address cannot shrink to nothing and a very short
  // one cannot grow into a billboard.
  const fontSize = Math.round(
    Math.min(Math.max((probe * target) / measured, diagonal * 0.028), diagonal * 0.085),
  );

  // Regular weight, not semibold: at this size the mark is already impossible
  // to miss, and the extra stroke width was reading as a grey slab laid over
  // the notes rather than as a line of text behind them.
  ctx.font = `400 ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // The page's own diagonal, so the mark runs corner to corner whatever the
  // aspect ratio rather than sitting at a fixed angle that only suits portrait.
  // Positive angle: top-left down to bottom-right, following the reading eye.
  ctx.translate(width / 2, height / 2);
  ctx.rotate(Math.atan2(height, width));

  // Near-black ink, laid on once.
  //
  // `multiply` behaves like ink on paper: it darkens what is under it and can
  // never brighten it, so on white paper this is the whole watermark and it
  // reads as dark text rather than as grey fog.
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(8, 8, 10, 0.10)';
  ctx.fillText(email, 0, 0);

  // The lift, for pages that are themselves near-black — dark slides, dark
  // note paper, photographed boards — where ink alone leaves nothing to read.
  //
  // On Cookie Notes this pass is not a fallback, it is the watermark: the real
  // notes are dark throughout, so the ink above barely registers and everything
  // legible comes from here. Measured against a no-watermark render of a real
  // unit, 0.05 gave a mean luminance change of 7 and did not survive a 50%
  // downscale; 0.08 gives 12 and does.
  //
  // Still deliberately weaker than the dark pass. At anything like equal
  // strength the two fight each other on white paper — the lift cancels the ink
  // and the result is a washed-out grey — so this is the number to raise if
  // dark pages ever need more, and the one to leave alone if light ones do.
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillText(email, 0, 0);

  ctx.restore();
}

/** The small, always-visible footer line under the page. */
export function watermarkCaption(identity: WatermarkIdentity): string {
  return `Licensed to ${identity.email} · Session ${identity.sessionRef} · ${identity.dateLabel}`;
}
