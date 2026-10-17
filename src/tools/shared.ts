import { z } from 'zod';

import {
  FetchError,
  FilterNotAppliedError,
  InvalidArgumentError,
  ParserContractError,
  UnknownLocationError,
} from '../errors.ts';
import {
  DEFAULT_SCREEN_OPTIONS,
  MAX_LISTING_READS_PER_CALL,
  SCREEN_KINDS,
  SELLER_SAMPLE_SIZE,
  type ScreenOptions,
} from '../screening.ts';
import type { SearchFilters } from '../types.ts';

/** Shared plumbing for the four tools: the filter schema, result shaping, and error mapping. */

export interface ToolResult {
  /** The SDK's CallToolResult carries an open index signature; mirror it. */
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** An enum filter takes one value or a non-empty list meaning any of them. */
const enumValue = z.union([z.string(), z.array(z.string()).min(1)]);

export const filtersSchema = z
  .object({
    make: z.string().optional().describe('Otomoto make slug, e.g. "audi". Path segment.'),
    model: z
      .string()
      .optional()
      .describe('Otomoto model slug, e.g. "a4-avant". Requires make. Path segment.'),
    priceFrom: z.number().optional().describe('Minimum price in PLN.'),
    priceTo: z.number().optional().describe('Maximum price in PLN.'),
    yearFrom: z.number().optional(),
    yearTo: z.number().optional(),
    mileageFrom: z.number().optional().describe('Minimum mileage in km.'),
    mileageTo: z.number().optional().describe('Maximum mileage in km.'),
    enginePowerFrom: z.number().optional().describe('Minimum engine power in HP (KM).'),
    enginePowerTo: z.number().optional(),
    engineCapacityFrom: z.number().optional().describe('Minimum engine capacity in cm3.'),
    engineCapacityTo: z.number().optional(),
    fuelType: enumValue.optional().describe('e.g. "petrol", "diesel", "hybrid", or ["petrol", "hybrid"].'),
    gearbox: enumValue.optional().describe('"manual" or "automatic".'),
    bodyType: enumValue.optional().describe('e.g. "suv", or ["suv", "combi"] for either.'),
    countryOrigin: enumValue
      .optional()
      .describe('Registration-code country of origin, e.g. "d" for Germany.'),
    condition: enumValue.optional().describe('"new" or "used".'),
    sellerType: enumValue.optional().describe('"private" or "business".'),
    enums: z
      .record(enumValue)
      .optional()
      .describe(
        'Any other enum filter, keyed by its short name from otomoto_filter_options, e.g. ' +
          '{"color": ["black", "white"]}.',
      ),
    city: z
      .string()
      .optional()
      .describe(
        'Polish place name or Otomoto slug, e.g. "Kraków", "lodz", "Nowa Wieś". Requires ' +
          'radiusKm. Check appliedLocation in the result: a name shared by several places ' +
          'resolves to one of them.',
      ),
    cityId: z
      .number()
      .optional()
      .describe("Otomoto's internal city id, e.g. 17871 for Warszawa. Use instead of city. Requires radiusKm."),
    radiusKm: z.number().optional().describe('Search radius in km. Requires city or cityId.'),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort id, e.g. "filter_float_price:asc". Default "created_at_first:desc" (newest first). ' +
          '"relevance_web", Otomoto\'s own default, reshuffles between requests and is refused past page 1.',
      ),
  })
  .strict();

export type FiltersInput = z.infer<typeof filtersSchema>;

