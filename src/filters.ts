import { InvalidArgumentError } from './errors.ts';
import {
  ENUM_FILTERS,
  MAKES,
  MODELS_BY_MAKE,
  RADIUS_KM_VALUES,
  RANGE_FILTERS,
  SORT_OPTIONS,
} from './filter-vocabulary.ts';
import type { SearchFilters } from './types.ts';

/**
 * Typed filters to an Otomoto search URL.
 *
 * Two rules come out of what was measured, and both are about silence. Make and model only
 * work as path segments - as `search[filter_enum_make]` they return HTTP 200 with
 * `totalCount: 0`, which reads like "no such car" rather than "wrong query". And anything
 * Otomoto does not recognise is ignored rather than rejected, so a typo'd filter returns a
 * perfectly plausible page of wrong results. Everything here is therefore validated at the
 * edge against Otomoto's own vocabulary and trusted afterwards.
 */

export const SEARCH_BASE_URL = 'https://www.otomoto.pl/osobowe';

/** Otomoto's own paging unit. */
export const RESULTS_PER_PAGE = 32;

const SLUG_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

/**
 * The order a search gets when the caller names none. Otomoto's own default, `relevance_web`,
 * reshuffles between requests: paging all 268 rows of one search returned 227 distinct
 * listings, some on two or three pages and 41 on none. Newest-first returned all 268, as did
 * every other sort measured (2026-10-17), so it is the default here and `relevance_web` is
 * allowed on page 1 only.
 */
export const DEFAULT_SORT = 'created_at_first:desc';
const SINGLE_PAGE_SORTS = new Set(['relevance_web']);

interface RangeBound {
  key: keyof typeof RANGE_FILTERS;
  min: number;
  max: number;
  integer: boolean;
}

/**
 * Bounds exist to catch the order-of-magnitude slip (a price in grosze, a mileage in miles
 * typed as 1_000_000_000), not to second-guess the market.
 */
const RANGE_BOUNDS: Record<string, RangeBound> = {
  price: { key: 'price', min: 0, max: 100_000_000, integer: true },
  year: { key: 'year', min: 1900, max: new Date().getFullYear() + 2, integer: true },
  mileage: { key: 'mileage', min: 0, max: 10_000_000, integer: true },
  engine_power: { key: 'engine_power', min: 1, max: 3000, integer: true },
  engine_capacity: { key: 'engine_capacity', min: 1, max: 30_000, integer: true },
};

/** Maps the filter object's camelCase range fields onto Otomoto's float filters. */
const RANGE_FIELDS: { from: keyof SearchFilters; to: keyof SearchFilters; key: string }[] = [
  { from: 'priceFrom', to: 'priceTo', key: 'price' },
  { from: 'yearFrom', to: 'yearTo', key: 'year' },
  { from: 'mileageFrom', to: 'mileageTo', key: 'mileage' },
  { from: 'enginePowerFrom', to: 'enginePowerTo', key: 'engine_power' },
  { from: 'engineCapacityFrom', to: 'engineCapacityTo', key: 'engine_capacity' },
];

/** Named convenience fields, each resolving to an enum filter in the generated vocabulary. */
const NAMED_ENUM_FIELDS: { field: keyof SearchFilters; key: string }[] = [
  { field: 'fuelType', key: 'fuel_type' },
  { field: 'gearbox', key: 'gearbox' },
  { field: 'bodyType', key: 'body_type' },
  { field: 'countryOrigin', key: 'country_origin' },
  { field: 'condition', key: 'new_used' },
  { field: 'sellerType', key: 'private_business' },
];

/** The filter-object field names for each range, for tools that describe the surface. */
export const RANGE_FIELD_NAMES: Record<string, { from: string; to: string }> =
  Object.fromEntries(
    RANGE_FIELDS.map((range) => [range.key, { from: range.from as string, to: range.to as string }]),
  );

