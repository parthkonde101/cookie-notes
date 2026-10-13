/**
 * The footer on every page of a note or previous-year paper.
 *
 *     cookienotes.app                                   CN-7K2M9QXA · Page 3
 *
 * ## What it is for
 *
 * Not prevention — attribution. A browser cannot stop a screenshot, and this
 * does not try to; what it guarantees is that whatever comes out the other end
 * still says which account read it. The reference is opaque: it contains no
 * email, name or id, and an admin looks it up on the users page.
 *
 * ## Where it goes
 *
 * In a strip added BELOW the page, inside the same white sheet. The page itself
 * is drawn first, untouched, at the top of the canvas; the strip is extra height
 * under it. So the footer can never cover text, an equation, a diagram or the
 * page's own printed page number — wherever a PDF puts them, however narrow its
 * margins, whatever its size or orientation — and the document's own layout is
 * exactly what it was. The strip scales with the page's width, so it is the same
 * proportion on A4, on a landscape slide and on a phone, and at every zoom.
 *
 * ## Why it is drawn here and not in the DOM
 *
 * It is composited into the page canvas, in the same pixels as the page, so it
 * is part of any capture of the page and cannot be hidden with a style rule.
 *
 * ## Weight
 *
 * One line, small, mid-grey on white: readable when you look for it, ignorable
 * when you read. Switched off with NOTE_WATERMARK_ENABLED=false, in which case no
 * strip is added and the page is exactly as the PDF has it.
 */

export interface WatermarkIdentity {
  /** The opaque account reference, e.g. `CN-7K2M9QXA`. */
  reference: string;
}

/** The strip's height as a fraction of the page's width (about 25 px on a 780 px page). */
const STRIP_FRACTION = 0.032;
/** ...but never thinner than this many CSS pixels, so the text stays legible on a phone. */
const MIN_STRIP_CSS_PX = 20;
const SITE = 'cookienotes.app';

/**
 * Extra canvas height, in canvas pixels, that the footer needs for a page this wide.
 *
 * `density` is canvas pixels per CSS pixel (the device pixel ratio, after any
 * resolution step-back), so the minimum is a real, readable size on every screen.
 */
export function footerHeight(pageWidth: number, density = 1): number {
  return Math.max(Math.round(MIN_STRIP_CSS_PX * density), Math.round(pageWidth * STRIP_FRACTION));
}

/** The same fraction, for sizing a page before its width is known in pixels. */
export const FOOTER_FRACTION = STRIP_FRACTION;

/**
 * Draws the footer into the strip under a page.
 *
 * @param pageHeight the height of the PDF page itself — the strip starts here
 * @param density    canvas pixels per CSS pixel; see `footerHeight`
 */
export function drawFooter(
  ctx: CanvasRenderingContext2D,
  pageWidth: number,
  pageHeight: number,
  identity: WatermarkIdentity,
  pageNumber: number,
  density = 1,
): void {
  const strip = footerHeight(pageWidth, density);
  const reference = identity.reference.trim();
  if (!reference) return;

  const fontPx = Math.max(Math.round(8 * density), Math.round(strip * 0.44));
  const margin = Math.round(Math.max(strip * 0.9, pageWidth * 0.04));
  const middle = pageHeight + strip / 2;

  ctx.save();
  // A hairline between the page and its footer, so a page whose content runs to the
  // edge still reads as a page followed by a footer.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
  ctx.fillRect(margin, pageHeight, pageWidth - margin * 2, Math.max(1, Math.round(strip * 0.04)));

  ctx.font = `${fontPx}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = '#8a8a8a';
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'left';
  ctx.fillText(SITE, margin, middle);

  ctx.textAlign = 'right';
  ctx.fillText(`${reference} · Page ${pageNumber}`, pageWidth - margin, middle);
  ctx.restore();
}
