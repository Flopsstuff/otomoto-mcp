import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { OtomotoClient } from './client.ts';
import { filterOptionsToolConfig, runFilterOptions } from './tools/filter-options.ts';
import { listingToolConfig, runListing } from './tools/listing.ts';
import { priceStatsToolConfig, runPriceStats } from './tools/price-stats.ts';
import { runSearch, searchToolConfig } from './tools/search.ts';

export const SERVER_NAME = 'otomoto-mcp';
export const SERVER_VERSION = '0.1.0';

export const TOOL_NAMES = [
  'otomoto_search',
  'otomoto_listing',
  'otomoto_price_stats',
  'otomoto_filter_options',
] as const;

export function createServer(client: OtomotoClient = new OtomotoClient()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool('otomoto_search', searchToolConfig, (args) => runSearch(client, args));
  server.registerTool('otomoto_listing', listingToolConfig, (args) => runListing(client, args));
  server.registerTool('otomoto_price_stats', priceStatsToolConfig, (args) =>
    runPriceStats(client, args),
  );
  server.registerTool('otomoto_filter_options', filterOptionsToolConfig, (args) =>
    runFilterOptions(args),
  );

  return server;
}
