/**
 * Deliberately narrow: `<` also shows up in prose ("cena < 50000"), and a greedy tag pattern
 * would eat everything up to the next `>` somewhere later in the text.
 */
const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Matched by shape, not by digit count. A count-based rule treats ` - ` as a separator and so
 * joins the unrelated figures of a spec line ("Cena 248 000 PLN - 2017 - 117 804 km") into one
 * long "number" that clears any threshold - and takes the year and the mileage with it.
 *
 * So: one separator character between groups, and only the groupings Polish numbers are
 * actually written in. `.` is not a separator here; it belongs to `2.0 TDI` and to grosze.
 */
const PHONE_GROUPINGS = [
  String.raw`\(\d{2}\)[ \-]?\d{3}[ \-]\d{2}[ \-]\d{2}`,
  String.raw`\(\d{2}\)[ \-]?\d{7}`,
  String.raw`\d{3}[ \-]\d{3}[ \-]\d{3}`,
  String.raw`\d{3}[ \-]\d{2}[ \-]\d{2}[ \-]\d{2}`,
  String.raw`\d{2}[ \-]\d{3}[ \-]\d{2}[ \-]\d{2}`,
  String.raw`\d{3}[ \-]\d{6}`,
  String.raw`\d{2}[ \-]\d{7}`,
];
const PHONE_RE = new RegExp(
  String.raw`(?<!\d)(?:(?:\+|00)\s?48[ \-]?)?(?:${PHONE_GROUPINGS.join('|')})(?!\d)`,
  'g',
);

/** A contiguous block needs a signal of its own, because its shape says nothing. */
const PHONE_WITH_COUNTRY_CODE_RE = /(?<![\d+])(?:\+|00)\s?48[ \-]?\d{9}(?!\d)/g;
/**
 * Nine digits are an offer number as often as a phone ("Numer oferty 123456789"), so the
 * seller's own label is what distinguishes them. Behind a label the grouping no longer has to
 * look Polish: `.` and `/` are separators here, and any grouping counts, because a seller who
 * writes "tel." in front of nine digits has settled what they are.
 */
const LABELLED_PHONE_RE =
  /(?<=\b(?:tel|telefon|kom|mob|mobile|gsm|phone|whatsapp)\b[.:\s]{0,3})(?:\d[ \-./]?){8}\d(?!\d)/gi;

export const CONTACT_PLACEHOLDER = '[contact details removed]';

/**
 * Ad text arrives with HTML entities in it, and a number written `601&nbsp;234&nbsp;567` - how
 * editors keep a phone number on one line - has no plain space for the patterns above to see.
 * Entities are decoded and every space-like character becomes a plain space before any contact
 * pattern runs. Only the entities ad text was seen to use are named; numeric ones are general.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '–',
  mdash: '—',
  hellip: '…',
};
const ENTITY_RE = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi;
/** No-break, narrow no-break, figure, thin, hair and the other fixed-width spaces. */
const SPACE_LIKE_RE = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (entity, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const codePoint = decimal !== undefined ? Number(decimal) : Number.parseInt(hex!, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

export interface SellerTextOptions {
  /** Replace phone numbers and e-mail addresses with CONTACT_PLACEHOLDER. Off by default. */
  redactContacts?: boolean;
}

/**
 * Seller-authored text as plain text: HTML tags and Otomoto's own `<span phoneNumber="<token>">`
 * markup dropped, entities decoded, spacing tidied.
 *
 * A number or address the seller typed into their own ad is there because they want buyers to
 * use it, so by default it is passed through. `redactContacts` removes them for deployments
 * whose output should carry no personal contact details (OTOMOTO_MCP_REDACT_CONTACTS).
 */
export function sanitizeSellerText(raw: unknown, options: SellerTextOptions = {}): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let text = decodeEntities(raw.replace(HTML_TAG_RE, ' ')).replace(SPACE_LIKE_RE, ' ');
  if (options.redactContacts === true) {
    text = text
      .replace(EMAIL_RE, CONTACT_PLACEHOLDER)
      .replace(PHONE_RE, CONTACT_PLACEHOLDER)
      .replace(PHONE_WITH_COUNTRY_CODE_RE, CONTACT_PLACEHOLDER)
      .replace(LABELLED_PHONE_RE, CONTACT_PLACEHOLDER);
  }
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
  return text === '' ? null : text;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * OTOMOTO_MCP_REDACT_CONTACTS. A value that is neither on nor off stops the server rather than
 * guessing: a typo here would otherwise decide silently whether phone numbers go out.
 */
export function redactContactsFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OTOMOTO_MCP_REDACT_CONTACTS'];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(
    `OTOMOTO_MCP_REDACT_CONTACTS must be one of 1/true/yes/on or 0/false/no/off, got "${raw}"`,
  );
}
