# How Otomoto behaves

What the live site was measured to do, and what the code does about it. Everything here was
observed on otomoto.pl in October 2026 and can change with any deploy; the dates say how old
each observation is. The general shape of the server is in [`architecture.md`](architecture.md).

The common thread: **Otomoto answers bad input with HTTP 200.** A filter, place or value it does
not understand is ignored rather than rejected, and the page that comes back looks like a
working result. Most of the code below exists to notice that.

## Access (2026-10-13)

- A desktop browser `User-Agent` is the only gate: a library-default UA (`curl/8.14.1`) gets HTTP
  403, a Chrome UA gets 200. No CAPTCHA, cookie handshake or JS challenge.
- `robots.txt` does not disallow `/osobowe/...` search pages or `/osobowe/oferta/...` listing
  pages, has no `Crawl-delay`, and declares `Content-Signal: ai-train=yes, search=yes,
  ai-input=yes`. That is not the terms of service; see "Fair use" in the README.
- A search page is about 1.5 MB of HTML for 32 rows. Deep pagination works (page 100 returned
  fresh rows), and ten sequential pages half a second apart were all served.

## Search URLs

| Behaviour | Measured | What the code does |
|---|---|---|
| Make and model only work as path segments (`/osobowe/audi/a4-avant`). As `search[filter_enum_make]` they return 200 with `totalCount: 0`. | 2026-10-13 | Path segments, validated against the vocabulary. |
| Model families are split into variants: there is no `audi/a4`. `/osobowe/audi/a4` 301-redirects to `a4-avant`, a narrower query. | 2026-10-13 | Rejects `a4` with the variants as suggestions; reports `resolvedUrl` and `queryWasRewritten`. |
| An unknown filter key or value is ignored with 200. | 2026-10-13 | Every key and value is checked against `filter-vocabulary.ts` before sending. |
| Free text (`search[q]`) does not narrow: `q=oferta poglądowa` returned essentially every listing. | 2026-10-17 | Not offered. |

## Place and radius (2026-10-17)

| Behaviour | What the code does |
|---|---|
| A city works as the last path segment (`/osobowe/toyota/corolla/warszawa?search[dist]=25`), the same as `search[city_id]`. | `city` becomes a slug (`Łódź` -> `lodz`); `cityId` is the alternative. |
| An unknown slug or city id returns 200 with `appliedLocation: null` and all of Poland (~260 000 rows). | `UNKNOWN_LOCATION`; the page is discarded. |
| A place without `dist` silently gets a ~50 km radius. `dist=0` returns nothing. | `radiusKm` is required with a place. |
| A name shared by several places resolves to one of them without saying so (`Nowa Wieś`). | `appliedLocation` (city, powiat, voivodeship, ids) is returned so the caller can check. |
| Any whole-number radius is applied as given (30 and 40 km fall between 25 and 50; 1 km is the city itself; 500 km is the country). The website offers 5-300 km presets. | Validated against the presets. |

## Enum filters (2026-10-17)

- Several values of one filter are ORed: body type `suv` 82 rows, `combi` 59, both 141. The forms
  `[0]=suv&[1]=combi`, `[]=suv&[]=combi` and the parameter repeated all work.
- The comma form `suv,combi` is the trap: applied verbatim, zero rows, HTTP 200.
- `appliedFilters` lists each applied value as its own entry under the filter id, including the
  non-prefixed ids `new_used` and `private_business`. The code sends lists indexed and checks
  every requested value against `appliedFilters` (`FILTER_NOT_APPLIED`).
- **`damaged`** partitions only the listings whose seller stated a damage status:
  `damaged=0` (197) plus `damaged=1` (38) was 235 of 268. `damaged=0` is therefore "declared
  undamaged" and silently drops the rows with no status, most of them ordinary private sales.
- **`body_type`** was set on every row measured, so filtering on it lost nothing.
- **`leasing_concession`** is a seller-ticked checkbox that does not find lease transfers:
  `=1` returned 13 rows mixing a rental with ordinary sales and missing the actual transfers;
  `=0` returned nothing. Large dealers tick it on every ad because they offer financing.

## Sort and paging (2026-10-17)

- Otomoto's default order (`relevance_web`, "Wybrane dla Ciebie") reshuffles between requests.
  Paging all 268 rows of one search returned 227 distinct listings: some on two or three pages,
  about 40 on none. `created_at:desc`, `created_at_first:desc`, price ascending and mileage
  ascending each returned all 268.
- The order parameter survives redirects but is not reported in `appliedFilters`.
- The code always sends a sort (newest first by default) and refuses to page `relevance_web`.

## What a search row carries

- `seller.__typename` (`PrivateSeller` / `ProfessionalSeller`) and `sellerLink {id, name,
  websiteUrl}`. The seller id is stable across all of one seller's ads; `name` is null for
  private sellers, and `sellerLink` is null for ads carried over from OLX.
- `priceEvaluation.indicator`: `BELOW`, `IN`, `ABOVE` the average, or `NONE` - a label only, with
  no range behind it, and `NONE` for a quarter to a half of rows.
- Not carried: damage status, body type, the full description.

## Listing pages

- The URL carries a base62 form of the numeric id (`6148596129` -> `6I6SJj`, alphabet
  `0-9a-zA-Z`); the numeric id in a URL 404s. The slug before `-ID` is cosmetic and redirects to
  the canonical one. Ads carried over from OLX end in `-OLX_ID<id>.html` and are otherwise
  ordinary listings.
- Phone numbers and the VIN are encrypted tokens, not values. The code never returns them.
- Gross and net price are both in the payload (`advertPriceForPriceDrop.isNet`,
  `grossMinorAmount`, `netMinorAmount`); prices are gross unless marked net.
- Sellers type their own phone numbers and e-mail addresses into descriptions, often kept on
  one line with `&nbsp;`. Text is decoded to plain text; contacts are passed through unless
  `OTOMOTO_MCP_REDACT_CONTACTS` is set.

## Non-sales in results (2026-10-17)

- **Lease transfers** ("cesja leasingu", "przejęcie leasingu", "odstępne") often put the monthly
  instalment or the transfer fee in the price field: a 2022 Corolla at 1 784 PLN was the minimum
  of a whole price sample until screened out. Their real cost (remaining instalments plus an
  optional buyout) is in the description.
- **Import-to-order brokers** list cars they do not have: example offers, sample auctions in the
  USA, estimated purchase costs. On one 268-row search three such dealers filled 55 rows. Their
  giveaway is only in the full description, worded differently by each salesperson: one broker
  showed it in 13 of 26 ads, another in 11 of 11 but four different ways, a third used a phrase
  no pattern knew. A dealer with stock that mentions sourcing to order as a side service is the
  known false positive.
- "Nie stanowi oferty w rozumieniu art. 66 § 1 Kodeksu cywilnego" is boilerplate on most dealer
  ads and means nothing; "auto sprowadzone" (imported, in stock) is an ordinary sale.
