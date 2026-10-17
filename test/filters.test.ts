import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidArgumentError } from '../src/errors.ts';
import { buildSearchUrl } from '../src/filters.ts';
import type { SearchFilters } from '../src/types.ts';

/**
 * Expected URLs are written out in full, including percent-encoding, because the encoding is
 * the part that was measured against the live site.
 */
const ACCEPTED: { name: string; filters: SearchFilters; page?: number; expected: string }[] = [
  {
    name: 'no filters at all',
    filters: {},
    expected: 'https://www.otomoto.pl/osobowe?search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'make only',
    filters: { make: 'lexus' },
    expected: 'https://www.otomoto.pl/osobowe/lexus?search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'make and model as path segments, not query params',
    filters: { make: 'lexus', model: 'lc' },
    expected: 'https://www.otomoto.pl/osobowe/lexus/lc?search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'a price range',
    filters: { make: 'audi', model: 'a4-avant', priceFrom: 50_000, priceTo: 80_000 },
    expected:
      'https://www.otomoto.pl/osobowe/audi/a4-avant' +
      '?search%5Bfilter_float_price%3Afrom%5D=50000&search%5Bfilter_float_price%3Ato%5D=80000' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'an open-ended range sends only the bound that was given',
    filters: { make: 'audi', yearFrom: 2018 },
    expected:
      'https://www.otomoto.pl/osobowe/audi?search%5Bfilter_float_year%3Afrom%5D=2018' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'enum filters',
    filters: { make: 'audi', fuelType: 'diesel', gearbox: 'automatic', mileageTo: 150_000 },
    expected:
      'https://www.otomoto.pl/osobowe/audi' +
      '?search%5Bfilter_float_mileage%3Ato%5D=150000' +
      '&search%5Bfilter_enum_fuel_type%5D=diesel' +
      '&search%5Bfilter_enum_gearbox%5D=automatic' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'condition and seller type use their own non-prefixed filter ids',
    filters: { condition: 'used', sellerType: 'private' },
    expected:
      'https://www.otomoto.pl/osobowe?search%5Bnew_used%5D=used&search%5Bprivate_business%5D=private' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'the enums escape hatch reaches filters without a named field',
    filters: { make: 'audi', enums: { color: 'black', transmission: 'all-wheel-permanent' } },
    expected:
      'https://www.otomoto.pl/osobowe/audi' +
      '?search%5Bfilter_enum_color%5D=black' +
      '&search%5Bfilter_enum_transmission%5D=all-wheel-permanent' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'several values of one enum filter are indexed, which Otomoto reads as OR',
    filters: { bodyType: ['suv', 'combi'], enums: { color: ['black', 'white'] } },
    expected:
      'https://www.otomoto.pl/osobowe' +
      '?search%5Bfilter_enum_body_type%5D%5B0%5D=suv&search%5Bfilter_enum_body_type%5D%5B1%5D=combi' +
      '&search%5Bfilter_enum_color%5D%5B0%5D=black&search%5Bfilter_enum_color%5D%5B1%5D=white' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'a one-value list is the plain form',
    filters: { fuelType: ['diesel'] },
    expected:
      'https://www.otomoto.pl/osobowe?search%5Bfilter_enum_fuel_type%5D=diesel' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'sort',
    filters: { make: 'audi', sort: 'filter_float_price:asc' },
    expected: 'https://www.otomoto.pl/osobowe/audi?search%5Border%5D=filter_float_price%3Aasc',
  },
  {
    name: 'Otomoto\'s own relevance order, on page 1',
    filters: { make: 'audi', sort: 'relevance_web' },
    expected: 'https://www.otomoto.pl/osobowe/audi?search%5Border%5D=relevance_web',
  },
  {
    name: 'geo radius needs both dist and city_id',
    filters: { make: 'audi', cityId: 17871, radiusKm: 50 },
    expected:
      'https://www.otomoto.pl/osobowe/audi?search%5Bdist%5D=50&search%5Bcity_id%5D=17871' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'a city is the last path segment, with the radius as a query param',
    filters: { city: 'krakow', radiusKm: 50 },
    expected:
      'https://www.otomoto.pl/osobowe/krakow?search%5Bdist%5D=50' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'a city after make and model',
    filters: { make: 'toyota', model: 'corolla', city: 'warszawa', radiusKm: 25 },
    expected:
      'https://www.otomoto.pl/osobowe/toyota/corolla/warszawa?search%5Bdist%5D=25' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'a Polish city name becomes Otomoto\'s slug',
    filters: { make: 'toyota', city: ' Łódź ', radiusKm: 10 },
    expected:
      'https://www.otomoto.pl/osobowe/toyota/lodz?search%5Bdist%5D=10' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'a multi-word city name is hyphenated',
    filters: { city: 'Nowa Wieś', radiusKm: 5 },
    expected:
      'https://www.otomoto.pl/osobowe/nowa-wies?search%5Bdist%5D=5' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'a hyphenated city keeps its hyphen',
    filters: { city: 'Bielsko-Biała', radiusKm: 15 },
    expected:
      'https://www.otomoto.pl/osobowe/bielsko-biala?search%5Bdist%5D=15' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'page 1 carries no page param',
    filters: { make: 'lexus' },
    page: 1,
    expected: 'https://www.otomoto.pl/osobowe/lexus?search%5Border%5D=created_at_first%3Adesc',
  },
  {
    name: 'later pages carry ?page=N',
    filters: { make: 'lexus' },
    page: 3,
    expected:
      'https://www.otomoto.pl/osobowe/lexus' +
      '?search%5Border%5D=created_at_first%3Adesc&page=3',
  },
  {
    name: 'engine power and capacity',
    filters: { make: 'mazda', model: 'mx-5', enginePowerFrom: 180, engineCapacityFrom: 1800 },
    expected:
      'https://www.otomoto.pl/osobowe/mazda/mx-5' +
      '?search%5Bfilter_float_engine_power%3Afrom%5D=180' +
      '&search%5Bfilter_float_engine_capacity%3Afrom%5D=1800' +
      '&search%5Border%5D=created_at_first%3Adesc',
  },
];

