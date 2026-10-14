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
 * ## Respecting a margin line
 *
 * Many notes are drawn on ruled paper with a red margin line down the left. The
 * left text must start to the right of that line, so the page is probed for one
 * (see `findMarginLine`) — once per page, at a fixed resolution, so the answer
 * does not depend on the zoom — and the text is placed just beyond it, in page
 * units. If there is no line the text starts at the ordinary left padding.
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
/** The same quiet footer on a dark page (a dark-mode notebook), where dark grey would vanish: light grey, same opacity. */
const INK_ON_DARK = 'rgba(225, 225, 225, 0.5)';
/** A page whose bottom edge averages darker than this (0–255) is a dark page. */
const DARK_PAGE_LUMINANCE = 110;

/** The width, in canvas pixels, the page is rendered at to look for a margin line. The same for every zoom. */
export const MARGIN_PROBE_WIDTH = 800;
/** How far into the page, from the left, a margin line is looked for. */
const MARGIN_SEARCH_FRACTION = 0.35;
/** A column is a line when this share of the scanned rows is red in it. */
const LINE_COVERAGE = 0.6;
/** A "line" wider than this share of the page is a block of colour, not a margin line. */
const MAX_LINE_FRACTION = 0.0175;
/** Cap on the pixels read back while looking, so a very large canvas stays cheap. */
const MAX_SCAN_PIXELS = 1_500_000;

/**
 * Red-dominant, whatever the brightness: a margin line is bright red on white paper,
 * but on a dark page (a dark-mode notebook) it is a dim red such as #63262C, and a
 * hairline anti-aliased toward its background is a washed-out one. What they share is
 * that red clearly leads the other channels — by a margin and by a ratio — which plain
 * paper, ruled lines, pencil and ink (all neutral or blue-ish) never do.
 */
function isRed(r: number, g: number, b: number): boolean {
  const other = Math.max(g, b);
  return r >= 60 && r - other >= 22 && r >= other * 1.25;
}

/**
 * Where a red vertical margin line runs down the left of a rendered page, as the x
 * coordinate (in that canvas's pixels) of its RIGHT-hand edge — or null if there is none.
 *
 * It reads the rendered page rather than guessing from the PDF: it takes a band of
 * rows through the middle of the page and looks, in the left part of it, for a column
 * that is red from top to bottom of the band. Text crossing the line does not hide it
 * (coverage only has to be 60%), a double line yields its outer edge, and a wide block
 * of red is ignored as colour, not a margin. If the canvas cannot be read, there is no
 * line as far as we can tell.
 */
export function findMarginLine(ctx: CanvasRenderingContext2D, width: number, height: number): number | null {
  const regionWidth = Math.floor(width * MARGIN_SEARCH_FRACTION);
  if (regionWidth < 4 || height < 8 || typeof ctx.getImageData !== 'function') return null;

  const bandHeight = Math.min(Math.floor(height * 0.76), Math.max(40, Math.floor(MAX_SCAN_PIXELS / regionWidth)));
  const top = Math.floor((height - bandHeight) / 2);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, top, regionWidth, bandHeight).data;
  } catch {
    return null;
  }

  const needed = Math.ceil(bandHeight * LINE_COVERAGE);
  const maxColumns = Math.max(4, Math.round(width * MAX_LINE_FRACTION));
  let rightmost = -1;
  let columns = 0;
  for (let x = 0; x < regionWidth; x += 1) {
    let hits = 0;
    for (let y = 0; y < bandHeight; y += 1) {
      const i = (y * regionWidth + x) * 4;
      if (isRed(data[i], data[i + 1], data[i + 2])) hits += 1;
    }
    if (hits >= needed) {
      rightmost = x;
      columns += 1;
    }
  }
  if (rightmost < 0 || columns > maxColumns) return null;
  return rightmost + 1;
}

/**
 * Whether the page is dark along its bottom edge, where the footer goes — so the
 * footer can use ink that shows against it. Reads the bottom tenth of the rendered
 * page; if the canvas cannot be read the page is assumed light.
 */
export function pageIsDark(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  if (width < 4 || height < 10 || typeof ctx.getImageData !== 'function') return false;
  const band = Math.max(2, Math.floor(height * 0.1));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, height - band, width, band).data;
  } catch {
    return false;
  }
  let sum = 0;
  let count = 0;
  // Every 3rd pixel is plenty for an average.
  for (let i = 0; i < data.length; i += 12) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count += 1;
  }
  return count > 0 && sum / count < DARK_PAGE_LUMINANCE;
}

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
 * @param marginRight x (PDF units) of the right edge of a red margin line on this page, or null
 * @param dark       the page is dark along its bottom edge, so the footer uses light ink
 */
export function drawFooter(
  ctx: CanvasRenderingContext2D,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  identity: WatermarkIdentity,
  pageNumber: number,
  marginRight: number | null = null,
  dark = false,
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
