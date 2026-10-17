# How otomoto-mcp works

otomoto-mcp is a stdio MCP server that answers car-search questions from Otomoto.pl. This
document describes how it is put together and why it is shaped the way it is. The site
behaviours it depends on are listed separately in [`otomoto-behaviour.md`](otomoto-behaviour.md).

## Reading Otomoto

Otomoto has no public search API. Three ways in were tried on the live site:

| Approach | Verdict |
|---|---|
| Rendered HTML markup | Class names are build-hashed and change on every deploy. |
| The site's own GraphQL endpoint (`POST /graphql`) | Reachable, but introspection is off, so the query documents would have to be dug out of the JS bundles and re-derived on every change. |
| The Next.js SSR payload (`<script id="__NEXT_DATA__">`) in the normal search and listing pages | Works end to end: search, filters, sort, radius, deep pagination and listing detail. |

The server fetches the same public pages a browser would, with a plain HTTP client, and parses
`__NEXT_DATA__`. No headless browser, no GraphQL client, no stored copy of listings.
`__NEXT_DATA__` is an undocumented internal contract that can change on any deploy, which is
why the parser layer is built to fail loudly (below).

Keeping all network access in one module is what keeps the alternatives open: switching to
GraphQL, or to a real API should Otomoto ever publish one, would replace the HTTP layer and
the parsers' input, not the tools.

## Layers

A tool call goes down through these modules and back up:

```
tools/*.ts          MCP surface: zod schema, description, run function
  └─ client.ts      OtomotoClient: search, listing, priceStats, screen; verifies answers
       ├─ filters.ts      typed filters -> URL, validated against filter-vocabulary.ts
       ├─ http.ts         the only network code: serialized, paced, timeout, size cap
       ├─ nextdata.ts     find and decode __NEXT_DATA__
       ├─ parsers/        search page and listing page -> types.ts shapes
       └─ screening.ts    flag non-sales; read dealers' ads within a budget
```

- **`tools/`** - one file per tool. A tool validates its arguments with zod, calls the client
  and shapes the JSON result. `tools/shared.ts` holds the filter and screening schemas shared by
  several tools, and `describeError`, which turns each error class into a `kind`, a message and
  an `actionable` hint for the calling agent.
- **`client.ts`** - builds the URL, fetches, parses, and then checks that Otomoto answered the
  question that was asked (see "Never silent"). `priceStats` walks up to three pages and screens
  each before computing statistics.
- **`filters.ts`** - the filter object to Otomoto's `search[...]` syntax. Make, model and city
  are path segments; everything else is a query parameter. Every value is checked against
  `filter-vocabulary.ts`, a table generated from the filter definitions Otomoto ships in its
  own search page (`npm run generate-vocabulary`). Enum filters take one value or a list.
  A sort is always sent.
- **`http.ts`** - browser `User-Agent`, `Accept-Language: pl-PL`, a serialized queue, an enforced
  delay between requests, a timeout, one retry on 5xx, a response size cap. Tests replace it.
- **`nextdata.ts` and `parsers/`** - two parsers, because the two page types differ. On a search
  page each advert is a node in a urql GraphQL cache (partly stored as JSON strings), with a
  flat `parameters[]` list and an integer price; on a listing page it is `pageProps.advert`, with
  a parameters map and a string price. Both normalise into `Listing` / `ListingDetail`, with
  price as integer PLN. Seller-written text is turned into plain text by `sanitize.ts`.
- **`listing-id.ts`** - search rows carry a numeric id, URLs carry a base62 form of it; this
  converts between them so a listing can be fetched from either.

## Never silent

Otomoto answers bad input with HTTP 200 and a plausible page of wrong results. The code is
organised around not passing that on:

1. **Validate before sending.** Unknown filter keys, invented enum values, a model that does not
   belong to the make, a radius without a place, a place without a radius, a sort that cannot be
   paged: all rejected with `INVALID_ARGUMENT` before any request.
2. **Check the answer.** After parsing, the client compares what Otomoto reports it applied with
   what was asked: a place it did not recognise raises `UNKNOWN_LOCATION`, an enum value it did
   not apply raises `FILTER_NOT_APPLIED`. A silently rewritten model slug is reported through
   `resolvedUrl` and `queryWasRewritten`.
3. **Unrecognised page means broken, not empty.** Any shape the parsers do not recognise raises
   `PARSER_CONTRACT_ERROR`, which tells the agent this is not "no cars found". A test replays a
   payload with the search object renamed to keep it that way.

## Politeness is structural

Pacing is not left to the caller. Requests are serialized; the delay between them has a floor
that configuration can raise but not lower; `price_stats` reads at most three pages; screening
reads at most 16 listings per call; nothing runs in the background or on its own initiative.
The product is a tool a person runs locally for their own searches, and these limits are part
of that shape, not defaults to tune away.

## Screening non-sales

Some search rows are not a car for sale, and Otomoto marks none of them. `screening.ts`
recognises two kinds and, by default, drops them:

- **Lease transfers** - someone handing over a lease or rental. Recognised from the title and
  teaser, and from a price that only makes sense as an instalment or a transfer fee (a very
  young car at a few thousand PLN).
- **Import-to-order ads** - a broker advertising a car it does not have ("sample offer", "sample
  auction in the USA", "estimated purchase cost"). This is only visible in the full
  description. The server reads up to four ads per dealer, round by round so a short budget
  still covers every dealer, and the first ad that shows it settles the dealer. One ad is not
  enough: brokers' salespeople write their own texts, and one broker showed the phrase in only
  half of its ads. Verdicts are cached for the life of the process, and a clean verdict on a short
  sample is topped up when more of the dealer's ads appear on a later page.

Nothing disappears without a reason: every row carries `flags` (kind, where it was found,
quoted evidence), and every response carries a `screening` report of what was excluded, which
dealers were read and how completely. `exclude: []` keeps everything and still flags it.
The patterns are narrow on purpose - a false positive hides a real car - and the phrases they
must and must not match are tables in `test/screening.test.ts`.

## Errors

| `kind` | Meaning |
|---|---|
| `INVALID_ARGUMENT` | Rejected before any request; fix the arguments. |
| `UNKNOWN_LOCATION` | Otomoto ignored the place and would have searched all of Poland. |
| `FILTER_NOT_APPLIED` | Otomoto ignored part of an enum filter and would have answered a wider search. |
| `PARSER_CONTRACT_ERROR` | The page shape changed; the server needs an update. Not an empty result. |
| `FETCH_ERROR` | Otomoto could not be reached or refused the request. |

## Tests

`npm test` is offline. Parsers and tools run against two captured pages in `test/fixtures/`
(gzipped, with the people named in them replaced by fictional ones), plus small hand-made pages
for the failure cases. `test/tools.test.ts` drives the real MCP server through an in-memory
transport with a fixture HTTP client, and `test/fixtures.ts` can rewrite the captured page's
applied location and filters for a scenario. `npm run smoke` is the one check that touches the
live site: it starts the built server over real stdio and makes a single search.
