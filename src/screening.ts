import type { Listing, ListingDetail } from './types.ts';

/**
 * Telling ads that are not a car for sale from ones that are.
 *
 * Two kinds were found filling real result pages, and Otomoto marks neither:
 *
 * - **lease_transfer** - someone handing over a lease or long-term rental ("cesja leasingu").
 *   The price is sometimes the car's, sometimes a monthly instalment (1 784 PLN for a 2022
 *   Corolla), which is also what wrecks the minimum of a price sample. Otomoto's own
 *   `leasing_concession` checkbox was measured and does not help: it misses most of them,
 *   catches ordinary sales, and cannot be used to exclude.
 * - **import_to_order** - an import broker advertising a car it does not have ("oferta
 *   poglądowa, dotyczy sprowadzenia takiego modelu w dowolnej specyfikacji", "przykładowa
 *   licytacja w USA"). The giveaway is only in the full description, never in the search row,
 *   and not in every description either: each salesperson writes their own, and one broker
 *   showed it in 13 of 26 ads. So several ads per dealer are read, and one that shows it
 *   settles every ad of that dealer.
 *
 * Every verdict carries the text that produced it. Nothing is excluded without a reason a
 * caller can read and disagree with.
 */

export const SCREEN_KINDS = ['lease_transfer', 'import_to_order'] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

export interface ListingFlag {
  kind: ScreenKind | 'excluded_seller';
  /** Where the evidence came from. `seller` means another ad of the same dealer. */
  source: 'title' | 'shortDescription' | 'description' | 'price' | 'seller';
  evidence: string;
}

export type ScreenedListing = Listing & { flags: ListingFlag[] };

export interface ScreenOptions {
  exclude: readonly ScreenKind[];
  excludeSellerIds: readonly string[];
  verifySellers: boolean;
}

export const DEFAULT_SCREEN_OPTIONS: ScreenOptions = {
  exclude: SCREEN_KINDS,
  excludeSellerIds: [],
  verifySellers: true,
};

/**
 * Ads read per dealer before it is called clean. With half of a broker's ads showing it, four
 * reads miss it about one time in sixteen; one read missed it every other time.
 */
export const SELLER_SAMPLE_SIZE = 4;

/** Each read is a full listing page (~1.5 MB, one paced request). */
export const MAX_LISTING_READS_PER_CALL = 16;

/**
 * A price this low on a car this young is an instalment or a transfer fee, not a price. A
 * write-off can get close, which is why the evidence says what was compared.
 */
const INSTALMENT_PRICE_CEILING = 12_000;
const INSTALMENT_MAX_AGE_YEARS = 5;

interface Pattern {
  kind: ScreenKind;
  re: RegExp;
}

/**
 * Patterns run on lowercased text with Polish diacritics removed (`przejęcie` is matched as
 * `przejecie`). Each one is narrow on purpose; the list of what must not match is in the tests.
 */
const LEASE_TRANSFER: RegExp[] = [
  /\bcesj\w*\s+(?:umowy\s+)?(?:leasing|najm|wynajm)/,
  /\b(?:przejeci|przejmi|odstapi|oddam)\w*\b[^.!?\n]{0,40}\b(?:leasing|najm|najem|wynajm)/,
  /\b(?:leasing|najm|najem|wynajm)\w*\b[^.!?\n]{0,40}\b(?:do przejecia|przejeci\w*|odstapi\w*)/,
  /\bodstepne\w*/,
];

/**
 * A title or teaser is about the ad itself, so a bare "cesja" there is enough - unless it is
 * the warranty or the insurance being assigned, which dealers do advertise.
 */
const LEASE_TRANSFER_ROW_ONLY: RegExp[] = [/\bcesj\w*\b(?!\s+(?:gwarancj|polis|ubezpiecz))/];

/**
 * What the ad says about itself comes first, so that is what the evidence quotes; what the
 * dealer says about its business (it also sources to order) comes after.
 */
const IMPORT_TO_ORDER: RegExp[] = [
  /\boferta poglado\w*/,
  /\bogloszeni\w*\s+pogladow/,
  /\bprzyklad\w*\s+(?:ofert\w*\s+)?(?:licytacj|aukcj)/,
  /\bofert\w*\s+licytacj/,
  /\bszacunkow\w*\s+koszt/,
  /\bcen[aeyi]?\b[^.,!?\n]{0,20}\bcharakter\w*\s+(?:\w+\s+){0,4}poglado/,
  /\bw dowolnej (?:specyfikacji|konfiguracji|wersji)/,
  /\bdo sprowadzenia\b/,
  /\buslug\w* sprowadz\w*/,
  /\bsprowadz\w*[^.!?\n]{0,60}\b(?:na|pod) (?:zamowienie|wymagania|indywidualne)/,
  /\b(?:sprowadzimy|sprowadze)\b/,
];

