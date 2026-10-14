/**
 * The footer printed on every page of a note or previous-year paper.
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
 * ## It is printed on the page, in the page's own units
 *
 * The footer is drawn into the page's canvas after pdf.js has finished painting,
 * so it is part of the page's pixels: it takes no space, adds no height and cannot
 * be removed with a style rule. And it is laid out in the PAGE'S coordinates —
 * PDF units (points, 1/72 in), measured from the page's own edges — never in
 * screen pixels. Its font size, padding and position are functions of the page's
 * width and height alone.
 *
 * The raster resolution is a separate thing. pdf.js paints the page at some scale
 * (zoom × the width available × the device's pixel ratio, stepped back for the
 * browser's canvas limit); `drawFooter` is given that same scale and draws under
 * the same transform, exactly as pdf.js does for the page's own content. So at 50%
 * zoom the footer is half the size of the footer at 100%, at 175% it is 1.75 times,
 * and in every case it occupies the same place relative to the page. Nothing about
 * it — size, position, which pieces are shown — depends on the zoom.
 *
 * It is small and semi-transparent grey with no background, so it reads like a
 * printed footer and stays out of the way of the notes; where it overlaps a
 * document's own marks it is faint enough to leave them readable.
 *
 * ## Respecting the margin line — by format, not by inspecting each page
 *
 * Cookie Notes' notes all share one format: dark ruled pages with a red margin line
 * down the left, always at the same place. The left text must start to the right of
 * that line, so its position is a constant of the format (`NOTEBOOK_MARGIN_FRACTION`),
 * not something worked out per page: nothing is rendered twice, nothing is read back
 * from the canvas, and the footer costs two text calls. The same goes for the ink,
 * chosen for the format's dark pages (`NOTEBOOK_IS_DARK`). If the format ever
 * changes, change those two constants; `drawFooter` also accepts them as overrides.
 *
 * Switched off with NOTE_WATERMARK_ENABLED=false, in which case nothing is drawn.
 */

export interface WatermarkIdentity {
  /** The opaque account reference, e.g. `CN-7K2M9QXA`. */
  reference: string;
}

const SITE = 'cookienotes.app';
const FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Footer text size as a fraction of the page's width (about 11 pt on A4)… */
const FONT_FRACTION = 0.019;
/** …kept between these many page units so it is neither lost on a small page nor loud on a big one. */
const MIN_FONT = 8;
const MAX_FONT = 16;
/** Distance from the bottom edge (and the left, with no margin line), as a fraction of the page's width (never less than MIN_PAD). */
const PAD_FRACTION = 0.015;
const MIN_PAD = 6;
/** Distance from the right edge — more room than the bottom, so the page number is not crowded against the edge. */
const RIGHT_PAD_FRACTION = 0.03;
const MIN_RIGHT_PAD = 10;
/** Clear space between a margin line and the left text, and between the two texts. */
const MARGIN_GAP_FRACTION = 0.012;
const TEXT_GAP_FRACTION = 0.024;
/** The text is grey at 50% opacity: a quiet printed footer, not a stamp. */
const INK = 'rgba(55, 55, 55, 0.5)';
/** The same quiet footer on a dark page, where dark grey would vanish: light grey, same opacity. */
const INK_ON_DARK = 'rgba(225, 225, 225, 0.5)';

/**
 * The notes' format: where the right-hand edge of the red margin line is, as a fraction of
 * the page's width. Measured across the notes (it is 14.1–14.2% on every one).
 */
export const NOTEBOOK_MARGIN_FRACTION = 0.1425;
/** The notes' pages are dark, so the footer uses the light ink. */
export const NOTEBOOK_IS_DARK = true;

/** The footer's geometry, entirely in page units measured from the page's top-left corner. */
export interface FooterLayout {
  /** Text size. */
  fontSize: number;
  /** y of the text's baseline. */
  baseline: number;
  /** x of the right text's right edge. */
  rightX: number;
  right: string;
  /** x of the left text's left edge, or null if the page is too narrow to hold both texts. */
  leftX: number | null;
  left: string;
}

/**
 * Where everything goes, in page units. It depends only on the page's size, the
 * margin line (also in page units) and the text — never on the zoom or the
 * resolution — so it is identical at every scale.
 *
 * @param measure text width in page units at a given font size
 * @param marginRight x of the right edge of a red margin line, or null if the page has none
 */
export function layoutFooter(
  pageWidth: number,
  pageHeight: number,
  right: string,
  marginRight: number | null,
  measure: (text: string, fontSize: number) => number,
): FooterLayout {
  const pad = Math.max(MIN_PAD, pageWidth * PAD_FRACTION);
  const fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, pageWidth * FONT_FRACTION));
  const rightX = pageWidth - Math.max(MIN_RIGHT_PAD, pageWidth * RIGHT_PAD_FRACTION);
  const rightWidth = measure(right, fontSize);
  const leftWidth = measure(SITE, fontSize);

  // The left text starts at the ordinary padding — or just beyond a margin line, if the page has one.
  const start = Math.max(pad, marginRight === null ? 0 : marginRight + Math.max(MIN_PAD, pageWidth * MARGIN_GAP_FRACTION));
  // If both do not fit side by side, the left one is dropped rather than laid over the right one.
  const fits = start + leftWidth + pageWidth * TEXT_GAP_FRACTION <= rightX - rightWidth;

  return { fontSize, baseline: pageHeight - pad, rightX, right, leftX: fits ? start : null, left: SITE };
}

/**
 * Draws the footer onto a page canvas, along the page's bottom edge.
 *
 * @param pageWidth  the page's width in PDF units (`getViewport({ scale: 1 }).width`)
 * @param pageHeight the page's height in PDF units
 * @param scale      canvas pixels per PDF unit — the viewport scale the page itself was rendered with
 * @param marginRight x (PDF units) of the right edge of a red margin line, or null for none;
 *                    by default the notes' format (`NOTEBOOK_MARGIN_FRACTION` of the page width)
 * @param dark       use light ink for a dark page; by default the notes' format (`NOTEBOOK_IS_DARK`)
 */
export function drawFooter(
  ctx: CanvasRenderingContext2D,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  identity: WatermarkIdentity,
  pageNumber: number,
  marginRight: number | null = pageWidth * NOTEBOOK_MARGIN_FRACTION,
  dark: boolean = NOTEBOOK_IS_DARK,
): void {
  const reference = identity.reference.trim();
  if (!reference || !(pageWidth > 0) || !(pageHeight > 0) || !(scale > 0)) return;

  ctx.save();
  try {
    // The same transform pdf.js paints the page with: from here on, one unit is one PDF unit.
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Text is measured at its page-unit size, so the answer — and the layout — is the same at every scale.
    const measure = (text: string, fontSize: number) => {
      ctx.font = `${fontSize}px ${FONT_FAMILY}`;
      return ctx.measureText(text).width;
    };
    const layout = layoutFooter(pageWidth, pageHeight, `${reference} · Page ${pageNumber}`, marginRight, measure);

    ctx.fillStyle = dark ? INK_ON_DARK : INK;
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${layout.fontSize}px ${FONT_FAMILY}`;
    ctx.textAlign = 'right';
    ctx.fillText(layout.right, layout.rightX, layout.baseline);
    if (layout.leftX !== null) {
      ctx.textAlign = 'left';
      ctx.fillText(layout.left, layout.leftX, layout.baseline);
    }
  } finally {
    ctx.restore();
  }
}
