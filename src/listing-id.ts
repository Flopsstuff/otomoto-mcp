import { InvalidArgumentError } from './errors.ts';

/**
 * Search results expose a numeric advert id, but listing URLs embed a base62 form of it
 * (6148596129 -> "6I6SJj"). Putting the numeric id in a URL 404s, so the two must be
 * converted rather than used interchangeably.
 *
 * The slug in front of the id is cosmetic: Otomoto 301-redirects any slug to the canonical
 * one as long as the id matches, which is what lets us build a URL from an id alone.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = BigInt(ALPHABET.length);

/** Ads Otomoto carries over from OLX end in `-OLX_ID<id>.html` and are served the same way. */
const LISTING_URL_RE = /^https?:\/\/(?:www\.)?otomoto\.pl\/[^\s]*-(?:OLX_)?ID([0-9A-Za-z]+)\.html/;
const NUMERIC_RE = /^[0-9]+$/;
const BASE62_RE = /^(?:ID)?([0-9A-Za-z]+)$/;

export function encodeListingId(numericId: string | number | bigint): string {
  let value = BigInt(numericId);
  if (value < 0n) throw new InvalidArgumentError(`listing id must not be negative: ${numericId}`);
  if (value === 0n) return ALPHABET[0]!;
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % BASE)]! + out;
    value /= BASE;
  }
  return out;
}

export function decodeListingId(encoded: string): string {
  let value = 0n;
  for (const char of encoded) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new InvalidArgumentError(`not a base62 listing id: ${encoded}`);
    value = value * BASE + BigInt(digit);
  }
  return value.toString();
}

export function listingUrlFromEncodedId(encodedId: string): string {
  return `https://www.otomoto.pl/osobowe/oferta/offer-ID${encodedId}.html`;
}

/**
 * Accepts what an agent is likely to have on hand: a listing URL, the base62 id from a URL,
 * or the numeric id from a search result.
 */
export function resolveListingUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new InvalidArgumentError('listing reference must not be empty');

  if (/^https?:\/\//i.test(trimmed)) {
    const match = LISTING_URL_RE.exec(trimmed);
    if (!match || match[1] === undefined) {
      throw new InvalidArgumentError(
        `not an Otomoto listing URL (expected .../oferta/<slug>-ID<id>.html): ${trimmed}`,
      );
    }
    return trimmed;
  }

  if (NUMERIC_RE.test(trimmed)) {
    return listingUrlFromEncodedId(encodeListingId(trimmed));
  }

  const base62 = BASE62_RE.exec(trimmed);
  if (base62 && base62[1] !== undefined) {
    return listingUrlFromEncodedId(base62[1]);
  }

  throw new InvalidArgumentError(
    `cannot interpret "${trimmed}" as a listing URL, numeric id, or base62 id`,
  );
}
