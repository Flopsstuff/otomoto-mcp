import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * Tests never touch the network. Real pages are captured once, gzipped (they are ~1.5 MB each)
 * and replayed from here; `npm run capture-fixtures` refreshes them.
 */
export function loadFixture(name: string): string {
  const gzPath = fileURLToPath(new URL(`./fixtures/${name}.html.gz`, import.meta.url));
  try {
    return gunzipSync(readFileSync(gzPath)).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const plainPath = fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url));
  return readFileSync(plainPath, 'utf8');
}

/** What a Kraków search reports as `advertSearch.appliedLocation`. */
export const KRAKOW_APPLIED_LOCATION = {
  city: { name: 'Kraków', id: 8959, canonical: 'krakow', __typename: 'AdministrativeLevel' },
  subregion: { name: 'Kraków', id: 102, canonical: 'krakow', __typename: 'AdministrativeLevel' },
  region: { name: 'Małopolskie', id: 4, canonical: 'malopolskie', __typename: 'AdministrativeLevel' },
};

const NO_LOCATION = '\\"appliedLocation\\":null,';

/**
 * The captured search names no place. This rewrites its `appliedLocation` - which sits inside a
 * JSON string inside the page's JSON, hence the escaped quotes - or, given `undefined`, removes
 * the key altogether.
 */
export function withAppliedLocation(html: string, location: unknown): string {
  if (!html.includes(NO_LOCATION)) throw new Error('fixture has no appliedLocation:null to replace');
  if (location === undefined) return html.replace(NO_LOCATION, '');
  const escaped = JSON.stringify(JSON.stringify(location)).slice(1, -1);
  return html.replace(NO_LOCATION, `\\"appliedLocation\\":${escaped},`);
}

const APPLIED_FILTERS = '\\"appliedFilters\\":[';

/** Adds entries to the captured search's `appliedFilters`, as if Otomoto had applied them. */
export function withAppliedFilters(html: string, filters: { name: string; value: string }[]): string {
  if (!html.includes(APPLIED_FILTERS)) throw new Error('fixture has no appliedFilters to extend');
  const entries = filters.map((filter) =>
    JSON.stringify(
      JSON.stringify({ __typename: 'AdvertSearchFilterAppliedValue', ...filter, canonical: filter.value, labels: [] }),
    ).slice(1, -1),
  );
  return html.replace(APPLIED_FILTERS, `${APPLIED_FILTERS}${entries.map((entry) => `${entry},`).join('')}`);
}