const ROW_PATTERNS: Pattern[] = [
  ...[...LEASE_TRANSFER, ...LEASE_TRANSFER_ROW_ONLY].map((re) => ({ kind: 'lease_transfer' as const, re })),
  ...IMPORT_TO_ORDER.map((re) => ({ kind: 'import_to_order' as const, re })),
];

const DESCRIPTION_PATTERNS: Pattern[] = [
  ...LEASE_TRANSFER.map((re) => ({ kind: 'lease_transfer' as const, re })),
  ...IMPORT_TO_ORDER.map((re) => ({ kind: 'import_to_order' as const, re })),
];

/**
 * Lowercased, `ł` to `l`, diacritics stripped - one output character per input character, so
 * a match position in the folded text is the same position in the original.
 */
function fold(text: string): string {
  let out = '';
  for (const char of text) {
    const folded = char.toLowerCase().replace('ł', 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += folded.length === 1 ? folded : ' ';
  }
  return out;
}

function snippet(original: string, start: number, end: number): string {
  const chars = [...original];
  const from = Math.max(0, start - 30);
  const to = Math.min(chars.length, end + 30);
  const body = chars.slice(from, to).join('').replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < chars.length ? '…' : ''}`;
}

/** Every kind the text shows, with the first piece of text that showed it. */
export function findInText(
  text: string | null,
  source: ListingFlag['source'],
  patterns: Pattern[] = DESCRIPTION_PATTERNS,
): ListingFlag[] {
  if (text === null || text === '') return [];
  const folded = fold(text);
  const out: ListingFlag[] = [];
  for (const pattern of patterns) {
    if (out.some((flag) => flag.kind === pattern.kind)) continue;
    const match = pattern.re.exec(folded);
    if (match === null) continue;
    out.push({
      kind: pattern.kind,
      source,
      evidence: `«${snippet(text, match.index, match.index + match[0].length)}»`,
    });
  }
  return out;
}

/** What a search row shows on its own, at no cost. */
export function flagSearchRow(listing: Listing, now = new Date()): ListingFlag[] {
  const flags = [
    ...findInText(listing.title, 'title', ROW_PATTERNS),
    ...findInText(listing.shortDescription, 'shortDescription', ROW_PATTERNS),
  ];
  const { price, year } = listing;
  if (
    price !== null &&
    year !== null &&
    price < INSTALMENT_PRICE_CEILING &&
    year >= now.getFullYear() - INSTALMENT_MAX_AGE_YEARS
  ) {
    flags.push({
      kind: 'lease_transfer',
      source: 'price',
      evidence:
        `${price} PLN for a ${year} car reads as an instalment or a transfer fee ` +
        `(under ${INSTALMENT_PRICE_CEILING} PLN at ${INSTALMENT_MAX_AGE_YEARS} years or younger)`,
    });
  }
  return dedupe(flags);
}

/** What a full listing page shows. */
export function flagListingDetail(detail: ListingDetail): ListingFlag[] {
  return dedupe([
    ...findInText(detail.title, 'title', ROW_PATTERNS),
    ...findInText(detail.description, 'description'),
  ]);
}

function dedupe(flags: ListingFlag[]): ListingFlag[] {
  const seen = new Set<string>();
  return flags.filter((flag) => {
    if (seen.has(flag.kind)) return false;
    seen.add(flag.kind);
    return true;
  });
}

export interface SellerCheck {
  sellerId: string;
  sellerName: string | null;
  /** Listings whose descriptions were read, in this call and earlier ones. */
  listingsRead: string[];
  importToOrder: boolean;
  /** The listing that showed it, when one did. */
  evidenceListingId: string | null;
  evidence: string | null;
  /**
   * True when the verdict stands: a listing showed it, SELLER_SAMPLE_SIZE were read, or every
   * row of this dealer in the result was read. False means a clean verdict on a short sample.
   */
  sampleComplete: boolean;
  /** Why the sample is short, when it is. */
  incompleteReason?: string;
  /** True when the verdict came from earlier reads, at no cost in this call. */
  cached: boolean;
}

/**
 * Excluded rows, one entry per reason. A verdict about a dealer is stated once with every
 * listing it removed under it - a broker can fill twenty rows with one boilerplate, and
 * repeating the quote twenty times is noise an agent pays for. A row excluded on its own text
 * or price is an entry of its own.
 */
export interface ExcludedGroup {
  kind: ScreenKind | 'excluded_seller';
  source: ListingFlag['source'];
  evidence: string;
  /** Set when the verdict is about the seller, and so covers every listing in the group. */
  seller: { id: string; name: string | null } | null;
  listings: { id: string; title: string }[];
}

export interface ScreenReport {
  exclude: ScreenKind[];
  /** Rows dropped, across all groups. */
  excludedCount: number;
  excluded: ExcludedGroup[];
  sellerChecks: SellerCheck[];
  /** Dealers on the page none of whose ads were read, and why. Their rows are judged on row text alone. */
  sellersNotChecked: { sellerId: string; sellerName: string | null; reason: string }[];
}

/**
 * How many listing reads a tool call may still spend. One object is shared across the pages a
 * single call reads, so three pages of statistics cost no more reads than one page of search.
 */
export interface CheckBudget {
  remaining: number;
}

export function newCheckBudget(): CheckBudget {
  return { remaining: MAX_LISTING_READS_PER_CALL };
}

export interface ScreenResult {
  kept: ScreenedListing[];
  report: ScreenReport;
}

type Verdict = Omit<SellerCheck, 'sampleComplete' | 'incompleteReason' | 'cached'>;

interface DealerRound {
  sellerId: string;
  rows: ScreenedListing[];
  verdict: Verdict;
  readsNow: number;
  failure: string | null;
  outOfBudget: boolean;
}

/**
 * Holds what it has learned about dealers for the life of the process, so the second page of
 * a search - or the next search in the same area - costs nothing for a dealer already settled,
 * and a dealer read once on page 1 gets its next reads from page 2's rows.
 */
export class Screener {
  private readonly verdicts = new Map<string, Verdict>();
  private readonly fetchListing: (url: string) => Promise<ListingDetail>;

  constructor(fetchListing: (url: string) => Promise<ListingDetail>) {
    this.fetchListing = fetchListing;
  }

  async screen(
    listings: Listing[],
    options: ScreenOptions,
    budget: CheckBudget = newCheckBudget(),
  ): Promise<ScreenResult> {
    const rows: ScreenedListing[] = listings.map((listing) => ({ ...listing, flags: flagSearchRow(listing) }));
    const excludedSellers = new Set(options.excludeSellerIds);
    const sellerChecks: SellerCheck[] = [];
    const sellersNotChecked: ScreenReport['sellersNotChecked'] = [];

    if (options.verifySellers) {
      const dealers = dealersByShare(rows, excludedSellers).map(
        ([sellerId, sellerRows]): DealerRound => ({
          sellerId,
          rows: sellerRows,
          verdict: this.verdicts.get(sellerId) ?? {
            sellerId,
            sellerName: sellerRows[0]!.seller.name,
            listingsRead: [],
            importToOrder: false,
            evidenceListingId: null,
            evidence: null,
          },
          readsNow: 0,
          failure: null,
          outOfBudget: false,
        }),
      );
      await this.sample(dealers, budget);

      for (const dealer of dealers) {
        const { verdict } = dealer;
        if (verdict.listingsRead.length === 0) {
          sellersNotChecked.push({
            sellerId: dealer.sellerId,
            sellerName: verdict.sellerName,
            reason: dealer.failure ?? `over the limit of ${MAX_LISTING_READS_PER_CALL} listing reads per call`,
          });
          continue;
        }
        const complete =
          verdict.importToOrder ||
          verdict.listingsRead.length >= SELLER_SAMPLE_SIZE ||
          dealer.rows.every((row) => verdict.listingsRead.includes(row.id));
        const reason = complete
          ? undefined
          : (dealer.failure ??
            (dealer.outOfBudget ? `over the limit of ${MAX_LISTING_READS_PER_CALL} listing reads per call` : undefined));
        sellerChecks.push({
          ...verdict,
          listingsRead: [...verdict.listingsRead],
          sampleComplete: complete,
          ...(reason !== undefined ? { incompleteReason: reason } : {}),
          cached: dealer.readsNow === 0,
        });
        if (verdict.importToOrder) markSeller(dealer.rows, verdict);
      }
    }

    const kept: ScreenedListing[] = [];
    const excluded = new Map<string, ExcludedGroup>();
    let excludedCount = 0;
    for (const row of rows) {
      const reasons = row.flags.filter((flag) => (options.exclude as readonly string[]).includes(flag.kind));
      if (row.seller.id !== null && excludedSellers.has(row.seller.id)) {
        reasons.unshift({
          kind: 'excluded_seller',
          source: 'seller',
          evidence: `seller ${row.seller.id} is in excludeSellerIds`,
        });
      }
      if (reasons.length === 0) {
        kept.push(row);
      } else {
        excludedCount += 1;
        addToGroup(excluded, row, reasons[0]!);
      }
    }

    return {
      kept,
      report: {
        exclude: [...options.exclude],
        excludedCount,
        excluded: [...excluded.values()],
        sellerChecks,
        sellersNotChecked,
      },
    };
  }

  /**
   * Reads round by round - one more ad of every unsettled dealer per round - so a short budget
   * leaves every dealer with some reads rather than a few dealers with all of them.
   */
  private async sample(dealers: DealerRound[], budget: CheckBudget): Promise<void> {
    for (let round = 0; round < SELLER_SAMPLE_SIZE; round += 1) {
      for (const dealer of dealers) {
        const { verdict } = dealer;
        if (verdict.importToOrder || dealer.failure !== null) continue;
        if (verdict.listingsRead.length >= SELLER_SAMPLE_SIZE) continue;
        const next = dealer.rows.find((row) => !verdict.listingsRead.includes(row.id));
        if (next === undefined) continue;
        if (budget.remaining <= 0) {
          dealer.outOfBudget = true;
          continue;
        }
        budget.remaining -= 1;
        try {
          const detail = await this.fetchListing(next.url);
          const flag = flagListingDetail(detail).find((candidate) => candidate.kind === 'import_to_order');
          verdict.listingsRead.push(next.id);
          dealer.readsNow += 1;
          if (flag !== undefined) {
            verdict.importToOrder = true;
            verdict.evidenceListingId = next.id;
            verdict.evidence = flag.evidence;
          }
          this.verdicts.set(dealer.sellerId, verdict);
        } catch (error) {
          dealer.failure = `could not read listing ${next.id}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }
}

