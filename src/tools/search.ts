import { z } from 'zod';

import type { OtomotoClient } from '../client.ts';
import {
  filtersSchema,
  jsonResult,
  screeningInputSchema,
  toScreenOptions,
  toSearchFilters,
  toToolError,
  type ToolResult,
} from './shared.ts';

/** One page of search results. Never crawls: one call, one page, at most `limit` rows. */

export const MAX_LIMIT = 32;

export const searchInputSchema = {
  filters: filtersSchema.optional().describe('Search filters. Omit for an unfiltered search.'),
  page: z.number().int().min(1).max(500).optional().describe('1-based page number. 32 results per page.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum rows to return from the page (1-${MAX_LIMIT}), counted after screening.`),
  ...screeningInputSchema,
};

export const searchToolConfig = {
  title: 'Search Otomoto listings',
  description:
    'Search car listings on Otomoto.pl. Returns one page of normalised listings, each with its ' +
    'seller (id, private or dealer, dealer name), plus the ' +
    'total match count, whether more pages exist, the URL after redirects, and the filters ' +
    'Otomoto reports it actually applied. Check resolvedUrl: Otomoto rewrites some model ' +
    'slugs (/osobowe/audi/a4 becomes a4-avant), which narrows the query. For a city search, ' +
    'appliedLocation names the place, powiat and voivodeship Otomoto actually searched around. ' +
    'Lease transfers and import-to-order broker ads are dropped by default and listed under ' +
    'screening.excluded with the text that gave them away; totalCount is Otomoto\'s count ' +
    'before that.',
  inputSchema: searchInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export async function runSearch(
  client: OtomotoClient,
  args: {
    filters?: z.infer<typeof filtersSchema> | undefined;
    page?: number | undefined;
    limit?: number | undefined;
    exclude?: ('lease_transfer' | 'import_to_order')[] | undefined;
    excludeSellerIds?: string[] | undefined;
    verifySellers?: boolean | undefined;
  },
): Promise<ToolResult> {
  try {
    const page = args.page ?? 1;
    const result = await client.search(toSearchFilters(args.filters), page);
    const screened = await client.screen(result.listings, toScreenOptions(args));
    const limit = args.limit ?? MAX_LIMIT;
    const listings = screened.kept.slice(0, limit);
    return jsonResult({
      /** Otomoto's count, before screening dropped anything. */
      totalCount: result.totalCount,
      page: result.page,
      pageSize: result.pageSize,
      returned: listings.length,
      /** Set when `limit` cut the page short, so a caller does not read it as the page end. */
      truncatedByLimit: listings.length < screened.kept.length,
      hasMorePages: result.hasMorePages,
      requestedUrl: result.requestedUrl,
      resolvedUrl: result.resolvedUrl,
      queryWasRewritten: result.requestedUrl !== result.resolvedUrl,
      relaxationApplied: result.relaxationApplied,
      appliedFilters: result.appliedFilters,
      appliedLocation: result.appliedLocation,
      screening: screened.report,
      listings,
    });
  } catch (error) {
    return toToolError(error);
  }
}
