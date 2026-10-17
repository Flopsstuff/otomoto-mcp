/**
 * End-to-end smoke test: starts the built server, speaks MCP to it over real stdio, and runs
 * one small live search against Otomoto.
 *
 *   npm run build && npm run smoke
 *
 * Exactly one network request, on a make/model with a handful of matches. Exits non-zero with
 * a reason if any step fails.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const EXPECTED_TOOLS = [
  'otomoto_search',
  'otomoto_listing',
  'otomoto_price_stats',
  'otomoto_filter_options',
];

const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map<number, (message: Record<string, any>) => void>();
let buffer = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    const message = JSON.parse(line) as Record<string, any>;
    const resolve = typeof message['id'] === 'number' ? pending.get(message['id']) : undefined;
    if (resolve) {
      pending.delete(message['id']);
      resolve(message);
    }
  }
});

let nextId = 1;
function request(method: string, params: unknown): Promise<Record<string, any>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message['error']) reject(new Error(`${method} failed: ${JSON.stringify(message['error'])}`));
      else resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function fail(reason: string): never {
  console.error(`SMOKE FAILED: ${reason}`);
  child.kill();
  process.exit(1);
}

try {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'otomoto-mcp-smoke', version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await request('tools/list', {});
  const names = (listed['result'].tools as { name: string }[]).map((tool) => tool.name);
  console.log(`tools/list: ${names.join(', ')}`);
  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) fail(`tools missing from tools/list: ${missing.join(', ')}`);

  const called = await request('tools/call', {
    name: 'otomoto_search',
    arguments: { filters: { make: 'lexus', model: 'lc' }, limit: 3 },
  });
  if (called['result'].isError === true) {
    fail(`otomoto_search returned an error: ${called['result'].content?.[0]?.text}`);
  }

  const payload = JSON.parse(called['result'].content[0].text) as Record<string, any>;
  console.log(
    `otomoto_search: totalCount=${payload['totalCount']} returned=${payload['returned']} ` +
      `url=${payload['resolvedUrl']} rewritten=${payload['queryWasRewritten']}`,
  );
  for (const listing of payload['listings'] as Record<string, any>[]) {
    console.log(
      ` - ${listing['title']} | ${listing['price']} ${listing['currency']} | ${listing['year']} | ` +
        `${listing['mileageKm']} km | ${listing['location']?.city ?? '?'}`,
    );
  }

  if (!(payload['listings'] as unknown[]).length) fail('live search returned no listings');
  console.log('SMOKE OK - one live request, four tools registered.');
  child.kill();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
