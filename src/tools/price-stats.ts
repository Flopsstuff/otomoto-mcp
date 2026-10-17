import { z } from 'zod';

import { MAX_STATS_PAGES, type OtomotoClient } from '../client.ts';
import {
  filtersSchema,
  jsonResult,
  screeningInputSchema,
  toScreenOptions,
  toSearchFilters,
  toToolError,
  type ToolResult,
} from './shared.ts';

/**
 * Price and mileage distribution over a bounded sample.
 *
 * The sample size and page count are part of the answer, not a footnote: 32 rows out of 4000
 * matches is a hint about the asking prices on the first page, and reporting it without that
 * caveat would be the one way this tool can mislead.
 */

export const priceStatsInputSchema = {
  filters: filtersSchema.optional().describe('Same filters as otomoto_search.'),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(MAX_STATS_PAGES)
    .optional()
    .describe(
      `Pages to sample, 1-${MAX_STATS_PAGES} (default 1). Each page is 32 listings and ~1.5 MB of HTML.`,
    ),
  ...screeningInputSchema,
};

export const priceStatsToolConfig = {
  title: 'Otomoto price statistics',
  description:
    'Count, min, p25, median, p75, max and mean of price (PLN) and mileage (km) over a ' +
    'bounded sample of search results. Reports sampleSize, pagesFetched and totalCount: the ' +
    'figures describe the sampled listings only, never the whole market, and sampleIsPartial ' +
    'says so explicitly. Sorting changes which listings are sampled. Lease transfers and ' +
    'import-to-order broker ads are left out of the sample by default (see screening).',
  inputSchema: priceStatsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export async function runPriceStats(
  client: OtomotoClient,
  args: {
    filters?: z.infer<typeof filtersSchema> | undefined;
    maxPages?: number | undefined;
    exclude?: ('lease_transfer' | 'import_to_order')[] | undefined;
    excludeSellerIds?: string[] | undefined;
    verifySellers?: boolean | undefined;
  },
): Promise<ToolResult> {
  try {
    const stats = await client.priceStats(
      toSearchFilters(args.filters),
      args.maxPages ?? 1,
      toScreenOptions(args),
    );
    const excluded = stats.screening.excludedCount;
    const screenedOut = excluded > 0 ? ` (${excluded} more left out by screening)` : '';
    return jsonResult({
      ...stats,
      sampleNote:
        stats.totalCount !== null && stats.sampleIsPartial
          ? `Computed from ${stats.sampleSize} listings${screenedOut} on ${stats.pagesFetched} ` +
            `page(s) of ${stats.totalCount} total matches. Not a whole-market figure.`
          : `Computed from ${stats.sampleSize} listings${screenedOut} on ${stats.pagesFetched} page(s).`,
    });
  } catch (error) {
    return toToolError(error);
  }
}
