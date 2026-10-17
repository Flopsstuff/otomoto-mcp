import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findInText,
  flagSearchRow,
  MAX_LISTING_READS_PER_CALL,
  mergeReports,
  newCheckBudget,
  Screener,
  SCREEN_KINDS,
  SELLER_SAMPLE_SIZE,
  type ScreenKind,
} from '../src/screening.ts';
import type { Listing, ListingDetail } from '../src/types.ts';

/**
 * The flag lists are quoted from live ads (2026-10-17). The keep lists are what an ordinary
 * dealer or private seller writes, and every one of them is a reason a pattern was narrowed.
 */
const FLAGGED: { text: string; kind: ScreenKind; rowOnly?: boolean }[] = [
  { text: 'Cesja leasingu | Toyota Corolla 2.0 Hybrid Executive/VIP/JBL/Skyview', kind: 'lease_transfer' },
  { text: 'Toyota Corolla 1.8 Hybrid 2020 comfort+tech cesja', kind: 'lease_transfer', rowOnly: true },
  { text: '8G-DCT Salon Polska I właściciel - wyjątkowa wersja! CESJA', kind: 'lease_transfer', rowOnly: true },
  { text: 'Discovery 3.0D 249 KM Dynamic SE | Cesja | 35 000 zł brutto', kind: 'lease_transfer', rowOnly: true },
  { text: 'Do przejęcia najem długoterminowy w Toyota Kinto', kind: 'lease_transfer' },
  { text: 'Oddam cesje wynajmu długoterminowego bez odstępnego', kind: 'lease_transfer' },
  { text: 'Przejęcie leasingu, zostało 14 rat', kind: 'lease_transfer' },
  { text: 'Leasing do przejęcia od zaraz', kind: 'lease_transfer' },
  { text: 'Odstępne 15 000 zł, rata 2 100 netto', kind: 'lease_transfer' },
  {
    text:
      'Oferta poglądowa, dotyczy sprowadzenia takiego modelu w dowolnej specyfikacji. Cena ' +
      'może się różnić w zależności od wersji wyposażenia.',
    kind: 'import_to_order',
  },
  {
    text: 'Jako firma Broker Motors oferujemy usługę sprowadzenia auta typowo pod wymagania klienta.',
    kind: 'import_to_order',
  },
  { text: 'Sprowadzimy dla Ciebie dowolne auto z USA lub Kanady', kind: 'import_to_order' },
  { text: 'Auto sprowadzamy na zamówienie klienta, czas realizacji 6-8 tygodni', kind: 'import_to_order' },
  { text: 'Samochód do sprowadzenia z aukcji Copart', kind: 'import_to_order' },
  { text: 'Przedstawiona oferta to przykładowa licytacja w USA.', kind: 'import_to_order' },
  { text: 'Przykładowa oferta licytacji w USA.', kind: 'import_to_order' },
  { text: 'Przedstawiona oferta to przykład licytacji w USA.', kind: 'import_to_order' },
  { text: 'Czas dostawy 8-10 tygodni. Oferta licytacji w USA.', kind: 'import_to_order' },
  {
    text: 'Szacunkowy koszt zakupu wraz z transportem pod wskazany adres wynosi około 49 000 zł.',
    kind: 'import_to_order',
  },
  { text: 'Ogłoszenie poglądowe – oferta dotyczy importu samochodu na zamówienie.', kind: 'import_to_order' },
  {
    text: 'Prezentowane zdjęcia, specyfikacja oraz cena mają charakter tylko i wyłącznie poglądowy.',
    kind: 'import_to_order',
  },
];

const KEPT: string[] = [
  'Auto sprowadzone z Niemiec, opłacone, gotowe do rejestracji',
  'Samochód sprowadzony w 2023, pierwszy właściciel w kraju',
  'Cena zawiera koszty sprowadzenia i opłaty celne',
  'Ogłoszenie nie stanowi oferty w rozumieniu art. 66 § 1 Kodeksu cywilnego.',
  'Możliwość leasingu i kredytu, FV23%',
  'Leasing, kredyt, zamiana - zapraszamy',
  'Samochód na zamówienie, termin dostawy 3 miesiące, salon Toyota',
  'Najem długoterminowy również dostępny w naszej ofercie',
  'Możliwa cesja gwarancji producenta na nowego właściciela',
  'Przejęcie auta możliwe od ręki, odbiór w salonie',
  'Salon Polska / Bezwypadkowy / Automat',
  'Comfort + TECH*2022*1.5 Benzyna*37 000 KM*Automat*FV23%*Salon Polska',
  'Zdjęcia mają charakter poglądowy.',
  'Cena do negocjacji, zdjęcia mają charakter poglądowy.',
  'Przedmiotowe zdjęcia mają jedynie charakter poglądowy.',
  'Auto kupione na aukcji w USA, sprowadzone i zarejestrowane w Polsce.',
  'Auto znajduje się w transporcie do Polski.',
];

