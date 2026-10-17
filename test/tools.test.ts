import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { OtomotoClient } from '../src/client.ts';
import { HttpClient, type PageResponse } from '../src/http.ts';
import { MAX_LISTING_READS_PER_CALL, SELLER_SAMPLE_SIZE } from '../src/screening.ts';
import { createServer, TOOL_NAMES } from '../src/server.ts';
import { KRAKOW_APPLIED_LOCATION, loadFixture, withAppliedFilters, withAppliedLocation } from './fixtures.ts';

/**
 * The tools are exercised over a real MCP session; only the network is replaced. A fixture is
 * chosen by what the URL looks like, so the filter builder and the id resolver still have to
 * produce a URL that makes sense.
 */
interface FixtureOptions {
  /** Where every request claims to have been redirected. */
  redirectTo?: string;
  /** Replaces what search pages report as `appliedLocation`. */
  searchLocation?: { value: unknown };
  /** Prepended to the listing page's description, e.g. a broker's boilerplate. */
  descriptionPrefix?: string;
  /** Added to what search pages report as `appliedFilters`. */
  appliedFilters?: { name: string; value: string }[];
}

class FixtureHttpClient extends HttpClient {
  readonly requested: string[] = [];
  private readonly options: FixtureOptions;

  constructor(options: FixtureOptions = {}) {
    super({ minDelayMs: 500, timeoutMs: 1000 });
    this.options = options;
  }

  get detailRequests(): string[] {
    return this.requested.filter((url) => url.includes('/oferta/'));
  }

  override async fetchPage(url: string): Promise<PageResponse> {
    this.requested.push(url);
    const isDetail = url.includes('/oferta/');
    let html = loadFixture(isDetail ? 'detail-lexus-lc' : 'search-lexus-lc');
    if (!isDetail && this.options.searchLocation !== undefined) {
      html = withAppliedLocation(html, this.options.searchLocation.value);
    }
    if (!isDetail && this.options.appliedFilters !== undefined) {
      html = withAppliedFilters(html, this.options.appliedFilters);
    }
    if (isDetail && this.options.descriptionPrefix !== undefined) {
      html = html.replace('"description":"', `"description":"${this.options.descriptionPrefix} `);
    }
    return {
      url: this.options.redirectTo ?? url,
      requestedUrl: url,
      status: 200,
      html,
    };
  }
}

class BrokenHttpClient extends HttpClient {
  override async fetchPage(url: string): Promise<PageResponse> {
    return { url, requestedUrl: url, status: 200, html: '<html><body>no payload</body></html>' };
  }
}

async function connect(http: HttpClient): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(new OtomotoClient(http)).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((block) => block.text ?? '').join('\n');
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