/** Arguments that decide which rows are dropped after a page is fetched. Not part of the URL. */
export const screeningInputSchema = {
  exclude: z
    .array(z.enum(SCREEN_KINDS))
    .optional()
    .describe(
      'Kinds of ad to drop: "lease_transfer" (someone handing over a lease or rental, often ' +
        'priced as an instalment) and "import_to_order" (a broker advertising a car it does ' +
        'not have). Default: both. Pass [] to keep every row; rows still carry their flags.',
    ),
  excludeSellerIds: z
    .array(z.string().regex(/^\d+$/, 'a seller id is the numeric seller.id from a result'))
    .optional()
    .describe('Seller ids (seller.id in results) whose ads are dropped.'),
  verifySellers: z
    .boolean()
    .optional()
    .describe(
      `Read up to ${SELLER_SAMPLE_SIZE} listings per dealer, because an import broker is only ` +
        'recognisable from a full description and not from every one. Default true. Stops at the ' +
        `first listing that shows it; at most ${MAX_LISTING_READS_PER_CALL} reads per call, one ` +
        'request each; verdicts are remembered while the server runs. sellerChecks says what was ' +
        'read; sampleComplete false means a clean verdict on fewer listings.',
    ),
};

export function toScreenOptions(input: {
  exclude?: readonly (typeof SCREEN_KINDS)[number][] | undefined;
  excludeSellerIds?: readonly string[] | undefined;
  verifySellers?: boolean | undefined;
}): ScreenOptions {
  return {
    exclude: input.exclude ?? DEFAULT_SCREEN_OPTIONS.exclude,
    excludeSellerIds: input.excludeSellerIds ?? DEFAULT_SCREEN_OPTIONS.excludeSellerIds,
    verifySellers: input.verifySellers ?? DEFAULT_SCREEN_OPTIONS.verifySellers,
  };
}

/**
 * Drops keys that arrived as undefined. `exactOptionalPropertyTypes` treats an explicitly
 * undefined property as a different thing from an absent one, and the filter builder keys its
 * unknown-field check on the keys that are actually present.
 */
export function toSearchFilters(input: FiltersInput | undefined): SearchFilters {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out as SearchFilters;
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * A structure change at Otomoto must never reach the client looking like "nothing matched".
 * Each failure kind gets its own tag so an agent can tell "your filter was wrong" from
 * "this server needs an update" from "the network is down".
 */
export function toToolError(error: unknown): ToolResult {
  const payload = describeError(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${payload.kind}: ${payload.message}\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  };
}

interface ErrorPayload {
  kind: string;
  message: string;
  url?: string;
  status?: number;
  actionable?: string;
}

function describeError(error: unknown): ErrorPayload {
  if (error instanceof ParserContractError) {
    const payload: ErrorPayload = {
      kind: 'PARSER_CONTRACT_ERROR',
      message: error.message,
      actionable:
        'This is NOT an empty result. Otomoto changed its page structure and otomoto-mcp ' +
        'needs an update - do not report this as "no cars found".',
    };
    if (error.url !== undefined) payload.url = error.url;
    return payload;
  }
  if (error instanceof InvalidArgumentError) {
    return {
      kind: 'INVALID_ARGUMENT',
      message: error.message,
      actionable: 'Fix the arguments and call again; no request was sent to Otomoto.',
    };
  }
  if (error instanceof UnknownLocationError) {
    return {
      kind: 'UNKNOWN_LOCATION',
      message: error.message,
      url: error.url,
      actionable:
        'Results were discarded, not empty. Check the spelling of the place, use its Polish ' +
        'name, or pass the nearest larger town.',
    };
  }
  if (error instanceof FilterNotAppliedError) {
    return {
      kind: 'FILTER_NOT_APPLIED',
      message: error.message,
      url: error.url,
      actionable:
        'Results were discarded, not empty: Otomoto ignored part of the filter and would have ' +
        'answered a wider search. Check the value with otomoto_filter_options.',
    };
  }
  if (error instanceof FetchError) {
    const payload: ErrorPayload = {
      kind: 'FETCH_ERROR',
      message: error.message,
      url: error.url,
      actionable: 'Otomoto could not be reached or refused the request. Retry later.',
    };
    if (error.status !== undefined) payload.status = error.status;
    return payload;
  }
  return {
    kind: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
