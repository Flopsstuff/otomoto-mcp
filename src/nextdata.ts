import { ParserContractError } from './errors.ts';

/**
 * Otomoto is a Next.js app and serves the data we want as a JSON blob inside the HTML.
 * Everything in here is an undocumented internal contract: it can change on any deploy.
 * The rule for this module is therefore that it never degrades gracefully - an unrecognised
 * shape raises ParserContractError instead of returning nothing.
 */

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

export interface SearchResultPayload {
  edges: unknown[];
  totalCount: number | null;
  pageInfo: Record<string, unknown>;
  /**
   * The located search object itself, so a parser can read the metadata that hangs off it
   * (`appliedFilters`, `relaxation`) without walking the payload a second time.
   */
  raw: Record<string, unknown>;
}

export function extractNextData(html: string, url?: string): Record<string, unknown> {
  const match = NEXT_DATA_RE.exec(html);
  if (!match || match[1] === undefined) {
    throw new ParserContractError('no __NEXT_DATA__ script tag in the page', url);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ParserContractError(`__NEXT_DATA__ is not valid JSON (${reason})`, url);
  }
  if (!isRecord(parsed)) {
    throw new ParserContractError('__NEXT_DATA__ is not a JSON object', url);
  }
  return parsed;
}

export function getPageProps(nextData: Record<string, unknown>, url?: string): Record<string, unknown> {
  const props = nextData['props'];
  if (!isRecord(props)) throw new ParserContractError('__NEXT_DATA__.props missing', url);
  const pageProps = props['pageProps'];
  if (!isRecord(pageProps)) throw new ParserContractError('__NEXT_DATA__.props.pageProps missing', url);
  return pageProps;
}

/**
 * Search results live in the urql GraphQL client cache, keyed by an opaque query hash, and
 * each entry's `data` is sometimes a JSON string rather than an object. We locate the search
 * result by shape - the first object carrying both `edges` and `pageInfo`.
 */
export function findSearchResult(
  nextData: Record<string, unknown>,
  url?: string,
): SearchResultPayload {
  const pageProps = getPageProps(nextData, url);
  const urqlState = pageProps['urqlState'];
  if (!isRecord(urqlState)) {
    throw new ParserContractError('pageProps.urqlState missing on a search page', url);
  }

  for (const entry of Object.values(urqlState)) {
    if (!isRecord(entry)) continue;
    let data = entry['data'];
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    const found = findEdgesNode(data);
    if (found) return found;
  }

  throw new ParserContractError(
    'no { edges, pageInfo } object found anywhere in pageProps.urqlState',
    url,
  );
}

/** Listing detail pages have no urqlState - the advert hangs directly off pageProps. */
export function findAdvert(nextData: Record<string, unknown>, url?: string): Record<string, unknown> {
  const pageProps = getPageProps(nextData, url);
  const advert = pageProps['advert'];
  if (!isRecord(advert)) {
    throw new ParserContractError('pageProps.advert missing on a listing page', url);
  }
  return advert;
}

function findEdgesNode(value: unknown): SearchResultPayload | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEdgesNode(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  if (Array.isArray(value['edges']) && isRecord(value['pageInfo'])) {
    const totalCount = value['totalCount'];
    return {
      edges: value['edges'],
      totalCount: typeof totalCount === 'number' ? totalCount : null,
      pageInfo: value['pageInfo'],
      raw: value,
    };
  }

  for (const child of Object.values(value)) {
    const found = findEdgesNode(child);
    if (found) return found;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
