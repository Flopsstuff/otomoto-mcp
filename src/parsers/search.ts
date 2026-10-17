import { ParserContractError } from '../errors.ts';
import { findSearchResult, isRecord } from '../nextdata.ts';
import { sanitizeSellerText, type SellerTextOptions } from '../sanitize.ts';
import type {
  AdministrativeLevel,
  AppliedFilter,
  AppliedLocation,
  Listing,
  ListingSeller,
  SearchResult,
} from '../types.ts';

/**
 * Search result rows. The advert here is a node in a urql GraphQL cache with a flat
 * `parameters[]` list and an integer price; listing pages are a different shape entirely and
 * have their own parser.
 */

/** Otomoto returns 32 rows per page; `pageInfo.pageSize` is trusted over this when present. */
export const DEFAULT_PAGE_SIZE = 32;

export interface ParseSearchOptions {
  page: number;
  requestedUrl: string;
  resolvedUrl: string;
  /** Set when the query named a place, so a missing `appliedLocation` key cannot pass as "none". */
  expectLocation?: boolean;
  /** See sanitizeSellerText. */
  redactContacts?: boolean;
}

export function parseSearchPage(
  nextData: Record<string, unknown>,
  options: ParseSearchOptions,
): SearchResult {
  const payload = findSearchResult(nextData, options.resolvedUrl);

  const listings: Listing[] = [];
  for (const edge of payload.edges) {
    if (!isRecord(edge)) continue;
    const node = edge['node'];
    if (!isRecord(node)) continue;
    // Promoted slots and banners ride in the same edge list under other __typenames.
    if (node['__typename'] !== 'Advert') continue;
    listings.push(parseListingNode(node, options));
  }

  const pageSizeRaw = payload.pageInfo['pageSize'];
  const pageSize = typeof pageSizeRaw === 'number' && pageSizeRaw > 0 ? pageSizeRaw : DEFAULT_PAGE_SIZE;

  return {
    listings,
    totalCount: payload.totalCount,
    page: options.page,
    pageSize,
    hasMorePages:
      payload.totalCount !== null ? options.page * pageSize < payload.totalCount : false,
    requestedUrl: options.requestedUrl,
    resolvedUrl: options.resolvedUrl,
    appliedFilters: parseAppliedFilters(payload.raw['appliedFilters']),
    appliedLocation: parseAppliedLocation(payload.raw, options),
    relaxationApplied: isRecord(payload.raw['relaxation'])
      ? payload.raw['relaxation']['applied'] === true
      : false,
  };
}

function parseListingNode(node: Record<string, unknown>, options: ParseSearchOptions): Listing {
  const url = options.resolvedUrl;
  const textOptions = { redactContacts: options.redactContacts === true };
  const id = node['id'];
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new ParserContractError('a search result node has no id', url);
  }
  const listingUrl = node['url'];
  if (typeof listingUrl !== 'string') {
    throw new ParserContractError(`search result ${String(id)} has no url`, url);
  }

  const parameters = flattenParameters(node['parameters']);
  const price = parsePrice(node['price']);

  return {
    id: String(id),
    url: listingUrl,
    title: typeof node['title'] === 'string' ? node['title'] : '',
    shortDescription: sanitizeSellerText(node['shortDescription'], textOptions),
    make: codeParam(parameters, 'make'),
    model: codeParam(parameters, 'model'),
    price: price.amount,
    currency: price.currency,
    priceEvaluation: parsePriceEvaluation(node['priceEvaluation']),
    year: integerParam(parameters, 'year'),
    mileageKm: integerParam(parameters, 'mileage'),
    fuelType: codeParam(parameters, 'fuel_type'),
    fuelTypeLabel: labelParam(parameters, 'fuel_type'),
    gearbox: codeParam(parameters, 'gearbox'),
    gearboxLabel: labelParam(parameters, 'gearbox'),
    enginePowerHp: integerParam(parameters, 'engine_power'),
    engineCapacityCm3: integerParam(parameters, 'engine_capacity'),
    version: codeParam(parameters, 'version'),
    versionLabel: labelParam(parameters, 'version'),
    countryOrigin: codeParam(parameters, 'country_origin'),
    countryOriginLabel: labelParam(parameters, 'country_origin'),
    location: parseLocation(node['location']),
    seller: parseSeller(node['seller'], node['sellerLink'], textOptions),
    createdAt: typeof node['createdAt'] === 'string' ? node['createdAt'] : null,
  };
}

function parsePriceEvaluation(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const indicator = raw['indicator'];
  return typeof indicator === 'string' && indicator !== '' && indicator !== 'NONE' ? indicator : null;
}