for (const { text, kind, rowOnly } of FLAGGED) {
  test(`flags ${kind}: ${text.slice(0, 60)}`, () => {
    const rowFlags = flagSearchRow(listing({ shortDescription: text }));
    assert.deepEqual(rowFlags.map((flag) => flag.kind), [kind]);
    assert.match(rowFlags[0]!.evidence, /^«.+»$/);
    if (rowOnly !== true) {
      assert.deepEqual(findInText(text, 'description').map((flag) => flag.kind), [kind]);
    }
  });
}

for (const text of KEPT) {
  test(`keeps: ${text.slice(0, 60)}`, () => {
    assert.deepEqual(flagSearchRow(listing({ shortDescription: text })), []);
    assert.deepEqual(findInText(text, 'description'), []);
  });
}

test('a bare "cesja" counts in a teaser but not in a long description', () => {
  assert.equal(flagSearchRow(listing({ title: 'Audi A6 cesja' })).length, 1);
  assert.deepEqual(findInText('Audi A6, cesja możliwa po uzgodnieniu z bankiem', 'description'), []);
});

test('evidence quotes the original text, diacritics and case intact', () => {
  const [flag] = findInText('Bardzo ładne auto. Oferta POGLĄDOWA, cena orientacyjna.', 'description');
  assert.ok(flag);
  assert.match(flag.evidence, /Oferta POGLĄDOWA/);
});

test('evidence quotes what the ad says about itself before what the dealer also offers', () => {
  const [flag] = findInText(
    'Przedstawiona oferta to przykładowa licytacja w USA. Możemy wyszukać i sprowadzić podobny ' +
      'egzemplarz na zamówienie.',
    'description',
  );
  assert.match(flag?.evidence ?? '', /przykładowa licytacja/);
});

const NOW = new Date('2026-10-17T12:00:00Z');

test('a young car priced like an instalment is a lease transfer', () => {
  const [flag] = flagSearchRow(listing({ price: 1784, year: 2022 }), NOW);
  assert.equal(flag?.kind, 'lease_transfer');
  assert.equal(flag?.source, 'price');
  assert.match(flag?.evidence ?? '', /1784 PLN for a 2022 car/);
});

test('an old car at the same price is just cheap', () => {
  assert.deepEqual(flagSearchRow(listing({ price: 9000, year: 2012 }), NOW), []);
});

test('a young car at a real price is not flagged', () => {
  assert.deepEqual(flagSearchRow(listing({ price: 21_800, year: 2020 }), NOW), []);
});

test('a row with both a teaser and a price signal is flagged once per kind', () => {
  const flags = flagSearchRow(listing({ price: 9225, year: 2023, shortDescription: 'Cesja leasingu' }), NOW);
  assert.deepEqual(flags.map((flag) => flag.kind), ['lease_transfer']);
});

/* ---- dealer verification ---- */

const BROKER_TEXT = 'Oferta poglądowa, dotyczy sprowadzenia takiego modelu w dowolnej specyfikacji.';

function fakeFetcher(descriptions: Record<string, string>) {
  const requested: string[] = [];
  const fetchListing = async (url: string): Promise<ListingDetail> => {
    requested.push(url);
    const description = descriptions[url];
    if (description === undefined) throw new Error(`no fake for ${url}`);
    return detail(url, description);
  };
  return { requested, fetchListing };
}

const ALL = { exclude: SCREEN_KINDS, excludeSellerIds: [], verifySellers: true };