test('all four tools are registered and callable over an MCP session', async () => {
  const client = await connect(new FixtureHttpClient());
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort(),
  );
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} is described`);
    assert.ok(tool.inputSchema, `${tool.name} has an input schema`);
  }
  await client.close();
});

test('otomoto_search returns listings, paging and the resolved URL', async () => {
  const http = new FixtureHttpClient();
  const client = await connect(http);
  const result = await client.callTool({
    name: 'otomoto_search',
    arguments: { filters: { make: 'lexus', model: 'lc' }, limit: 3, verifySellers: false },
  });
  const payload = jsonOf(result);
  assert.equal(payload['totalCount'], 20);
  assert.equal(payload['returned'], 3);
  assert.equal(payload['truncatedByLimit'], true);
  assert.equal(payload['hasMorePages'], false);
  assert.equal(payload['resolvedUrl'], 'https://www.otomoto.pl/osobowe/lexus/lc?search%5Border%5D=created_at_first%3Adesc');
  assert.equal(payload['queryWasRewritten'], false);
  assert.deepEqual(http.requested, ['https://www.otomoto.pl/osobowe/lexus/lc?search%5Border%5D=created_at_first%3Adesc']);
  await client.close();
});

test('a silent model-slug redirect is reported, not hidden', async () => {
  const http = new FixtureHttpClient({
    redirectTo: 'https://www.otomoto.pl/osobowe/audi/a4-avant?search%5Border%5D=created_at_first%3Adesc',
  });
  const client = await connect(http);
  const payload = jsonOf(
    await client.callTool({
      name: 'otomoto_search',
      arguments: { filters: { make: 'audi', model: 'a4-limousine' } },
    }),
  );
  assert.equal(payload['queryWasRewritten'], true);
  assert.equal(payload['resolvedUrl'], 'https://www.otomoto.pl/osobowe/audi/a4-avant?search%5Border%5D=created_at_first%3Adesc');
  assert.equal(payload['requestedUrl'], 'https://www.otomoto.pl/osobowe/audi/a4-limousine?search%5Border%5D=created_at_first%3Adesc');
  await client.close();
});

test('otomoto_search rejects an invented filter value without making a request', async () => {
  const http = new FixtureHttpClient();
  const client = await connect(http);
  const result = await client.callTool({
    name: 'otomoto_search',
    arguments: { filters: { gearbox: 'stick' } },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /INVALID_ARGUMENT/);
  assert.match(textOf(result), /not a valid gearbox/);
  assert.deepEqual(http.requested, []);
  await client.close();
});

test('several body types go out as one OR filter and are checked against what Otomoto applied', async () => {
  const http = new FixtureHttpClient({
    appliedFilters: [
      { name: 'filter_enum_body_type', value: 'suv' },
      { name: 'filter_enum_body_type', value: 'combi' },
    ],
  });
  const client = await connect(http);
  const result = await client.callTool({
    name: 'otomoto_search',
    arguments: { filters: { make: 'lexus', bodyType: ['suv', 'combi'] }, verifySellers: false },
  });
  assert.notEqual((result as { isError?: boolean }).isError, true, textOf(result));
  assert.deepEqual(http.requested, [
    'https://www.otomoto.pl/osobowe/lexus?search%5Bfilter_enum_body_type%5D%5B0%5D=suv' +
      '&search%5Bfilter_enum_body_type%5D%5B1%5D=combi&search%5Border%5D=created_at_first%3Adesc',
  ]);
  await client.close();
});

test('an enum value Otomoto did not apply fails loudly instead of returning a wider search', async () => {
  const http = new FixtureHttpClient({ appliedFilters: [{ name: 'filter_enum_body_type', value: 'suv' }] });
  const client = await connect(http);
  const result = await client.callTool({
    name: 'otomoto_search',
    arguments: { filters: { make: 'lexus', bodyType: ['suv', 'combi'] }, verifySellers: false },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /FILTER_NOT_APPLIED/);
  assert.match(textOf(result), /did not apply bodyType "combi" \(it applied "suv" for filter_enum_body_type\)/);
  await client.close();
});

test('a city search reports the place Otomoto searched around', async () => {
  const http = new FixtureHttpClient({ searchLocation: { value: KRAKOW_APPLIED_LOCATION } });
  const client = await connect(http);
  const payload = jsonOf(
    await client.callTool({
      name: 'otomoto_search',
      arguments: { filters: { make: 'lexus', city: 'Kraków', radiusKm: 50 }, verifySellers: false },
    }),
  );
  assert.deepEqual(http.requested, [
    'https://www.otomoto.pl/osobowe/lexus/krakow?search%5Bdist%5D=50&search%5Border%5D=created_at_first%3Adesc',
  ]);
  assert.deepEqual(payload['appliedLocation'], {
    city: { id: 8959, name: 'Kraków', slug: 'krakow' },
    subregion: { id: 102, name: 'Kraków', slug: 'krakow' },
    region: { id: 4, name: 'Małopolskie', slug: 'malopolskie' },
  });
  await client.close();
});

test('a city Otomoto does not recognise fails loudly instead of returning all of Poland', async () => {
  const http = new FixtureHttpClient({ searchLocation: { value: null } });
  const client = await connect(http);
  const result = await client.callTool({
    name: 'otomoto_search',
    arguments: { filters: { city: 'nieistniejace-miasto', radiusKm: 25 } },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  const text = textOf(result);
  assert.match(text, /UNKNOWN_LOCATION/);
  assert.match(text, /did not recognise city "nieistniejace-miasto"/);
  assert.match(text, /Results were discarded, not empty/);
  assert.doesNotMatch(text, /"listings"/);
  assert.equal(http.requested.length, 1);
  await client.close();
});

test('an unknown cityId fails the same way', async () => {
  const client = await connect(new FixtureHttpClient({ searchLocation: { value: null } }));
  const result = await client.callTool({
    name: 'otomoto_price_stats',
    arguments: { filters: { cityId: 99_999_999, radiusKm: 50 } },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /did not recognise cityId 99999999/);
  await client.close();
});

test('otomoto_price_stats carries the applied location', async () => {
  const client = await connect(new FixtureHttpClient({ searchLocation: { value: KRAKOW_APPLIED_LOCATION } }));
  const payload = jsonOf(
    await client.callTool({
      name: 'otomoto_price_stats',
      arguments: { filters: { make: 'lexus', city: 'krakow', radiusKm: 50 } },
    }),
  );
  assert.equal((payload['appliedLocation'] as { city: { id: number } }).city.id, 8959);
  await client.close();
});

const BROKER_TEXT = 'Oferta poglądowa, dotyczy sprowadzenia takiego modelu w dowolnej specyfikacji.';

interface ScreeningPayload {
  excludedCount: number;
  excluded: {
    kind: string;
    source: string;
    evidence: string;
    seller: { id: string; name: string | null } | null;
    listings: { id: string; title: string }[];
  }[];
  sellerChecks: { sellerId: string; importToOrder: boolean; sampleComplete: boolean }[];
  sellersNotChecked: { reason: string }[];
}

test('by default otomoto_search samples every dealer and keeps an honest page whole', async () => {
  const http = new FixtureHttpClient();
  const client = await connect(http);
  const payload = jsonOf(
    await client.callTool({ name: 'otomoto_search', arguments: { filters: { make: 'lexus', model: 'lc' } } }),
  );
  const screening = payload['screening'] as ScreeningPayload;
  const listings = payload['listings'] as { seller: { id: string; professional: boolean } }[];
  const rowsPerDealer = new Map<string, number>();
  for (const row of listings.filter((listing) => listing.seller.professional)) {
    rowsPerDealer.set(row.seller.id, (rowsPerDealer.get(row.seller.id) ?? 0) + 1);
  }
  const wanted = [...rowsPerDealer.values()].reduce((sum, rows) => sum + Math.min(rows, SELLER_SAMPLE_SIZE), 0);
  // The fixture page has 11 dealers, and their full samples fit in one call.
  assert.equal(rowsPerDealer.size, 11);
  assert.ok(wanted <= MAX_LISTING_READS_PER_CALL);
  assert.equal(http.detailRequests.length, wanted);
  assert.equal(screening.sellerChecks.length, 11);
  assert.ok(screening.sellerChecks.every((check) => check.sampleComplete));
  assert.equal(screening.sellersNotChecked.length, 0);
  assert.equal(screening.excludedCount, 0);
  assert.equal(payload['returned'], 20);
  await client.close();
});

test('a dealer whose listing reads as import-to-order loses every row, with the reason attached', async () => {
  const client = await connect(new FixtureHttpClient({ descriptionPrefix: BROKER_TEXT }));
  const payload = jsonOf(
    await client.callTool({ name: 'otomoto_search', arguments: { filters: { make: 'lexus', model: 'lc' } } }),
  );
  const screening = payload['screening'] as ScreeningPayload;
  const listings = payload['listings'] as { seller: { professional: boolean } }[];

  assert.ok(screening.sellerChecks.every((check) => check.importToOrder));
  assert.ok(screening.excludedCount >= 8);
  assert.equal(payload['totalCount'], 20, 'totalCount stays what Otomoto reported');
  assert.equal(payload['returned'], 20 - screening.excludedCount);
  assert.equal(screening.excluded.length, screening.sellerChecks.length, 'one entry per broker dealer');
  for (const group of screening.excluded) {
    assert.equal(group.kind, 'import_to_order');
    assert.ok(group.seller, 'a dealer verdict names the dealer');
    assert.match(group.evidence, /Oferta poglądowa/);
  }
  assert.equal(
    screening.excluded.reduce((total, group) => total + group.listings.length, 0),
    screening.excludedCount,
  );
  assert.ok(listings.some((row) => !row.seller.professional), 'private sellers are untouched');
  await client.close();
});

test('exclude [] keeps the broker rows and still flags them', async () => {
  const client = await connect(new FixtureHttpClient({ descriptionPrefix: BROKER_TEXT }));
  const payload = jsonOf(
    await client.callTool({
      name: 'otomoto_search',
      arguments: { filters: { make: 'lexus', model: 'lc' }, exclude: [] },
    }),
  );
  const listings = payload['listings'] as { flags: { kind: string }[] }[];
  assert.equal(payload['returned'], 20);
  assert.ok(listings.some((row) => row.flags.some((flag) => flag.kind === 'import_to_order')));
  await client.close();
});

test('otomoto_price_stats leaves screened-out rows out of the sample and says how many', async () => {
  const client = await connect(new FixtureHttpClient({ descriptionPrefix: BROKER_TEXT }));
  const payload = jsonOf(
    await client.callTool({ name: 'otomoto_price_stats', arguments: { filters: { make: 'lexus', model: 'lc' } } }),
  );
  const screening = payload['screening'] as ScreeningPayload;
  assert.equal(payload['rowsFetched'], 20);
  assert.equal(payload['sampleSize'], 20 - screening.excludedCount);
  assert.equal(payload['sampleIsPartial'], false, 'every row was read, even if not all were kept');
  assert.match(String(payload['sampleNote']), new RegExp(`${screening.excludedCount} more left out by screening`));
  await client.close();
});

test('otomoto_listing flags a broker ad from its description', async () => {
  const client = await connect(new FixtureHttpClient({ descriptionPrefix: BROKER_TEXT }));
  const payload = jsonOf(
    await client.callTool({ name: 'otomoto_listing', arguments: { idOrUrl: '6148596129' } }),
  );
  const flags = payload['flags'] as { kind: string; source: string }[];
  assert.deepEqual(flags.map((flag) => [flag.kind, flag.source]), [['import_to_order', 'description']]);
  await client.close();
});

test('an excludeSellerIds entry that is not a seller id is rejected before any request', async () => {
  const http = new FixtureHttpClient();
  const client = await connect(http);
  const result = await client.callTool({
    name: 'otomoto_search',
    arguments: { filters: { make: 'lexus' }, excludeSellerIds: ['Broker Motors'] },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.deepEqual(http.requested, []);
  await client.close();
});

test('the client passes redaction through to the text it returns', async () => {
  const plain = await new OtomotoClient(new FixtureHttpClient(), { redactContacts: false }).listing('6148596129');
  const redacted = await new OtomotoClient(new FixtureHttpClient(), { redactContacts: true }).listing('6148596129');
  assert.doesNotMatch(plain.description ?? '', /contact details removed/);
  assert.match(redacted.description ?? '', /contact details removed/);
});

test('otomoto_listing resolves a numeric id into a listing URL and returns detail', async () => {
  const http = new FixtureHttpClient();
  const client = await connect(http);
  const payload = jsonOf(
    await client.callTool({ name: 'otomoto_listing', arguments: { idOrUrl: '6148596129' } }),
  );
  assert.equal(payload['id'], '6148596129');
  assert.equal(payload['price'], 464_900);
  assert.deepEqual(payload['flags'], []);
  assert.equal(http.requested[0], 'https://www.otomoto.pl/osobowe/oferta/offer-ID6I6SJj.html');
  await client.close();
});

test('otomoto_price_stats reports the sample it actually measured', async () => {
  const client = await connect(new FixtureHttpClient());
  const payload = jsonOf(
    await client.callTool({
      name: 'otomoto_price_stats',
      arguments: { filters: { make: 'lexus', model: 'lc' } },
    }),
  );
  assert.equal(payload['sampleSize'], 20);
  assert.equal(payload['pagesFetched'], 1);
  assert.equal(payload['totalCount'], 20);
  assert.equal(payload['sampleIsPartial'], false);
  const price = payload['price'] as Record<string, number>;
  assert.equal(price['count'], 20);
  assert.equal(price['min'], 135_000);
  assert.equal(price['max'], 690_000);
  assert.ok(price['median'] > price['min'] && price['median'] < price['max']);
  assert.match(String(payload['sampleNote']), /Computed from 20 listings on 1 page/);
  await client.close();
});

test('otomoto_price_stats refuses to page a reshuffling sort before making a request', async () => {
  const http = new FixtureHttpClient();
  const client = await connect(http);
  const result = await client.callTool({
    name: 'otomoto_price_stats',
    arguments: { filters: { make: 'lexus', sort: 'relevance_web' }, maxPages: 2 },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /reshuffles between requests/);
  assert.deepEqual(http.requested, []);
  await client.close();
});

test('otomoto_filter_options answers from the checked-in vocabulary', async () => {
  const http = new FixtureHttpClient();
  const client = await connect(http);

  const index = jsonOf(await client.callTool({ name: 'otomoto_filter_options', arguments: {} }));
  assert.ok(Array.isArray(index['enumFilters']));
  assert.ok(Array.isArray(index['sort']));

  const gearbox = jsonOf(
    await client.callTool({ name: 'otomoto_filter_options', arguments: { field: 'gearbox' } }),
  );
  assert.deepEqual(gearbox['values'], [
    { value: 'automatic', label: 'Automatyczna' },
    { value: 'manual', label: 'Manualna' },
  ]);

  const models = jsonOf(
    await client.callTool({
      name: 'otomoto_filter_options',
      arguments: { field: 'model', make: 'lexus' },
    }),
  );
  assert.ok((models['values'] as string[]).includes('lc'));

  // No field lookup may touch the network.
  assert.deepEqual(http.requested, []);
  await client.close();
});

test('otomoto_filter_options asks for a make before listing models', async () => {
  const client = await connect(new FixtureHttpClient());
  const result = await client.callTool({
    name: 'otomoto_filter_options',
    arguments: { field: 'model' },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /field "model" needs a make/);
  await client.close();
});

test('a page whose payload is gone surfaces as a loud parser failure, never as no results', async () => {
  const client = await connect(new BrokenHttpClient());
  const result = await client.callTool({
    name: 'otomoto_search',
    arguments: { filters: { make: 'lexus' } },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  const text = textOf(result);
  assert.match(text, /PARSER_CONTRACT_ERROR/);
  assert.match(text, /otomoto-mcp needs an update/);
  assert.match(text, /NOT an empty result/);
  assert.doesNotMatch(text, /"listings"/);
  await client.close();
});
