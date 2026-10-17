import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ParserContractError } from '../src/errors.ts';
import { extractNextData } from '../src/nextdata.ts';
import { parseListingPage } from '../src/parsers/detail.ts';
import { loadFixture } from './fixtures.ts';

const DETAIL_URL = 'https://www.otomoto.pl/osobowe/oferta/lexus-lc-ID6I6SJj.html';

function parseDetail(name = 'detail-lexus-lc') {
  return parseListingPage(extractNextData(loadFixture(name)), DETAIL_URL);
}

test('parses a real listing page', () => {
  const detail = parseDetail();
  assert.equal(detail.id, '6148596129');
  assert.equal(detail.url, DETAIL_URL);
  assert.equal(detail.title, 'Lexus LC 500 Bespoke');
  assert.equal(detail.status, 'ACTIVE');
  assert.equal(detail.createdAt, '2026-10-10T11:33:07Z');
  assert.equal(detail.originalCreatedAt, '2026-06-12T11:04:36Z');
  assert.ok(detail.updatedAt);
  assert.ok(detail.description && detail.description.length > 100);
  assert.equal(detail.verifiedCar, false);
});

test('the string price on a listing page lands as the same integer PLN as the search page', () => {
  const detail = parseDetail();
  assert.equal(detail.price, 464_900);
  assert.equal(typeof detail.price, 'number');
  assert.equal(detail.currency, 'PLN');
  assert.deepEqual(detail.priceLabels, ['Faktura VAT']);
});

test('parametersDict carries both specs and equipment flags', () => {
  const { parameters } = parseDetail();
  assert.equal(parameters['fuel_type']?.value, 'petrol');
  assert.equal(parameters['fuel_type']?.valueLabel, 'Benzyna');
  assert.equal(parameters['mileage']?.value, '75100');
  assert.equal(parameters['mileage']?.valueLabel, '75 100 km');
  assert.equal(parameters['body_type']?.value, 'coupe');
  // A boolean-ish equipment flag lives in the same map as the specs.
  assert.equal(parameters['heated_seat_driver']?.value, '1');
  assert.ok(Object.keys(parameters).length > 50);
});

test('encrypted tokens are dropped, not passed off as values', () => {
  const { parameters } = parseDetail();
  assert.equal(parameters['vin'], undefined);
  assert.equal(parameters['registration'], undefined);
  assert.equal(parameters['date_registration'], undefined);
  for (const parameter of Object.values(parameters)) {
    assert.doesNotMatch(
      parameter.value,
      /^[A-Za-z0-9+/=]{16,}\.\d+\.[A-Za-z0-9+/=]{12,}$/,
      `${parameter.key} is not an encrypted token`,
    );
  }
});

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

test("Otomoto's encrypted phone tokens are never surfaced", () => {
  const detail = parseDetail();
  assert.equal('phoneNumbers' in detail, false);
  assert.doesNotMatch(JSON.stringify(detail), /phoneNumber/i);
});

test('by default the contact details a dealer wrote into the description are kept', () => {
  // The fixture's dealer signs the description with two mobiles and two work emails.
  const description = parseDetail().description ?? '';
  assert.match(description, EMAIL);
  assert.doesNotMatch(description, /contact details removed/);
});

test('with redaction on, the description carries no phone or e-mail', () => {
  const detail = parseListingPage(extractNextData(loadFixture('detail-lexus-lc')), DETAIL_URL, {
    redactContacts: true,
  });
  assert.doesNotMatch(JSON.stringify(detail), EMAIL);
  assert.match(detail.description ?? '', /\[contact details removed\]/);
});

test('sanitising the description keeps the car text and drops the HTML', () => {
  const description = parseDetail().description ?? '';
  assert.doesNotMatch(description, /<[^>]*>/);
  assert.match(description, /Autoryzowany dealer Lexus Kraków/);
  assert.match(description, /4969 ccm/);
  // Figures that merely look numeric must survive.
  assert.match(description, /464 KM/);
  assert.match(description, /21-calowych/);
});

test('equipment comes through as labelled groups', () => {
  const { equipment } = parseDetail();
  const audio = equipment.find((group) => group.key === 'audio_and_computing');
  assert.ok(audio);
  assert.equal(audio.label, 'Audio i multimedia');
  assert.ok(audio.items.some((item) => item.key === 'apple_carplay'));
  assert.equal(equipment.length, 5);
});

test('photos and seller summary', () => {
  const detail = parseDetail();
  assert.equal(detail.photoUrls.length, 39);
  assert.ok(detail.photoUrls.every((url) => url.startsWith('https://')));
  assert.equal(detail.seller.type, 'PROFESSIONAL');
  assert.equal(detail.seller.name, 'LEXUS KRAKÓW-ZAKOPIAŃSKA');
  assert.equal(detail.seller.professional, true);
});

test('price drop is normalised from grosze to whole PLN', () => {
  const { priceDrop } = parseDetail();
  assert.ok(priceDrop);
  assert.equal(priceDrop.percentage, 2.94);
  assert.equal(priceDrop.lowestPricePln, 479_000);
});

test('a listing page whose advert key was renamed fails loudly', () => {
  assert.throws(
    () => parseDetail('drift-detail-renamed-advert'),
    (error: unknown) => {
      assert.ok(error instanceof ParserContractError);
      assert.match(error.message, /pageProps\.advert missing/);
      assert.match(error.message, /otomoto-mcp needs an update/);
      assert.equal(error.url, DETAIL_URL);
      return true;
    },
  );
});

test('a listing page without parametersDict fails loudly instead of returning empty specs', () => {
  assert.throws(
    () => parseDetail('drift-detail-no-parameters'),
    (error: unknown) => {
      assert.ok(error instanceof ParserContractError);
      assert.match(error.message, /parametersDict missing/);
      return true;
    },
  );
});