for (const accepted of ACCEPTED) {
  test(`builds a URL: ${accepted.name}`, () => {
    assert.equal(buildSearchUrl(accepted.filters, accepted.page ?? 1), accepted.expected);
  });
}

/**
 * Rejections matter more than the happy path. Otomoto ignores filters it does not recognise
 * and answers HTTP 200, so anything dropped here comes back as a working query with wrong
 * results.
 */
const REJECTED: { name: string; filters: unknown; page?: number; message: RegExp }[] = [
  {
    name: 'an unknown filter field',
    filters: { make: 'audi', colour: 'black' },
    message: /unknown filter field\(s\): colour/,
  },
  {
    name: 'an unknown make',
    filters: { make: 'teslaa' },
    message: /unknown make "teslaa"/,
  },
  {
    name: 'a make that is not a slug',
    filters: { make: 'Alfa Romeo' },
    message: /must be a lowercase Otomoto slug/,
  },
  {
    name: 'a model family that Otomoto splits into variants',
    filters: { make: 'audi', model: 'a4' },
    message: /unknown model "a4" for make "audi".*Did you mean.*a4-avant/s,
  },
  {
    name: 'a model without a make',
    filters: { model: 'a4-avant' },
    message: /model requires make/,
  },
  {
    name: 'an invented enum value',
    filters: { gearbox: 'stick' },
    message: /"stick" is not a valid gearbox\. Valid values: automatic, manual/,
  },
  {
    name: 'a list with one invented value',
    filters: { bodyType: ['suv', 'pickup'] },
    message: /"pickup" is not a valid body_type/,
  },
  {
    name: 'a comma-joined list, which Otomoto would answer with zero rows',
    filters: { bodyType: 'suv,combi' },
    message: /"suv,combi" is not a valid body_type/,
  },
  {
    name: 'an empty list',
    filters: { bodyType: [] },
    message: /bodyType is an empty list/,
  },
  {
    name: 'the same value twice',
    filters: { enums: { color: ['black', 'black'] } },
    message: /enums\.color lists the same value twice/,
  },
  {
    name: 'a list with a non-string in it',
    filters: { fuelType: ['diesel', 7] },
    message: /fuelType must be a string or a list of strings/,
  },
  {
    name: 'an unknown enum filter key',
    filters: { enums: { paint_finish: 'matt' } },
    message: /unknown filter "paint_finish"/,
  },
  {
    name: 'a named enum field and an enums entry for the same filter',
    filters: { fuelType: 'petrol', enums: { fuel_type: 'diesel' } },
    message: /filter "fuel_type" is set twice: fuelType="petrol" and enums\.fuel_type="diesel"/,
  },
  {
    name: 'the same filter set twice even when the values agree',
    filters: { gearbox: 'automatic', enums: { gearbox: 'automatic' } },
    message: /filter "gearbox" is set twice/,
  },
  {
    name: 'a year outside any plausible range',
    filters: { yearFrom: 1850 },
    message: /yearFrom must be between 1900 and/,
  },
  {
    name: 'a price in grosze',
    filters: { priceTo: 5_000_000_000 },
    message: /priceTo must be between 0 and 100000000/,
  },
  {
    name: 'a non-integer year',
    filters: { yearFrom: 2018.5 },
    message: /yearFrom must be a whole number/,
  },
  {
    name: 'an inverted range',
    filters: { priceFrom: 80_000, priceTo: 50_000 },
    message: /priceFrom \(80000\) must not be greater than priceTo \(50000\)/,
  },
  {
    name: 'a radius with no city',
    filters: { radiusKm: 50 },
    message: /radiusKm needs a city or cityId/,
  },
  {
    name: 'a city with no radius, which Otomoto would widen to ~50 km',
    filters: { city: 'krakow' },
    message: /radiusKm is required with city/,
  },
  {
    name: 'a city id with no radius',
    filters: { cityId: 17871 },
    message: /radiusKm is required with cityId/,
  },
  {
    name: 'both a city and a city id',
    filters: { city: 'krakow', cityId: 17871, radiusKm: 50 },
    message: /either city or cityId, not both/,
  },
  {
    name: 'a city that cannot be a slug',
    filters: { city: 'Kraków!', radiusKm: 50 },
    message: /city must be a Polish place name or Otomoto slug/,
  },
  {
    name: 'an empty city',
    filters: { city: '  ', radiusKm: 50 },
    message: /city must be a Polish place name or Otomoto slug/,
  },
  {
    name: 'a radius Otomoto does not offer',
    filters: { cityId: 17871, radiusKm: 42 },
    message: /radiusKm must be one of 5, 10, 15, 25, 50/,
  },
  {
    name: 'an unknown sort',
    filters: { sort: 'price_asc' },
    message: /unknown sort "price_asc"/,
  },
  {
    name: 'paging a relevance order, which reshuffles between requests',
    filters: { make: 'audi', sort: 'relevance_web' },
    page: 2,
    message: /sort "relevance_web" reshuffles between requests.*default is created_at_first:desc/s,
  },
  {
    name: 'page 0',
    filters: { make: 'audi' },
    page: 0,
    message: /page must be an integer >= 1/,
  },
  {
    name: 'a string where a number belongs',
    filters: { priceFrom: '50000' },
    message: /priceFrom must be a finite number/,
  },
];

for (const rejected of REJECTED) {
  test(`rejects ${rejected.name}`, () => {
    assert.throws(
      () => buildSearchUrl(rejected.filters as SearchFilters, rejected.page ?? 1),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentError, `${rejected.name} raises InvalidArgumentError`);
        assert.match(error.message, rejected.message);
        return true;
      },
    );
  });
}

test('make and model never leak into the query string', () => {
  const url = buildSearchUrl({ make: 'audi', model: 'a4-avant', fuelType: 'diesel' });
  assert.doesNotMatch(url, /filter_enum_make/);
  assert.doesNotMatch(url, /filter_enum_model/);
  assert.ok(url.startsWith('https://www.otomoto.pl/osobowe/audi/a4-avant?'));
});