test('the first ad that shows a broker settles it, and the verdict covers every ad of that dealer', async () => {
  const rows = [
    dealerRow('1', 'broker', 'Broker Motors'),
    dealerRow('2', 'broker', 'Broker Motors'),
    dealerRow('3', 'broker', 'Broker Motors'),
    dealerRow('4', 'honest', 'BMW Inchcape'),
    privateRow('5'),
  ];
  const { requested, fetchListing } = fakeFetcher({ [url('1')]: BROKER_TEXT, [url('4')]: 'Salon Polska, serwis ASO.' });
  const result = await new Screener(fetchListing).screen(rows, ALL);

  assert.deepEqual(requested, [url('1'), url('4')], 'the dealer with the most rows is read first');
  assert.deepEqual(result.kept.map((row) => row.id), ['4', '5']);
  assert.equal(result.report.excludedCount, 3);
  assert.equal(result.report.excluded.length, 1, 'one dealer verdict is one entry');
  const [group] = result.report.excluded;
  assert.deepEqual(group?.seller, { id: 'broker', name: 'Broker Motors' });
  assert.equal(group?.kind, 'import_to_order');
  assert.match(group?.evidence ?? '', /Broker Motors writes in listing 1: «Oferta poglądowa/);
  assert.deepEqual(group?.listings.map((row) => row.id), ['1', '2', '3']);
  assert.deepEqual(
    result.report.sellerChecks.map((check) => [check.sellerId, check.importToOrder, check.sampleComplete, check.cached]),
    [
      ['broker', true, true, false],
      ['honest', false, true, false],
    ],
  );
});

