/**
 * Money, in one place.
 *
 * Every amount in the commerce system is an INTEGER NUMBER OF PAISE (minor units),
 * never a float. Rupees appear only at the edges: parsing what an admin typed, and
 * formatting what a student sees. No server code ever multiplies a user-supplied
 * float by 100.
 *
 * This file has no server-only imports, so the checkout UI, the admin forms and the
 * tests all use exactly the same rules as the server.
 */

export const CURRENCY = 'INR' as const;

/** Razorpay's minimum order is ₹1.00. */
export const MIN_PRICE_MINOR = 100;
/** ₹50,000 — a ceiling that catches a mistyped extra zero without getting in the way. */
export const MAX_PRICE_MINOR = 5_000_000;

export type PriceCheck = { ok: true; minor: number } | { ok: false; error: string };

/**
 * Turns what an admin typed ("499", "499.50", "₹1,499") into paise, or says why
 * not. Strict on purpose: more than two decimals, a sign, an exponent, text, zero
 * and out-of-range values are all refused rather than rounded into something the
 * admin did not mean.
 */
export function parsePriceInput(raw: unknown): PriceCheck {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: 'Enter a valid price.' };
    return checkMinor(roundRupeesToMinor(raw));
  }
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a price.' };

  const cleaned = raw.trim().replace(/^₹\s*/, '').replace(/,/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter a price.' };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, error: 'Enter the price in rupees, for example 499 or 499.50.' };
  }
  const [whole, fraction = ''] = cleaned.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return checkMinor(minor);
}

function roundRupeesToMinor(rupees: number): number {
  // Round to the nearest paisa; refuse anything that is not already a paisa value.
  const minor = Math.round(rupees * 100);
  return Math.abs(minor - rupees * 100) < 1e-6 ? minor : Number.NaN;
}

/** The range check every paid product shares. */
export function checkMinor(minor: number): PriceCheck {
  if (!Number.isInteger(minor) || minor <= 0) {
    return { ok: false, error: 'Enter a price greater than zero, with at most two decimals.' };
  }
  if (minor < MIN_PRICE_MINOR) return { ok: false, error: 'The minimum price is ₹1.' };
  if (minor > MAX_PRICE_MINOR) return { ok: false, error: 'The maximum price is ₹50,000.' };
  return { ok: true, minor };
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const inrWithPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹1,499 — and ₹1,499.50 when there are paise. Always the Indian digit grouping. */
export function formatInr(minor: number): string {
  if (!Number.isFinite(minor)) return '—';
  return minor % 100 === 0 ? inr.format(minor / 100) : inrWithPaise.format(minor / 100);
}

/** The value for an `<input>`: "499" or "499.5", no symbol, no grouping. */
export function minorToInputValue(minor: number): string {
  if (!Number.isFinite(minor) || minor <= 0) return '';
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

export interface PricedNote {
  priceMinor: number;
  /** Whether the note is for sale at that price. Only for-sale notes count in a comparison. */
  isPaid: boolean;
}

/**
 * What a bundle saves compared with buying its notes one by one — or `null` when
 * there is no honest comparison to show.
 *
 * Only notes that are actually for sale are counted, because a free note costs
 * nothing separately and a legacy price on a note that is not for sale is not a
 * price anyone could pay. The comparison needs at least two for-sale notes, and the
 * bundle must genuinely be cheaper; otherwise nothing is shown. There is no crossed-out
 * "was" price anywhere: this is a plain difference of two real numbers.
 */
export function bundleSavings(
  bundlePriceMinor: number,
  notes: PricedNote[],
): { separateMinor: number; savingsMinor: number; percent: number } | null {
  const forSale = notes.filter((note) => note.isPaid && note.priceMinor > 0);
  if (forSale.length < 2) return null;
  const separateMinor = forSale.reduce((total, note) => total + note.priceMinor, 0);
  const savingsMinor = separateMinor - bundlePriceMinor;
  if (savingsMinor <= 0) return null;
  return {
    separateMinor,
    savingsMinor,
    percent: Math.round((savingsMinor / separateMinor) * 100),
  };
}