const KNOWN_FILTER_FIELDS = new Set<string>([
  'make',
  'model',
  'enums',
  'city',
  'cityId',
  'radiusKm',
  'sort',
  ...RANGE_FIELDS.flatMap((range) => [range.from as string, range.to as string]),
  ...NAMED_ENUM_FIELDS.map((named) => named.field as string),
]);

/**
 * Whether pages 1 to `lastPage` of this search can be read as one list. Callers that walk
 * several pages check before the first request, so a refusal costs nothing.
 */
export function checkPaging(filters: SearchFilters, lastPage: number): void {
  const sort = filters.sort;
  if (sort === undefined) return;
  if (!SORT_OPTIONS.some((option) => option.value === sort)) {
    throw new InvalidArgumentError(
      `unknown sort "${sort}". Valid sorts: ${SORT_OPTIONS.map((option) => option.value).join(', ')}`,
    );
  }
  if (lastPage > 1 && SINGLE_PAGE_SORTS.has(sort)) {
    throw new InvalidArgumentError(
      `sort "${sort}" reshuffles between requests, so its page ${String(lastPage)} repeats rows ` +
        `from earlier pages and skips others. Use it for page 1 only, or page with another sort ` +
        `(the default is ${DEFAULT_SORT})`,
    );
  }
}

export function buildSearchUrl(filters: SearchFilters, page = 1): string {
  rejectUnknownFields(filters);

  if (!Number.isInteger(page) || page < 1) {
    throw new InvalidArgumentError(`page must be an integer >= 1, got ${String(page)}`);
  }

  const path = buildPath(filters);
  const params = new URLSearchParams();

  for (const range of RANGE_FIELDS) {
    const from = readNumber(filters, range.from);
    const to = readNumber(filters, range.to);
    if (from !== undefined) validateRange(range.key, range.from as string, from);
    if (to !== undefined) validateRange(range.key, range.to as string, to);
    if (from !== undefined && to !== undefined && from > to) {
      throw new InvalidArgumentError(
        `${String(range.from)} (${from}) must not be greater than ${String(range.to)} (${to})`,
      );
    }
    const filterId = RANGE_FILTERS[range.key]!.filterId;
    if (from !== undefined) params.set(`search[${filterId}:from]`, String(from));
    if (to !== undefined) params.set(`search[${filterId}:to]`, String(to));
  }

  for (const { filterId, values } of requestedEnums(filters)) {
    // One value keeps the plain form; several are Otomoto's OR, indexed. A comma-joined
    // value is the trap: HTTP 200, applied verbatim, zero rows.
    if (values.length === 1) {
      params.set(`search[${filterId}]`, values[0]!);
    } else {
      values.forEach((value, index) => params.set(`search[${filterId}][${String(index)}]`, value));
    }
  }

  applyGeo(params, filters);

  checkPaging(filters, page);
  params.set('search[order]', filters.sort ?? DEFAULT_SORT);

  if (page > 1) params.set('page', String(page));

  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}

/**
 * Make and model are path segments, and a slug Otomoto does not know is the worst failure mode
 * available: `/osobowe/audi/a4` is a real URL that 301s to the narrower `a4-avant`, so the
 * caller gets a plausible page of results for a car they did not ask about.
 *
 * A city is the last path segment. There is no city vocabulary to check it against here, so an
 * unknown one is caught on the way back instead, from the location Otomoto reports applying.
 */
function buildPath(filters: SearchFilters): string {
  const base = buildMakeModelPath(filters);
  return filters.city === undefined ? base : `${base}/${toCitySlug(filters.city)}`;
}

