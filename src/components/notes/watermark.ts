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
  ctx.font = `600 ${probe}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const measured = ctx.measureText(email).width || 1;

  // Clamped so a very long address cannot shrink to nothing and a very short
  // one cannot grow into a billboard.
  const fontSize = Math.round(
    Math.min(Math.max((probe * target) / measured, diagonal * 0.028), diagonal * 0.085),
  );

  ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // The page's own diagonal, so the mark rises corner to corner whatever the
  // aspect ratio rather than sitting at a fixed angle that only suits portrait.
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.atan2(height, width));

  // Two passes, because one is not enough to be sure it survives.
  //
  // `multiply` darkens — it shows on the white paper that makes up most of a
  // page, and disappears over black. `screen` lightens — the exact inverse. Run
  // both and the address is visible over body text, over a dark diagram and
  // over a photographed slide alike, while neither pass can wash out the
  // content underneath at these alphas.
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(41, 37, 46, 0.13)';
  ctx.fillText(email, 0, 0);

  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fillText(email, 0, 0);

  ctx.restore();
}

/** The small, always-visible footer line under the page. */
export function watermarkCaption(identity: WatermarkIdentity): string {
  return `Licensed to ${identity.email} · Session ${identity.sessionRef} · ${identity.dateLabel}`;
}
