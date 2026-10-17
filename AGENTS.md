# AGENTS.md

Guidance for AI coding agents working in this repository.
`CLAUDE.md` and `GEMINI.md` are symlinks to this file.

## What this is

An MCP server (Node + TypeScript, stdio) that searches used-car listings on Otomoto.pl by
fetching the public search and listing pages and parsing the Next.js `__NEXT_DATA__` payload.
There is no Otomoto API behind it. It is an unofficial helper for an individual buyer, not a
data-collection tool - see "Fair use" in `README.md`, which also constrains what may be added.

## Commands

```bash
npm install
npm run build        # tsc -> dist/, the executable entry point is dist/index.js
npm run typecheck
npm test             # node --test over test/**/*.test.ts; offline, fixture-based
npm run smoke        # starts dist/index.js over real stdio and makes ONE live request
```

- One test file: `node --test test/filters.test.ts`
- One test by name: `node --test --test-name-pattern="relevance" test/filters.test.ts`
- Tests and scripts run the `.ts` sources directly through Node's built-in type stripping (no
  ts-node/tsx), so they need a Node with type stripping on by default (22.18+/23.6+); the built
  `dist/` runs on Node 20+. Sources import with `.ts` extensions, which `tsc` rewrites to `.js`.
- `.mcp.json` registers `node dist/index.js` as a project MCP server: after changing `src/`,
  run `npm run build` and reconnect the MCP client before trying the tools live.
- `npm run capture-fixtures` refreshes `test/fixtures/` from live pages (two requests, by hand
  only); `npm run generate-vocabulary` then regenerates `src/filter-vocabulary.ts` from the
  captured search page - review that diff, a vanished value is how Otomoto renames show up.

## Architecture

A tool call flows through these layers:

1. `src/tools/*.ts` - one file per MCP tool: a zod input schema, a description written for the
   calling agent, and a `run*` function. `tools/shared.ts` holds the shared filter and screening
   schemas and `describeError`, which maps each error class to a `kind` plus an `actionable` hint.
2. `src/client.ts` - `OtomotoClient`: `search`, `listing`, `priceStats`, `screen`. It verifies
   Otomoto's answer after parsing (applied location, applied enum filters) and throws rather than
   return a page that answers a different question.
3. `src/filters.ts` - typed filters to a URL, validated against the generated
   `filter-vocabulary.ts` before any request. Make, model and city are path segments; enum
   filters take a value or a list (Otomoto ORs them, sent indexed `[0]`, `[1]`); a default sort
   is always sent.
4. `src/http.ts` - the only network code: serialized, paced (min delay with a hard floor),
   browser User-Agent, timeout and size cap. Tests swap it for a fixture client.
5. `src/nextdata.ts` + `src/parsers/{search,detail}.ts` - extract `__NEXT_DATA__` (search data
   sits in an urql cache, partly as JSON strings) and normalise it into `src/types.ts` shapes.
6. `src/screening.ts` - flags non-sales: lease transfers from row text and price, import-to-order
   brokers by reading up to `SELLER_SAMPLE_SIZE` ads per dealer, round-robin, within a per-call
   `CheckBudget`; verdicts are cached for the process. `listing-id.ts` converts numeric ids to the
   base62 form URLs use.

## Rules the code is built on

- **Never silent.** Otomoto answers bad input with HTTP 200 and plausible wrong results: an
  unknown filter or place is ignored, `make` as a query param returns zero rows, a comma-joined
  enum returns zero rows. So inputs are validated at the edge, answers are checked afterwards
  (`UnknownLocationError`, `FilterNotAppliedError`), and an unrecognised page shape is a
  `ParserContractError` - never an empty result. Keep new features to this standard.
- **Nothing is dropped without a reason.** Screening marks rows with `flags` (kind, source,
  quoted evidence) and reports what it excluded; `exclude: []` keeps everything.
- **Bounded and polite.** Hard caps (`MAX_STATS_PAGES`, `MAX_LISTING_READS_PER_CALL`, the delay
  floor) are deliberate. Do not add crawling, background refresh, or tooling that builds or
  refreshes a listings database to this repository.
- **stdout is the MCP transport.** Diagnostics go to stderr only.
- `docs/architecture.md` describes the design; `docs/otomoto-behaviour.md` records, with dates,
  what the live site was measured to do and how the code handles it. A new measured behaviour
  goes there, and a change to how the server is built updates `architecture.md`.

## Tests and fixtures

- `test/fixtures/*.html.gz` are real captured pages with personal data replaced (fictional
  "Jan Nowak" / "Adam Kowalski", synthetic phone tokens). `capture-fixtures` replaces e-mails and
  tokens itself but prints signature-looking lines whose names must be replaced by hand before
  committing.
- `test/tools.test.ts` drives the real MCP server through an in-memory transport with a
  `FixtureHttpClient`; `test/fixtures.ts` has helpers to rewrite the captured page's
  `appliedLocation` / `appliedFilters` for a scenario.

## Repository conventions

- `data/` is a git-ignored local scratch folder; it is not part of the project and nothing in
  `src/` may depend on it.
- Commits are conventional (`feat(scope): …`, `fix(…)`, `docs: …`) with a body explaining why,
  made directly on `main`.