function buildMakeModelPath(filters: SearchFilters): string {
  const { make, model } = filters;

  if (make === undefined) {
    if (model !== undefined) {
      throw new InvalidArgumentError('model requires make: Otomoto has no model-only search path');
    }
    return SEARCH_BASE_URL;
  }

  if (typeof make !== 'string' || !SLUG_RE.test(make)) {
    throw new InvalidArgumentError(
      `make must be a lowercase Otomoto slug such as "alfa-romeo", got "${String(make)}"`,
    );
  }
  if (!MAKES.includes(make)) {
    throw new InvalidArgumentError(
      `unknown make "${make}". Call otomoto_filter_options with field "make" for the list ` +
        `(${MAKES.length} makes).`,
    );
  }

  if (model === undefined) return `${SEARCH_BASE_URL}/${make}`;

  if (typeof model !== 'string' || !SLUG_RE.test(model)) {
    throw new InvalidArgumentError(
      `model must be a lowercase Otomoto slug such as "a4-avant", got "${String(model)}"`,
    );
  }
  const models = MODELS_BY_MAKE[make];
  if (models !== undefined && !models.includes(model)) {
    throw new InvalidArgumentError(
      `unknown model "${model}" for make "${make}". ${suggestModels(models, model)} ` +
        `Call otomoto_filter_options with field "model" and make "${make}" for the full list.`,
    );
  }
  return `${SEARCH_BASE_URL}/${make}/${model}`;
}

function suggestModels(models: readonly string[], model: string): string {
  const close = models.filter((known) => known.startsWith(model) || model.startsWith(known));
  return close.length > 0 ? `Did you mean: ${close.slice(0, 8).join(', ')}?` : '';
}

/**
 * `sources` is what stops a named field and an `enums` entry for the same filter from being
 * resolved by whichever loop happens to run second: the URL can only carry one value, so the
 * other one would be dropped without a word - the very failure this module exists to prevent.
 */
export interface RequestedEnum {
  key: string;
  filterId: string;
  /** Where the caller set it, for error messages. */
  field: string;
  values: string[];
}

/**
 * Every enum filter the caller set, validated against the vocabulary. A field takes one value
 * or a list, and a list means any of them - Otomoto ORs repeated values of one filter.
 */
export function requestedEnums(filters: SearchFilters): RequestedEnum[] {
  const out = new Map<string, RequestedEnum>();
  for (const named of NAMED_ENUM_FIELDS) {
    const value = filters[named.field];
    if (value === undefined) continue;
    addEnum(out, named.key, value, String(named.field));
  }
  if (filters.enums !== undefined) {
    if (typeof filters.enums !== 'object' || filters.enums === null || Array.isArray(filters.enums)) {
      throw new InvalidArgumentError('enums must be an object of {filterKey: value}');
    }
    for (const [key, value] of Object.entries(filters.enums)) {
      addEnum(out, key, value, `enums.${key}`);
    }
  }
  return [...out.values()];
}

function addEnum(out: Map<string, RequestedEnum>, key: string, raw: unknown, field: string): void {
  const values = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new InvalidArgumentError(`${field} must be a string or a list of strings`);
  }
  if (values.length === 0) {
    throw new InvalidArgumentError(`${field} is an empty list; leave it out to not filter on it`);
  }
  const definition = ENUM_FILTERS[key];
  if (definition === undefined) {
    throw new InvalidArgumentError(
      `unknown filter "${key}" (via ${field}). Call otomoto_filter_options for the ` +
        `available filters.`,
    );
  }
  for (const value of values as string[]) {
    if (!definition.values.some((option) => option.value === value)) {
      throw new InvalidArgumentError(
        `"${value}" is not a valid ${key}. Valid values: ` +
          `${definition.values.map((option) => option.value).join(', ')}`,
      );
    }
  }
  if (new Set(values).size !== values.length) {
    throw new InvalidArgumentError(`${field} lists the same value twice`);
  }
  const previous = out.get(key);
  if (previous !== undefined) {
    throw new InvalidArgumentError(
      `filter "${key}" is set twice: ${previous.field}=${JSON.stringify(previous.values.length === 1 ? previous.values[0] : previous.values)} and ` +
        `${field}=${JSON.stringify(raw)}. Set it in exactly one place.`,
    );
  }
  out.set(key, { key, filterId: definition.filterId, field, values: values as string[] });
}