interface FlatParameter {
  value: string | null;
  displayValue: string | null;
}

function flattenParameters(raw: unknown): Map<string, FlatParameter> {
  const out = new Map<string, FlatParameter>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = entry['key'];
    if (typeof key !== 'string') continue;
    out.set(key, {
      value: typeof entry['value'] === 'string' ? entry['value'] : null,
      displayValue: typeof entry['displayValue'] === 'string' ? entry['displayValue'] : null,
    });
  }
  return out;
}

function codeParam(parameters: Map<string, FlatParameter>, key: string): string | null {
  const value = parameters.get(key)?.value;
  return value !== undefined && value !== null && value !== '' ? value : null;
}

function labelParam(parameters: Map<string, FlatParameter>, key: string): string | null {
  const value = parameters.get(key)?.displayValue;
  return value !== undefined && value !== null && value !== '' ? value : null;
}

function integerParam(parameters: Map<string, FlatParameter>, key: string): number | null {
  const raw = codeParam(parameters, key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** Search pages carry an integer price; a price of 0 or less means "not published". */
function parsePrice(raw: unknown): { amount: number | null; currency: string | null } {
  if (!isRecord(raw)) return { amount: null, currency: null };
  const amount = raw['amount'];
  if (!isRecord(amount)) return { amount: null, currency: null };
  const units = amount['units'];
  const currency = amount['currencyCode'];
  const numeric = typeof units === 'number' ? units : Number(units);
  return {
    amount: Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null,
    currency: typeof currency === 'string' ? currency : null,
  };
}

function parseLocation(raw: unknown): Listing['location'] {
  if (!isRecord(raw)) return { city: null, region: null };
  return {
    city: administrativeName(raw['city']),
    region: administrativeName(raw['region']),
  };
}

/** The seller's kind is only in the `__typename`; who they are is in `sellerLink`. */
const SELLER_TYPES: Record<string, string> = {
  PrivateSeller: 'PRIVATE',
  ProfessionalSeller: 'PROFESSIONAL',
};

/**
 * The dealer name is text the dealer typed, so it is cleaned like a description - and redacted
 * like one when that is switched on, since `AUTO-X tel. 600 100 200` is not unusual.
 */
function parseSeller(seller: unknown, link: unknown, textOptions: SellerTextOptions): ListingSeller {
  const typename = isRecord(seller) ? seller['__typename'] : undefined;
  const type = typeof typename === 'string' ? (SELLER_TYPES[typename] ?? null) : null;
  const id = isRecord(link) ? link['id'] : undefined;
  const pageUrl = isRecord(link) ? link['websiteUrl'] : undefined;
  return {
    id: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    type,
    professional: type === 'PROFESSIONAL',
    name: isRecord(link) ? sanitizeSellerText(link['name'], textOptions) : null,
    pageUrl: typeof pageUrl === 'string' && pageUrl !== '' ? pageUrl : null,
  };
}

function administrativeName(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const name = raw['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * `appliedLocation` is null both when no place was asked for and when Otomoto did not recognise
 * the one that was. Only the key disappearing altogether is a change in the page format.
 */
function parseAppliedLocation(
  raw: Record<string, unknown>,
  options: ParseSearchOptions,
): AppliedLocation | null {
  if (!('appliedLocation' in raw)) {
    if (options.expectLocation === true) {
      throw new ParserContractError(
        'advertSearch.appliedLocation missing, so a location search cannot be verified',
        options.resolvedUrl,
      );
    }
    return null;
  }
  const location = raw['appliedLocation'];
  if (!isRecord(location)) return null;
  return {
    city: parseAdministrativeLevel(location['city']),
    subregion: parseAdministrativeLevel(location['subregion']),
    region: parseAdministrativeLevel(location['region']),
  };
}

function parseAdministrativeLevel(raw: unknown): AdministrativeLevel | null {
  if (!isRecord(raw)) return null;
  const { id, name, canonical } = raw;
  if (typeof id !== 'number' || typeof name !== 'string' || typeof canonical !== 'string') {
    return null;
  }
  return { id, name, slug: canonical };
}

function parseAppliedFilters(raw: unknown): AppliedFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: AppliedFilter[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = entry['name'];
    if (typeof name !== 'string') continue;
    const value = entry['value'];
    const labels = entry['labels'];
    out.push({
      name,
      value: typeof value === 'string' ? value : String(value ?? ''),
      labels: Array.isArray(labels) ? labels.filter((label): label is string => typeof label === 'string') : [],
    });
  }
  return out;
}
