#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.ts';

/**
 * stdio entry point. Nothing may be written to stdout except protocol messages - stdout is
 * the transport - so diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error('otomoto-mcp failed to start:', error);
  process.exit(1);
});
