import { z } from 'zod';

import type { OtomotoClient } from '../client.ts';
import { flagListingDetail } from '../screening.ts';
import { jsonResult, toToolError, type ToolResult } from './shared.ts';

/** Full detail for one listing, from a URL or either form of its id. */

export const listingInputSchema = {
  idOrUrl: z
    .string()
    .min(1)
    .describe(
      'A listing URL, the base62 id from a listing URL ("6I6SJj" or "ID6I6SJj"), or the ' +
        'numeric id a search result reports ("6148596129").',
    ),
};

export const listingToolConfig = {
  title: 'Read one Otomoto listing',
  description:
    'Fetch the full detail of a single Otomoto listing: price, status, description, every ' +
    'published spec and equipment flag, photos and seller. Accepts a listing URL or either ' +
    'form of the id. The description is returned as the seller wrote it, unless the server ' +
    'runs with OTOMOTO_MCP_REDACT_CONTACTS; Otomoto\'s encrypted phone and VIN/plate tokens are ' +
    'never returned. ' +
    'flags marks a lease transfer or an import-to-order broker ad, with the text that shows it.',
  inputSchema: listingInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export async function runListing(
  client: OtomotoClient,
  args: { idOrUrl: string },
): Promise<ToolResult> {
  try {
    const detail = await client.listing(args.idOrUrl);
    return jsonResult({ ...detail, flags: flagListingDetail(detail) });
  } catch (error) {
    return toToolError(error);
  }
}