test('a broker whose first ads say nothing is still found, reading round by round', async () => {
  const rows = [
    dealerRow('1', 'broker', 'Broker Motors'),
    dealerRow('2', 'broker', 'Broker Motors'),
    dealerRow('3', 'broker', 'Broker Motors'),
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((id) => dealerRow(id, 'honest', 'Big Dealer')),
  ];
  const descriptions = Object.fromEntries(rows.map((row) => [row.url, 'Auto znajduje się w transporcie.']));
  descriptions[url('3')] = BROKER_TEXT;
  const { requested, fetchListing } = fakeFetcher(descriptions);
  const result = await new Screener(fetchListing).screen(rows, ALL);

  assert.deepEqual(
    requested,
    [url('h1'), url('1'), url('h2'), url('2'), url('h3'), url('3'), url('h4')],
    'one more ad of each dealer per round, and none after the broker is settled',
  );
  assert.deepEqual(result.kept.map((row) => row.id), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const [honest, broker] = result.report.sellerChecks;
  assert.deepEqual(honest?.listingsRead, ['h1', 'h2', 'h3', 'h4']);
  assert.equal(honest?.listingsRead.length, SELLER_SAMPLE_SIZE);
  assert.equal(honest?.sampleComplete, true);
  assert.equal(broker?.evidenceListingId, '3');
  assert.match(result.report.excluded[0]?.evidence ?? '', /writes in listing 3: «Oferta poglądowa/);
});

test('a clean dealer seen on one row is read again when more of its ads turn up', async () => {
  const rows = ['1', '2', '3', '4', '5', '6'].map((id) => dealerRow(id, 'honest', 'Big Dealer'));
  const { requested, fetchListing } = fakeFetcher(Object.fromEntries(rows.map((row) => [row.url, 'Salon Polska.'])));
  const screener = new Screener(fetchListing);

  const first = await screener.screen(rows.slice(0, 1), ALL);
  assert.equal(first.report.sellerChecks[0]?.sampleComplete, true, 'every row it had was read');
  const second = await screener.screen(rows.slice(1), ALL);
  assert.deepEqual(requested, [url('1'), url('2'), url('3'), url('4')]);
  assert.deepEqual(second.report.sellerChecks[0]?.listingsRead, ['1', '2', '3', '4']);
  assert.equal(second.report.sellerChecks[0]?.cached, false);

  const third = await screener.screen(rows.slice(4), ALL);
  assert.equal(requested.length, SELLER_SAMPLE_SIZE, 'a settled clean dealer costs nothing');
  assert.equal(third.report.sellerChecks[0]?.cached, true);
});

test('a sample cut short by the budget says so', async () => {
  const rows = ['1', '2', '3', '4', '5'].map((id) => dealerRow(id, 'honest', 'Big Dealer'));
  const { requested, fetchListing } = fakeFetcher(Object.fromEntries(rows.map((row) => [row.url, 'Salon Polska.'])));
  const result = await new Screener(fetchListing).screen(rows, ALL, { remaining: 2 });

  assert.equal(requested.length, 2);
  const [check] = result.report.sellerChecks;
  assert.equal(check?.sampleComplete, false);
  assert.match(check?.incompleteReason ?? '', /over the limit/);
  assert.deepEqual(result.report.sellersNotChecked, []);
});

test('a dealer read once is not read again by the same server', async () => {
  const { requested, fetchListing } = fakeFetcher({ [url('1')]: BROKER_TEXT });
  const screener = new Screener(fetchListing);
  await screener.screen([dealerRow('1', 'broker', 'Broker Motors')], ALL);
  const second = await screener.screen([dealerRow('9', 'broker', 'Broker Motors')], ALL);

  assert.deepEqual(requested, [url('1')]);
  assert.equal(second.report.sellerChecks[0]?.cached, true);
  assert.equal(second.kept.length, 0);
});

test(`no more than ${MAX_LISTING_READS_PER_CALL} listings are read per call, and unread dealers are named`, async () => {
  const rows = Array.from({ length: MAX_LISTING_READS_PER_CALL + 3 }, (_, i) =>
    dealerRow(String(i), `dealer-${i}`, `Dealer ${i}`),
  );
  const descriptions = Object.fromEntries(rows.map((row) => [row.url, 'Salon Polska.']));
  const { requested, fetchListing } = fakeFetcher(descriptions);
  const result = await new Screener(fetchListing).screen(rows, ALL);

  assert.equal(requested.length, MAX_LISTING_READS_PER_CALL);
  assert.equal(result.report.sellersNotChecked.length, 3);
  assert.match(result.report.sellersNotChecked[0]!.reason, /over the limit/);
  assert.equal(result.kept.length, rows.length, 'an unread dealer is kept, not guessed at');
});

test('a budget shared across pages caps the whole call, not each page', async () => {
  const perPage = MAX_LISTING_READS_PER_CALL / 2 + 2;
  const page = (offset: number) =>
    Array.from({ length: perPage }, (_, i) => dealerRow(String(offset + i), `dealer-${offset + i}`, `Dealer ${offset + i}`));
  const rows = [...page(0), ...page(100)];
  const { requested, fetchListing } = fakeFetcher(Object.fromEntries(rows.map((row) => [row.url, 'Salon Polska.'])));
  const screener = new Screener(fetchListing);
  const budget = newCheckBudget();
  await screener.screen(page(0), ALL, budget);
  const second = await screener.screen(page(100), ALL, budget);
  assert.equal(requested.length, MAX_LISTING_READS_PER_CALL);
  assert.equal(second.report.sellersNotChecked.length, 2 * perPage - MAX_LISTING_READS_PER_CALL);
});

test('a dealer whose listing cannot be read is reported and kept, and asked about again later', async () => {
  const { requested, fetchListing } = fakeFetcher({});
  const screener = new Screener(fetchListing);
  const first = await screener.screen([dealerRow('1', 'flaky', 'Flaky Motors')], ALL);
  assert.equal(first.kept.length, 1);
  assert.match(first.report.sellersNotChecked[0]!.reason, /could not read listing 1/);

  await screener.screen([dealerRow('1', 'flaky', 'Flaky Motors')], ALL);
  assert.equal(requested.length, 2, 'a failure is not remembered as a verdict');
});

test('verifySellers false reads nothing and judges on row text alone', async () => {
  const { requested, fetchListing } = fakeFetcher({});
  const result = await new Screener(fetchListing).screen(
    [dealerRow('1', 'broker', 'Broker Motors'), privateRow('2', { shortDescription: 'Cesja leasingu' })],
    { ...ALL, verifySellers: false },
  );
  assert.deepEqual(requested, []);
  assert.deepEqual(result.kept.map((row) => row.id), ['1']);
});

test('exclude [] keeps every row but still says what each one is', async () => {
  const { fetchListing } = fakeFetcher({ [url('1')]: BROKER_TEXT });
  const result = await new Screener(fetchListing).screen(
    [dealerRow('1', 'broker', 'Broker Motors'), privateRow('2', { shortDescription: 'Cesja leasingu' })],
    { ...ALL, exclude: [] },
  );
  assert.equal(result.report.excludedCount, 0);
  assert.deepEqual(
    result.kept.map((row) => row.flags.map((flag) => flag.kind)),
    [['import_to_order'], ['lease_transfer']],
  );
});

test('excludeSellerIds drops a seller without reading their listings', async () => {
  const { requested, fetchListing } = fakeFetcher({});
  const result = await new Screener(fetchListing).screen(
    [dealerRow('1', '10000001', 'Broker Motors'), privateRow('2')],
    { ...ALL, excludeSellerIds: ['10000001'] },
  );
  assert.deepEqual(requested, []);
  assert.deepEqual(result.kept.map((row) => row.id), ['2']);
  assert.equal(result.report.excluded[0]?.kind, 'excluded_seller');
  assert.deepEqual(result.report.excluded[0]?.listings.map((row) => row.id), ['1']);
});

test('a row with no sellerLink is judged on its text and never read', async () => {
  const { requested, fetchListing } = fakeFetcher({});
  const row = dealerRow('1', 'x', 'X');
  row.seller = { id: null, type: null, professional: false, name: null, pageUrl: null };
  const result = await new Screener(fetchListing).screen([row], ALL);
  assert.deepEqual(requested, []);
  assert.equal(result.kept.length, 1);
});

test('rows excluded on their own text stay separate entries, each with its own quote', async () => {
  const { fetchListing } = fakeFetcher({});
  const result = await new Screener(fetchListing).screen(
    [
      privateRow('1', { shortDescription: 'Cesja leasingu Audi' }),
      privateRow('2', { shortDescription: 'Przejęcie leasingu od zaraz' }),
    ],
    ALL,
  );
  assert.equal(result.report.excluded.length, 2);
  assert.ok(result.report.excluded.every((group) => group.seller === null && group.listings.length === 1));
  assert.match(result.report.excluded[1]?.evidence ?? '', /Przejęcie leasingu/);
});

test('one dealer excluded on two pages is one entry in the merged report', async () => {
  const { fetchListing } = fakeFetcher({ [url('1')]: BROKER_TEXT });
  const screener = new Screener(fetchListing);
  const first = await screener.screen([dealerRow('1', 'broker', 'Broker Motors')], ALL);
  const second = await screener.screen(
    [dealerRow('2', 'broker', 'Broker Motors'), privateRow('3', { shortDescription: 'Cesja leasingu' })],
    ALL,
  );
  const merged = mergeReports([first.report, second.report], SCREEN_KINDS);
  assert.equal(merged.excludedCount, 3);
  assert.equal(merged.excluded.length, 2);
  assert.deepEqual(merged.excluded[0]?.listings.map((row) => row.id), ['1', '2']);
});

test('merging page reports keeps the latest sighting of each dealer, paid for if any was', () => {
  const check = {
    sellerId: 'a',
    sellerName: 'A',
    importToOrder: false,
    evidenceListingId: null,
    evidence: null,
    sampleComplete: true,
  };
  const merged = mergeReports(
    [
      {
        exclude: [],
        excludedCount: 0,
        excluded: [],
        sellerChecks: [{ ...check, listingsRead: ['1'], cached: false }],
        sellersNotChecked: [],
      },
      {
        exclude: [],
        excludedCount: 0,
        excluded: [],
        sellerChecks: [{ ...check, listingsRead: ['1', '2', '3'], cached: true }],
        sellersNotChecked: [],
      },
    ],
    SCREEN_KINDS,
  );
  assert.equal(merged.sellerChecks.length, 1);
  assert.deepEqual(merged.sellerChecks[0]?.listingsRead, ['1', '2', '3']);
  assert.equal(merged.sellerChecks[0]?.cached, false);
});

/* ---- builders ---- */

function url(id: string): string {
  return `https://www.otomoto.pl/osobowe/oferta/car-ID${id}.html`;
}

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: '1',
    url: url('1'),
    title: 'Car',
    shortDescription: null,
    make: null,
    model: null,
    price: 50_000,
    currency: 'PLN',
    priceEvaluation: null,
    year: 2019,
    mileageKm: 100_000,
    fuelType: null,
    fuelTypeLabel: null,
    gearbox: null,
    gearboxLabel: null,
    enginePowerHp: null,
    engineCapacityCm3: null,
    version: null,
    versionLabel: null,
    countryOrigin: null,
    countryOriginLabel: null,
    location: { city: null, region: null },
    seller: { id: 'p', type: 'PRIVATE', professional: false, name: null, pageUrl: null },
    createdAt: null,
    ...overrides,
  };
}

function dealerRow(id: string, sellerId: string, name: string): Listing {
  return listing({
    id,
    url: url(id),
    seller: { id: sellerId, type: 'PROFESSIONAL', professional: true, name, pageUrl: null },
  });
}

function privateRow(id: string, overrides: Partial<Listing> = {}): Listing {
  return listing({
    id,
    url: url(id),
    seller: { id: `private-${id}`, type: 'PRIVATE', professional: false, name: null, pageUrl: null },
    ...overrides,
  });
}

function detail(listingUrl: string, description: string): ListingDetail {
  return {
    id: '1',
    url: listingUrl,
    title: 'Car',
    status: 'ACTIVE',
    price: 50_000,
    currency: 'PLN',
    priceLabels: [],
    createdAt: null,
    originalCreatedAt: null,
    updatedAt: null,
    description,
    parameters: {},
    equipment: [],
    photoUrls: [],
    seller: { type: 'PROFESSIONAL', name: null, professional: true },
    priceDrop: null,
    verifiedCar: false,
  };
}
