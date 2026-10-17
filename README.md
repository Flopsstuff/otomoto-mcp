# otomoto-mcp

![A robot studying a wall of used-car listings, some ticked, some crossed out](docs/assets/hero.jpg)

An MCP server that lets an AI agent search used-car listings on [Otomoto.pl](https://www.otomoto.pl)
and read individual offers. One Node process, stdio transport, no API key, no browser.

> **Unofficial research project.** otomoto-mcp is not made, endorsed or supported by Otomoto
> or OLX Group, and is not affiliated with them; "Otomoto" is their trademark. It exists to help
> an individual buyer go through offers on the site - search, read a listing, tell a real sale
> from a lease transfer or an import-to-order ad - with an AI assistant doing the reading. It
> is not a data-collection tool: use it for your own searches, at a human pace, and within
> Otomoto's terms of service (see [Fair use](#fair-use)).

## How it works

Otomoto has no public API. This server fetches the same public search and listing pages a
browser would, and reads the Next.js SSR payload (`__NEXT_DATA__`) embedded in them.
[`docs/architecture.md`](docs/architecture.md) describes how the server is built and why;
[`docs/otomoto-behaviour.md`](docs/otomoto-behaviour.md) lists what the live site was measured
to do and how the code handles it.

Three properties are worth knowing before you use it:

- **An empty result and a broken parser are different things.** If Otomoto changes its page
  structure, every tool fails loudly with `PARSER_CONTRACT_ERROR`. No tool ever reports a
  format change as "no cars found".
- **Filters are validated, not silently dropped.** Otomoto answers an unrecognised filter with
  HTTP 200 and ignores it, so `gearbox: "stick"` would look like a working query with wrong
  results. Unknown keys and values are rejected before any request is made.
- **Nothing crawls.** One tool call fetches at most three pages, and only when you ask for
  statistics; requests are serialized and paced.

## Install

**With a coding agent:** give it
[`docs/install-with-an-agent.md`](docs/install-with-an-agent.md) - for example "Install the
otomoto-mcp MCP server by following
https://github.com/Flopsstuff/otomoto-mcp/blob/main/docs/install-with-an-agent.md". It checks
the prerequisites, builds, attaches the server to your client without overwriting its config,
and verifies the connection.

**By hand** (Node 20 or newer):

```bash
git clone https://github.com/Flopsstuff/otomoto-mcp.git && cd otomoto-mcp
npm ci
npm run build
```

Not published to npm. `dist/index.js` is the executable entry point.

## Attach it to an MCP client

Claude Code:

```bash
claude mcp add otomoto -- node /absolute/path/to/otomoto-mcp/dist/index.js
```

Any client that takes an `mcpServers` block (Claude Desktop, Cursor, Zed, …):

```json
{
  "mcpServers": {
    "otomoto": {
      "command": "node",
      "args": ["/absolute/path/to/otomoto-mcp/dist/index.js"]
    }
  }
}
```

Settings from [Configuration](#configuration) go in an `env` block if you need them; the
defaults are already polite. Verify the connection by asking the client to call
`otomoto_filter_options`, which answers from a table in the repo and makes no network request.

## Tools

### `otomoto_search(filters?, page?, limit?, exclude?, excludeSellerIds?, verifySellers?)`

One page of search results, screened (see [Screening](#screening)).

| Argument | Type | Notes |
|---|---|---|
| `filters` | object | See [Filters](#filters). Omit for an unfiltered search. |
| `page` | integer | 1-based, 32 results per page. Default 1. |
| `limit` | integer | Rows to return from that page after screening, 1-32. Default 32. |
| `exclude` | array | `lease_transfer`, `import_to_order`. Default both; `[]` keeps every row. |
| `excludeSellerIds` | array | `seller.id` values whose ads are dropped. |
| `verifySellers` | boolean | Read one listing per new dealer. Default true. |

Returns `totalCount` (Otomoto's, before screening), `page`, `pageSize`, `returned`,
`truncatedByLimit`, `hasMorePages`, `requestedUrl`, `resolvedUrl`, `queryWasRewritten`,
`relaxationApplied`, `appliedFilters`, `appliedLocation`, `screening` and `listings[]`. Each listing carries `id`, `url`, `title`, `shortDescription`, `make`, `model`, `price`
(integer PLN), `currency`, `priceEvaluation`, `year`, `mileageKm`, `fuelType`, `gearbox`,
`enginePowerHp`, `engineCapacityCm3`, `version`, `countryOrigin`, their Polish labels,
`location`, `seller`, `createdAt` and `flags`.

`priceEvaluation` is Otomoto's own verdict on the price against comparable listings - `BELOW`,
`IN` or `ABOVE` the average - and null when Otomoto gives none, which is common (a quarter to
a half of rows in the searches seen). It is a label only; Otomoto publishes no range behind it.

`seller` is `{id, type, professional, name, pageUrl}`. `type` is `PRIVATE` or `PROFESSIONAL`;
`name` and `pageUrl` are the dealer's and are null for private sellers. The `id` is stable
across every ad one seller publishes, so it is how to spot one dealer filling a page of results.

Two fields exist to catch Otomoto answering a different question than you asked:
`resolvedUrl`/`queryWasRewritten` report redirects (`/osobowe/audi/a4` arrives as `a4-avant`,
a narrower model), and `appliedFilters` is Otomoto's own list of what it applied.

### `otomoto_listing(idOrUrl)`

Full detail for one listing. Accepts a listing URL, the base62 id from a URL (`6I6SJj` or
`ID6I6SJj`), or the numeric id a search result reports (`6148596129`).

Returns `id`, `url`, `title`, `status`, `price` (integer PLN), `currency`, `priceLabels`,
`createdAt`, `originalCreatedAt`, `updatedAt`, `description`, `parameters` (every published
spec *and* equipment flag, keyed by machine code), `equipment` (labelled groups), `photoUrls`,
`seller` (`type`, `name`, `professional`), `priceDrop`, `verifiedCar` and `flags` - the same
screening verdict as a search row, read from the full description.

### `otomoto_price_stats(filters?, maxPages?, exclude?, excludeSellerIds?, verifySellers?)`

`count`, `min`, `p25`, `median`, `p75`, `max` and `mean` for price (PLN) and mileage (km) over a
bounded sample. `maxPages` is 1-3 (default 1); each page is 32 listings and ~1.5 MB of HTML.

Screened rows are left out of the sample - one lease transfer priced as an instalment is
otherwise the minimum. The output always reports `sampleSize` (after screening), `rowsFetched`
(before), `pagesFetched`, `totalCount`, `sampleIsPartial`, `screening` and a `sampleNote`. Read them: a median over the first 32 rows of 4000 matches describes those 32
rows and nothing more, and `sort` decides which 32 you get.

### `otomoto_filter_options(field?, make?)`

The filter vocabulary, with Otomoto's own Polish labels. Called without `field` it returns an
index of every filter this server accepts; with a `field` (`make`, `model` + `make`, `sort`,
`radius`, or any enum key such as `fuel_type`) it returns that filter's valid values.

Answered from a table checked into the repo, generated from the filter definitions Otomoto
ships in its own search pages. It costs no request, so call it before guessing a value.

## Screening

Some ads on Otomoto are not a car for sale, and Otomoto marks none of them. Two kinds are
recognised and, by default, dropped:

- **`lease_transfer`** - someone handing over a lease or long-term rental (`Cesja leasingu`,
  `Do przejęcia najem długoterminowy`). Recognised from the title and teaser, and from a price
  that only makes sense as an instalment (under 12 000 PLN for a car five years old or
  younger: a 2022 Corolla at 1 784 PLN).
- **`import_to_order`** - a broker advertising a car it does not have (`Oferta poglądowa,
  dotyczy sprowadzenia takiego modelu w dowolnej specyfikacji`, `Przedstawiona oferta to
  przykładowa licytacja w USA`, `Szacunkowy koszt zakupu wraz z transportem`). This is only in
  the full description, and not in every one: each salesperson writes their own text, and one
  broker showed it in 13 of its 26 ads. So with `verifySellers` (on by default) the server
  reads **up to 4 listings per dealer**, stops at the first that shows it, and applies the
  verdict to every ad of that dealer. Reads go round by round - one more ad of each unsettled
  dealer per round, the dealer with the most rows first - with at most 16 per call. Verdicts
  are remembered while the server runs, and a dealer with a short sample is read further when
  more of its ads turn up on a later page.

Nothing disappears silently. Every row carries `flags: [{kind, source, evidence}]` with the
text that produced the verdict, and the response's `screening` lists what was excluded and
why, which dealers were read (`sellerChecks`, with `listingsRead` and `sampleComplete`: false
means a clean verdict on fewer listings than wanted) and which were not (`sellersNotChecked`,
e.g. over the limit). `screening.excluded` has one entry per reason: a dealer verdict is quoted once
with every listing it removed under it, a row dropped on its own text or price is an entry of
its own.

Screening is on by default and is switched off per call:

| Arguments | Effect |
|---|---|
| (none) | Dealers are read; lease transfers and import-to-order ads are dropped. |
| `exclude: []` | Nothing is dropped; every row still carries its `flags`. Dealers are still read. |
| `exclude: ["lease_transfer"]` | Only that kind is dropped. |
| `verifySellers: false` | No listing is read; brokers go unrecognised, transfers are still caught from text and price. |
| `exclude: [], verifySellers: false` | The unscreened page, one request, as before screening existed. |

An import dealer selling cars it actually has (`Auto sprowadzone z USA`, in stock) is not
flagged; only advertising a car to be sourced is. The patterns are deliberately narrow; the
phrases they must and must not match are tables in `test/screening.test.ts`.

## Filters

`otomoto_search` and `otomoto_price_stats` take the same filter object.

| Field | Type | Notes |
|---|---|---|
| `make` | string | Otomoto make slug, e.g. `lexus`. Becomes a path segment. |
| `model` | string | Model slug, e.g. `a4-avant`. Requires `make`. |
| `priceFrom`, `priceTo` | number | PLN. |
| `yearFrom`, `yearTo` | number | |
| `mileageFrom`, `mileageTo` | number | km. |
| `enginePowerFrom`, `enginePowerTo` | number | HP (KM). |
| `engineCapacityFrom`, `engineCapacityTo` | number | cm³. |
| `fuelType` | string or list | e.g. `petrol`, `diesel`, `hybrid`. |
| `gearbox` | string or list | `manual` or `automatic`. |
| `bodyType` | string or list | e.g. `suv`, or `["suv", "combi"]` for either. |
| `countryOrigin` | string or list | Old registration codes, not ISO: `d` is Germany, `cdn` Canada. |
| `condition` | string or list | `new` or `used`. |
| `sellerType` | string or list | `private` or `business`. |
| `enums` | object | Any other enum filter, e.g. `{"color": ["black", "white"]}`. A filter that already has a named field above is rejected rather than set twice. |
| `city` | string | Polish place name or Otomoto slug: `Kraków`, `lodz`, `Nowa Wieś`. Becomes a path segment. Requires `radiusKm`. |
| `cityId` | number | Otomoto's internal city id (Warszawa is `17871`), instead of `city`. Requires `radiusKm`. |
| `radiusKm` | number | 5, 10, 15, 25, 50, 75, 100, 150, 200, 250 or 300. Requires `city` or `cityId`. |
| `sort` | string | e.g. `filter_float_price:asc`. Default `created_at_first:desc` (newest first). `relevance_web` only on page 1. |

Every enum filter takes one value or a list, and a list means any of them: Otomoto ORs
repeated values of one filter (`suv` 82 rows, `combi` 59, both 141). They go out indexed,
`search[filter_enum_body_type][0]=suv&...[1]=combi`. The comma form `suv,combi` is a trap - HTTP
200, applied verbatim, zero rows - and is rejected here as an unknown value. Each answer is
checked against `appliedFilters`, and a value Otomoto did not apply fails the call with
`FILTER_NOT_APPLIED` instead of returning a wider search than was asked for.

Make and model are path segments because that is the only form that works: as query params
Otomoto returns HTTP 200 with `totalCount: 0`. Both are checked against the vocabulary, which
is why `{"make": "audi", "model": "a4"}` is rejected with a pointer at `a4-avant`,
`a4-limousine` and the other variants rather than quietly searching one of them.

A place is the last path segment too (`/osobowe/toyota/corolla/warszawa?search[dist]=25`), and
Otomoto is quiet about both ways it can go wrong. A name it does not recognise is dropped and the
whole country is searched; a city without a radius gets an unannounced ~50 km default. So
`radiusKm` is mandatory, and a search whose place Otomoto did not apply fails with
`UNKNOWN_LOCATION` instead of returning the rest of Poland. A successful one reports
`appliedLocation`: the city, powiat and voivodeship Otomoto searched around, with their ids.

Every search is sent with an explicit order. Otomoto's own default, `relevance_web`
("Wybrane dla Ciebie"), reshuffles between requests: paging one 268-row search returned 227
distinct listings, some on two or three pages and 41 on none. Newest-first returned all 268, as
did every other sort tried, so it is the default here; `relevance_web` is accepted for page 1
and refused for page 2 onwards and for multi-page statistics.

## Limitations

- **Model families are split into variants.** There is no `audi/a4`; there is `a4-avant`,
  `a4-limousine`, `a4-allroad`, `a4-cabrio`. Ask `otomoto_filter_options` for a make's models.
- **The filter vocabulary is a snapshot**, generated from a captured page. A make, model or
  colour Otomoto added since the capture is rejected as unknown until it is regenerated
  (`npm run capture-fixtures && npm run generate-vocabulary`).
- **One value per filter.** Otomoto's multi-select encoding is not implemented, so you cannot
  ask for petrol *or* hybrid in one query.
- **`generation` is not supported** as a filter: Otomoto scopes generations to a make+model
  pair, which does not fit the flat filter object.
- **A place name shared by several places resolves to one of them.** Poland has dozens of
  `Nowa Wieś`, and Otomoto picks one without saying so. Check `appliedLocation` - the powiat
  and voivodeship tell you which one - or pass `cityId`. There is no city list in the repo, so
  a misspelt city costs one request before it is rejected.
- **Statistics are asking prices from a page or three**, not market values, and `totalCount`
  can be in the thousands.
- **Screening shortens pages.** Rows are dropped after a page is fetched, so a page can hold
  fewer than 32 listings while `totalCount` stays Otomoto's count. The server does not fetch
  more pages to make up the difference.
- **Screening has blind spots.** A lease transfer whose teaser and price give nothing away is
  only caught by `otomoto_listing`; private sellers' listings are never read during a search.
  A dealer beyond the 8-per-call limit is judged on row text alone, and one listing stands for
  all of a dealer's ads.
- **Seller text is passed through; redaction is opt-in.** A phone number or e-mail a seller
  typed into their own description, teaser or dealer name is there for buyers to use, so by
  default it is returned as written (as plain text: HTML dropped, entities decoded). Otomoto's
  own phone field is a different thing - an encrypted token behind a click - and is never
  returned; neither are the encrypted VIN and plate tokens, which are dropped rather than
  passed off as values.

  `OTOMOTO_MCP_REDACT_CONTACTS=1` replaces phone numbers and e-mails in seller text with
  `[contact details removed]`, for a deployment whose output should carry no personal contact
  details. HTML entities and no-break spaces are decoded first, so a number written
  `601&nbsp;234&nbsp;567` is seen as one. Phone numbers are matched by Polish number shape, so
  that prices, years and mileages in the same sentence survive; behind a `tel`/`kom`-style
  label any grouping of nine digits is redacted. The shape is genuinely ambiguous at the edges, and the two errors
  are not priced the same: an unlabelled nine-digit block with no separators is left alone
  (it reads as an offer number), while an offer number written in three-digit groups -
  `nr oferty 123 456 789` - is redacted, because that is exactly how a mobile is written.
- **Polish labels.** Machine codes are English-ish (`petrol`, `cabrio`); every human-readable
  label and all free text is Polish.
- **Fragile by construction.** `__NEXT_DATA__` is an undocumented internal contract. When it
  changes, the tools fail with `PARSER_CONTRACT_ERROR` and this server needs an update.

## Development

Running the server needs Node 20 or newer. Developing needs **Node 22.18+ or 23.6+**: the tests
and scripts run the `.ts` sources directly through Node's built-in type stripping, with no
ts-node or tsx.

```bash
npm ci
npm test          # fixture-based, never touches the network
npm run typecheck
npm run build
npm run smoke     # one live request; see below
```

`npm run smoke` is the end-to-end check: it starts the built server, speaks MCP to it over real
stdio, asserts all four tools are registered, and runs one small live search against Otomoto.
It makes exactly one network request and exits non-zero with a reason if anything is wrong.
Everything else in `npm test` is fixture-based and offline.

Fixtures are gzipped copies of real pages under `test/fixtures/`. Refresh them with
`npm run capture-fixtures` when a parser test starts failing and you need to see what changed,
then `npm run generate-vocabulary` to regenerate `src/filter-vocabulary.ts` from the refreshed
search page and review the diff.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `OTOMOTO_MCP_MIN_DELAY_MS` | `1000` | Minimum delay between requests. Clamped to a floor of 500 ms - it can be raised, not lowered. |
| `OTOMOTO_MCP_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `OTOMOTO_MCP_USER_AGENT` | desktop Chrome | Otomoto answers a library-default UA with HTTP 403. |
| `OTOMOTO_MCP_REDACT_CONTACTS` | off | `1`/`true`/`yes`/`on` removes phone numbers and e-mails from seller text. Any value other than those and `0`/`false`/`no`/`off` stops the server at start-up. |

## Fair use

This is a tool for running your own searches on demand, and it is built to stay that way:
requests are serialized and paced, pages per call are capped, and nothing here crawls on its
own initiative or keeps a copy of Otomoto's listings.

Otomoto's `robots.txt` allows the paths used here and declares
`Content-Signal: ai-train=yes, search=yes, ai-input=yes`. That is not the same thing as
Otomoto's terms of service. Those make downloading and reusing the site's materials subject to
OLX Group's consent, allow reuse of only an insubstantial part of its databases and not their
systematic, repeated extraction, and the separate API terms name scraping without consent as
prohibited. Keep volumes low, do not use this to build or refresh a listings database, and do
not republish listing content. You are responsible for how you use it.

## Licence

MIT - see [`LICENSE`](LICENSE). The licence covers this code only, not Otomoto's content.