/** Dealers on the page, the one with the most rows first - it is the one that matters most. */
function dealersByShare(
  rows: ScreenedListing[],
  excludedSellers: Set<string>,
): [string, ScreenedListing[]][] {
  const bySeller = new Map<string, ScreenedListing[]>();
  for (const row of rows) {
    const { id, professional } = row.seller;
    if (!professional || id === null || excludedSellers.has(id)) continue;
    const list = bySeller.get(id) ?? [];
    list.push(row);
    bySeller.set(id, list);
  }
  return [...bySeller].sort((a, b) => b[1].length - a[1].length);
}

/** Every row of the dealer gets the same flag, the listing that was read included. */
function markSeller(rows: ScreenedListing[], verdict: Verdict): void {
  for (const row of rows) {
    if (row.flags.some((flag) => flag.kind === 'import_to_order')) continue;
    row.flags.push({
      kind: 'import_to_order',
      source: 'seller',
      evidence: `dealer ${verdict.sellerName ?? verdict.sellerId} writes in listing ${verdict.evidenceListingId ?? ''}: ${verdict.evidence ?? ''}`,
    });
  }
}

/** A seller-level reason groups by seller; anything else is about the one row. */
function groupKey(reason: { kind: string; source: string }, sellerId: string | null): string | null {
  return reason.source === 'seller' && sellerId !== null ? `${reason.kind}|${sellerId}` : null;
}

