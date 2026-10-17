import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidArgumentError } from '../src/errors.ts';
import { decodeListingId, encodeListingId, resolveListingUrl } from '../src/listing-id.ts';

/** Ground truth measured live: numeric id 6148596129 is "6I6SJj" in its listing URL. */
test('base62 round-trips a known real listing id', () => {
  assert.equal(encodeListingId('6148596129'), '6I6SJj');
  assert.equal(decodeListingId('6I6SJj'), '6148596129');
});

test('resolves a numeric search-result id into a listing URL', () => {
  assert.equal(
    resolveListingUrl('6148596129'),
    'https://www.otomoto.pl/osobowe/oferta/offer-ID6I6SJj.html',
  );
});

test('accepts the base62 id with or without the ID prefix', () => {
  const expected = 'https://www.otomoto.pl/osobowe/oferta/offer-ID6I6SJj.html';
  assert.equal(resolveListingUrl('6I6SJj'), expected);
  assert.equal(resolveListingUrl('ID6I6SJj'), expected);
});

test('passes a full listing URL through unchanged', () => {
  const url = 'https://www.otomoto.pl/osobowe/oferta/lexus-lc-ID6I6SJj.html';
  assert.equal(resolveListingUrl(url), url);
});

test('passes an ad carried over from OLX through unchanged', () => {
  // A search row links these as -OLX_ID<id>.html; the page is a normal Otomoto listing.
  const url = 'https://www.otomoto.pl/osobowe/oferta/opel-insignia-OLX_ID6Ih8hR.html';
  assert.equal(resolveListingUrl(url), url);
});

test('rejects a URL that is not an Otomoto listing', () => {
  assert.throws(() => resolveListingUrl('https://example.com/car'), InvalidArgumentError);
  assert.throws(
    () => resolveListingUrl('https://www.otomoto.pl/osobowe/lexus/lc'),
    InvalidArgumentError,
  );
});

test('rejects junk input instead of guessing', () => {
  assert.throws(() => resolveListingUrl(''), InvalidArgumentError);
  assert.throws(() => resolveListingUrl('lexus lc'), InvalidArgumentError);
});
