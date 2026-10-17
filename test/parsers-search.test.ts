import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ParserContractError } from '../src/errors.ts';
import { extractNextData } from '../src/nextdata.ts';
import { parseSearchPage } from '../src/parsers/search.ts';
import { KRAKOW_APPLIED_LOCATION, loadFixture, withAppliedLocation } from './fixtures.ts';

const SEARCH_URL = 'https://www.otomoto.pl/osobowe/lexus/lc';

function parseFixture(name = 'search-lexus-lc', page = 1) {
  return parseSearchPage(extractNextData(loadFixture(name)), {
    page,
    requestedUrl: SEARCH_URL,
    resolvedUrl: SEARCH_URL,
  });
}

test('parses every Advert row out of a real search page', () => {
  const result = parseFixture();
  assert.equal(result.totalCount, 20);
  assert.equal(result.listings.length, 20);
  assert.equal(result.pageSize, 32);
  assert.equal(result.page, 1);
  assert.equal(result.hasMorePages, false);
});

test('normalises a search row into typed fields', () => {
  const listing = parseFixture().listings.find((row) => row.id === '6148596129');
  assert.ok(listing, 'the fixture row is present');
  assert.equal(listing.title, 'Lexus LC 500 Bespoke');
  assert.equal(listing.make, 'lexus');
  assert.equal(listing.model, 'lc');
  assert.equal(listing.url, 'https://www.otomoto.pl/osobowe/oferta/lexus-lc-ID6I6SJj.html');
  assert.equal(listing.price, 464_900);
  assert.equal(listing.currency, 'PLN');
  assert.equal(listing.year, 2022);
  assert.equal(listing.mileageKm, 75_100);
  assert.equal(listing.fuelType, 'petrol');
  assert.equal(listing.fuelTypeLabel, 'Benzyna');
  assert.equal(listing.gearbox, 'automatic');
  assert.equal(listing.enginePowerHp, 464);
  assert.equal(listing.engineCapacityCm3, 4969);
  assert.equal(listing.version, 'ver-500-bespoke');
  assert.equal(listing.versionLabel, '500 Bespoke');
  assert.equal(listing.countryOrigin, 'pl');
  assert.equal(listing.location.city, 'Kraków');
  assert.equal(listing.location.region, 'Małopolskie');
  assert.deepEqual(listing.seller, {
    id: '15965094',
    type: 'PROFESSIONAL',
    professional: true,
    name: 'LEXUS KRAKÓW-ZAKOPIAŃSKA',
    pageUrl: 'https://lexuszakopianska.otomoto.pl',
  });
  assert.equal(listing.createdAt, '2026-10-10T11:33:07Z');
});

test('every row says who sells it; private sellers have an id but no name', () => {
  const listings = parseFixture().listings;
  for (const listing of listings) {
    assert.ok(listing.seller.id, `${listing.id} has a seller id`);
    assert.ok(listing.seller.type === 'PRIVATE' || listing.seller.type === 'PROFESSIONAL');
  }
  const privateRows = listings.filter((listing) => listing.seller.type === 'PRIVATE');
  assert.ok(privateRows.length > 0, 'the fixture has private sellers');
  for (const listing of privateRows) {
    assert.equal(listing.seller.name, null);
    assert.equal(listing.seller.pageUrl, null);
    assert.equal(listing.seller.professional, false);
  }
});

test("Otomoto's price verdict is carried through, and NONE becomes null", () => {
  const verdicts = new Map<string | null, number>();
  for (const listing of parseFixture().listings) {
    verdicts.set(listing.priceEvaluation, (verdicts.get(listing.priceEvaluation) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(verdicts), { ABOVE: 2, BELOW: 1, IN: 8, null: 9 });
});

test('price is an integer PLN amount on every row, never a string', () => {
  for (const listing of parseFixture().listings) {
    if (listing.price === null) continue;
    assert.equal(typeof listing.price, 'number');
    assert.ok(Number.isInteger(listing.price), `${listing.id} price is an integer`);
    assert.ok(listing.price > 0);
  }
});

test('reports what Otomoto says it applied, and whether it widened the query', () => {
  const result = parseFixture();
  const applied = result.appliedFilters.map((filter) => filter.name);
  assert.ok(applied.includes('filter_enum_make'));
  assert.ok(applied.includes('filter_enum_model'));
  assert.equal(result.relaxationApplied, false);
});

test('hasMorePages is derived from totalCount against the page size', () => {
  const synthetic = (totalCount: number, page: number) =>
    parseSearchPage(
      {
        props: {
          pageProps: {
            urqlState: {
              key: { data: { advertSearch: { edges: [], pageInfo: { pageSize: 32 }, totalCount } } },
            },
          },
        },
      },
      { page, requestedUrl: SEARCH_URL, resolvedUrl: SEARCH_URL },
    );

  assert.equal(synthetic(100, 1).hasMorePages, true);
  assert.equal(synthetic(100, 3).hasMorePages, true);
  assert.equal(synthetic(100, 4).hasMorePages, false);
  assert.equal(synthetic(32, 1).hasMorePages, false);
});

test('a drifted search payload raises rather than reporting zero listings', () => {
  assert.throws(
    () =>
      parseSearchPage(extractNextData(loadFixture('drift-renamed-search-payload')), {
        page: 1,
        requestedUrl: SEARCH_URL,
        resolvedUrl: SEARCH_URL,
      }),
    ParserContractError,
  );
});

function parseWithLocation(location: unknown) {
  return parseSearchPage(extractNextData(withAppliedLocation(loadFixture('search-lexus-lc'), location)), {
    page: 1,
    requestedUrl: SEARCH_URL,
    resolvedUrl: SEARCH_URL,
    expectLocation: true,
  });
}

test('a search that names no place reports no applied location', () => {
  assert.equal(parseFixture().appliedLocation, null);
});

test('the applied location is reported with its powiat and voivodeship', () => {
  assert.deepEqual(parseWithLocation(KRAKOW_APPLIED_LOCATION).appliedLocation, {
    city: { id: 8959, name: 'Kraków', slug: 'krakow' },
    subregion: { id: 102, name: 'Kraków', slug: 'krakow' },
    region: { id: 4, name: 'Małopolskie', slug: 'malopolskie' },
  });
});

test('a location search on a page without the appliedLocation key is a contract failure', () => {
  assert.throws(
    () => parseWithLocation(undefined),
    (error: unknown) => error instanceof ParserContractError && /appliedLocation missing/.test(error.message),
  );
});