function addToGroup(groups: Map<string, ExcludedGroup>, row: ScreenedListing, reason: ListingFlag): void {
  const key = groupKey(reason, row.seller.id) ?? `row|${row.id}`;
  const entry = { id: row.id, title: row.title };
  const group = groups.get(key);
  if (group !== undefined) {
    group.listings.push(entry);
    return;
  }
  groups.set(key, {
    kind: reason.kind,
    source: reason.source,
    evidence: reason.evidence,
    seller:
      reason.source === 'seller' && row.seller.id !== null
        ? { id: row.seller.id, name: row.seller.name }
        : null,
    listings: [entry],
  });
}

/** Folds several pages' reports into one, for tools that read more than one page. */
export function mergeReports(reports: ScreenReport[], exclude: readonly ScreenKind[]): ScreenReport {
  const checked = new Map<string, SellerCheck>();
  for (const report of reports) {
    for (const check of report.sellerChecks) {
      const previous = checked.get(check.sellerId);
      // Reads add up across pages, so the last sighting knows most; it was paid for if any was.
      checked.set(check.sellerId, previous === undefined ? check : { ...check, cached: previous.cached && check.cached });
    }
  }
  const notChecked = new Map<string, ScreenReport['sellersNotChecked'][number]>();
  for (const report of reports) {
    for (const entry of report.sellersNotChecked) {
      if (!checked.has(entry.sellerId)) notChecked.set(entry.sellerId, entry);
    }
  }
  const excluded = new Map<string, ExcludedGroup>();
  reports.forEach((report, page) => {
    report.excluded.forEach((group, index) => {
      const key = groupKey(group, group.seller?.id ?? null) ?? `page${page}|${index}`;
      const existing = excluded.get(key);
      if (existing === undefined) excluded.set(key, { ...group, listings: [...group.listings] });
      else existing.listings.push(...group.listings);
    });
  });
  return {
    exclude: [...exclude],
    excludedCount: reports.reduce((total, report) => total + report.excludedCount, 0),
    excluded: [...excluded.values()],
    sellerChecks: [...checked.values()],
    sellersNotChecked: [...notChecked.values()],
  };
}
