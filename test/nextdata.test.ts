import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ParserContractError } from '../src/errors.ts';
import { extractNextData, findAdvert, findSearchResult } from '../src/nextdata.ts';
import { loadFixture } from './fixtures.ts';

test('extracts the Next.js payload from a real search page', () => {
  const nextData = extractNextData(loadFixture('search-lexus-lc'));
  assert.ok(nextData['props']);
});

test('locates the search result payload by shape', () => {
  const result = findSearchResult(extractNextData(loadFixture('search-lexus-lc')));
  assert.equal(typeof result.totalCount, 'number');
  assert.ok(result.totalCount! > 0);
  assert.ok(result.edges.length > 0);
});

test('locates the advert on a real listing page', () => {
  const advert = findAdvert(extractNextData(loadFixture('detail-lexus-lc')));
  assert.equal(typeof advert['id'], 'string');
  assert.ok(advert['parametersDict']);
});

test('a listing page has no urqlState, so the search parser must refuse it', () => {
  const nextData = extractNextData(loadFixture('detail-lexus-lc'));
  assert.throws(() => findSearchResult(nextData), ParserContractError);
});

test('fails loudly when the __NEXT_DATA__ script tag is gone', () => {
  assert.throws(
    () => extractNextData(loadFixture('drift-no-next-data'), 'https://example.test/page'),
    (error: unknown) => {
      assert.ok(error instanceof ParserContractError);
      assert.match(error.message, /no __NEXT_DATA__ script tag/);
      assert.match(error.message, /otomoto-mcp needs an update/);
      assert.equal(error.url, 'https://example.test/page');
      return true;
    },
  );
});

test('fails loudly - never returns zero results - when the search payload is renamed', () => {
  const nextData = extractNextData(loadFixture('drift-renamed-search-payload'));
  assert.throws(
    () => findSearchResult(nextData),
    (error: unknown) => {
      assert.ok(error instanceof ParserContractError);
      assert.match(error.message, /no \{ edges, pageInfo \} object found/);
      return true;
    },
  );
});

test('fails loudly when __NEXT_DATA__ is not valid JSON', () => {
  const html = '<script id="__NEXT_DATA__" type="application/json">{"props":</script>';
  assert.throws(() => extractNextData(html), /not valid JSON/);
});