/**
 * Otomoto's own city slugs are the Polish name, lowercased and stripped of diacritics, with
 * spaces as hyphens: `Łódź` is `lodz`, `Nowa Wieś` is `nowa-wies`. `ł` has no Unicode
 * decomposition, so it is mapped by hand.
 */
export function toCitySlug(city: string): string {
  if (typeof city !== 'string') {
    throw new InvalidArgumentError(`city must be a string, got ${typeof city}`);
  }
  const slug = city
    .trim()
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  if (!SLUG_RE.test(slug)) {
    throw new InvalidArgumentError(
      `city must be a Polish place name or Otomoto slug such as "Kraków" or "krakow", got "${city}"`,
    );
  }
  return slug;
}

/**
 * Both halves of the geo pair fail quietly on their own. A radius without a city does nothing;
 * a city without a radius is not "this city only" but Otomoto's own default radius, measured at
 * about 50 km (Kraków: 18 748 rows bare, 18 752 at 50 km, 4 654 at 5 km). So a city always
 * travels with an explicit radius.
 */
function applyGeo(params: URLSearchParams, filters: SearchFilters): void {
  const { city, cityId, radiusKm } = filters;
  if (city === undefined && cityId === undefined && radiusKm === undefined) return;
  if (city !== undefined && cityId !== undefined) {
    throw new InvalidArgumentError('give either city or cityId, not both');
  }
  if (radiusKm === undefined) {
    throw new InvalidArgumentError(
      `radiusKm is required with ${city !== undefined ? 'city' : 'cityId'}: without it Otomoto ` +
        `silently applies its own ~50 km radius`,
    );
  }
  if (city === undefined && cityId === undefined) {
    throw new InvalidArgumentError('radiusKm needs a city or cityId to measure from');
  }
  if (cityId !== undefined && (!Number.isInteger(cityId) || cityId <= 0)) {
    throw new InvalidArgumentError(`cityId must be a positive integer, got ${String(cityId)}`);
  }
  if (!RADIUS_KM_VALUES.includes(radiusKm)) {
    throw new InvalidArgumentError(
      `radiusKm must be one of ${RADIUS_KM_VALUES.join(', ')} km, got ${String(radiusKm)}`,
    );
  }
  params.set('search[dist]', String(radiusKm));
  if (cityId !== undefined) params.set('search[city_id]', String(cityId));
}

/** True when the filters ask Otomoto to search around a place. */
export function requestsLocation(filters: SearchFilters): boolean {
  return filters.city !== undefined || filters.cityId !== undefined;
}

function readNumber(filters: SearchFilters, field: keyof SearchFilters): number | undefined {
  const value = filters[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidArgumentError(`${String(field)} must be a finite number, got ${String(value)}`);
  }
  return value;
}

function validateRange(key: string, field: string, value: number): void {
  const bound = RANGE_BOUNDS[key]!;
  if (bound.integer && !Number.isInteger(value)) {
    throw new InvalidArgumentError(`${field} must be a whole number, got ${value}`);
  }
  if (value < bound.min || value > bound.max) {
    throw new InvalidArgumentError(
      `${field} must be between ${bound.min} and ${bound.max}, got ${value}`,
    );
  }
}

/**
 * An unrecognised field is almost always a filter the caller believes is being applied. Taking
 * the object as-is would hand back results that silently ignore it.
 */
function rejectUnknownFields(filters: SearchFilters): void {
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    throw new InvalidArgumentError('filters must be an object');
  }
  const unknown = Object.keys(filters).filter((field) => !KNOWN_FILTER_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new InvalidArgumentError(
      `unknown filter field(s): ${unknown.join(', ')}. Known fields: ` +
        `${[...KNOWN_FILTER_FIELDS].sort().join(', ')}. Other Otomoto filters go in "enums".`,
    );
  }
}
