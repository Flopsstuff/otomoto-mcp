import { FilterNotAppliedError, UnknownLocationError } from './errors.ts';
import { buildSearchUrl, checkPaging, requestedEnums, requestsLocation, RESULTS_PER_PAGE } from './filters.ts';
import { HttpClient } from './http.ts';
import { resolveListingUrl } from './listing-id.ts';
import { extractNextData } from './nextdata.ts';
import { parseListingPage } from './parsers/detail.ts';
import { parseSearchPage } from './parsers/search.ts';
import { redactContactsFromEnv } from './sanitize.ts';
import {
  DEFAULT_SCREEN_OPTIONS,
  mergeReports,
  newCheckBudget,
  Screener,
  type CheckBudget,
  type ScreenOptions,
  type ScreenReport,
  type ScreenResult,
} from './screening.ts';
import { describe, type Distribution } from './stats.ts';
import type { AppliedFilter, AppliedLocation, ListingDetail, SearchFilters, SearchResult } from './types.ts';

/**
 * Joins the layers: filters to a URL, the URL through the one HTTP client, the HTML through
 * the right parser. Tools call this and do nothing but shape the output.
 */

/** Three pages is ~4.5 MB of HTML and a 96-row sample; more is not worth the bandwidth. */
export const MAX_STATS_PAGES = 3;

export interface PriceStatsResult {
  /** How many rows the figures were computed from, and how many Otomoto says exist. */
  sampleSize: number;
  /** Rows read before screening; `sampleSize` is what was left after it. */
  rowsFetched: number;
  pagesFetched: number;
  totalCount: number | null;
  /** True when the sample is only part of the result set. */
  sampleIsPartial: boolean;
  price: Distribution | null;
  mileageKm: Distribution | null;
  resolvedUrl: string;
  appliedLocation: AppliedLocation | null;
  relaxationApplied: boolean;
  screening: ScreenReport;
}

export interface ClientOptions {
  /** Strip phone numbers and e-mails from seller text. Default: OTOMOTO_MCP_REDACT_CONTACTS, else off. */
  redactContacts?: boolean;
}

export class OtomotoClient {
  private readonly http: HttpClient;
  private readonly screener: Screener;
  readonly redactContacts: boolean;

  constructor(http: HttpClient = new HttpClient(), options: ClientOptions = {}) {
    this.http = http;
    this.redactContacts = options.redactContacts ?? redactContactsFromEnv();
    this.screener = new Screener((url) => this.listing(url));
  }

  /**
   * A place Otomoto does not recognise is dropped, not rejected: the page comes back with
   * `appliedLocation: null` and every listing in Poland. That page is refused here, because
   * returning it would answer "cars near X" with cars from anywhere.
   */
  async search(filters: SearchFilters, page = 1): Promise<SearchResult> {
    const url = buildSearchUrl(filters, page);
    const expectLocation = requestsLocation(filters);
    const response = await this.http.fetchPage(url);
    const result = parseSearchPage(extractNextData(response.html, response.url), {
      page,
      requestedUrl: response.requestedUrl,
      resolvedUrl: response.url,
      expectLocation,
      redactContacts: this.redactContacts,
    });
    if (expectLocation && result.appliedLocation?.city == null) {
      const asked =
        filters.city !== undefined ? `city "${filters.city}"` : `cityId ${String(filters.cityId)}`;
      throw new UnknownLocationError(
        `Otomoto did not recognise ${asked} and would have searched all of Poland instead ` +
          `(${String(result.totalCount)} listings)`,
        response.url,
      );
    }
    // A relaxed search has dropped filters on purpose and says so in relaxationApplied.
    if (!result.relaxationApplied) checkEnumsApplied(filters, result.appliedFilters, response.url);
    return result;
  }

  /** Flags every row and drops the kinds `options.exclude` names; see screening.ts. */
  async screen(
    listings: SearchResult['listings'],
    options: ScreenOptions = DEFAULT_SCREEN_OPTIONS,
    budget: CheckBudget = newCheckBudget(),
  ): Promise<ScreenResult> {
    return this.screener.screen(listings, options, budget);
  }

  async listing(idOrUrl: string): Promise<ListingDetail> {
    const url = resolveListingUrl(idOrUrl);
    const response = await this.http.fetchPage(url);
    return parseListingPage(extractNextData(response.html, response.url), response.url, {
      redactContacts: this.redactContacts,
    });
  }

  /**
   * Walks at most `maxPages` pages and stops early once Otomoto has no more rows. The page
   * count is part of the result because it is the only honest way to read the numbers.
   */
  async priceStats(
    filters: SearchFilters,
    maxPages = 1,
    screen: ScreenOptions = DEFAULT_SCREEN_OPTIONS,
  ): Promise<PriceStatsResult> {
    const pages = Math.min(Math.max(1, Math.floor(maxPages)), MAX_STATS_PAGES);
    checkPaging(filters, pages);
    const prices: (number | null)[] = [];
    const mileages: (number | null)[] = [];
    const reports: ScreenReport[] = [];
    const budget = newCheckBudget();
    let rowsFetched = 0;
    let pagesFetched = 0;
    let totalCount: number | null = null;
    let resolvedUrl = '';
    let appliedLocation: AppliedLocation | null = null;
    let relaxationApplied = false;

    for (let page = 1; page <= pages; page += 1) {
      const result = await this.search(filters, page);
      pagesFetched += 1;
      if (page === 1) {
        totalCount = result.totalCount;
        resolvedUrl = result.resolvedUrl;
        appliedLocation = result.appliedLocation;
        relaxationApplied = result.relaxationApplied;
      }
      rowsFetched += result.listings.length;
      // A transfer fee or an instalment is not an asking price, and one of them is the minimum.
      const screened = await this.screen(result.listings, screen, budget);
      reports.push(screened.report);
      for (const listing of screened.kept) {
        prices.push(listing.price);
        mileages.push(listing.mileageKm);
      }
      if (result.listings.length === 0 || !result.hasMorePages) break;
    }

    const sampleSize = prices.length;
    return {
      sampleSize,
      rowsFetched,
      pagesFetched,
      totalCount,
      sampleIsPartial: totalCount !== null ? rowsFetched < totalCount : true,
      price: describe(prices),
      mileageKm: describe(mileages),
      resolvedUrl,
      appliedLocation,
      relaxationApplied,
      screening: mergeReports(reports, screen.exclude),
    };
  }
}

export { RESULTS_PER_PAGE };

function checkEnumsApplied(filters: SearchFilters, applied: AppliedFilter[], url: string): void {
  for (const wanted of requestedEnums(filters)) {
    const got = new Set(applied.filter((filter) => filter.name === wanted.filterId).map((filter) => filter.value));
    const missing = wanted.values.filter((value) => !got.has(value));
    if (missing.length > 0) {
      throw new FilterNotAppliedError(
        `Otomoto did not apply ${wanted.field} ${missing.map((value) => `"${value}"`).join(', ')} ` +
          `(it applied ${got.size > 0 ? [...got].map((value) => `"${value}"`).join(', ') : 'nothing'} ` +
          `for ${wanted.filterId})`,
        url,
      );
    }
  }
}
