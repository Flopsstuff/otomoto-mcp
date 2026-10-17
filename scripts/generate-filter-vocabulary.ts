/**
 * Regenerates src/filter-vocabulary.ts from the committed search fixture.
 *
 *   node scripts/generate-filter-vocabulary.ts
 *
 * Otomoto ships its own filter definitions in the search page payload: `filters.components`
 * carries every filter id with its Polish label, and `filters.states` carries the allowed
 * values. Reading the vocabulary from there is why this server can reject `gearbox: "stick"`
 * instead of handing Otomoto a filter it will silently ignore.
 *
 * Run it after `npm run capture-fixtures`, then review the diff: a value disappearing is how
 * a vocabulary change shows up.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractNextData, getPageProps, isRecord } from '../src/nextdata.ts';
import { loadFixture } from '../test/fixtures.ts';

const FIXTURE = 'search-lexus-lc';

/** Conditional on make+model, so it cannot be expressed as one flat list. */
const SKIPPED_ENUMS = new Set(['filter_enum_generation']);

/** Make and model are path segments and get their own tables. */
const PATH_ENUMS = new Set(['filter_enum_make', 'filter_enum_model']);

/** Geo radius is not an ordinary enum: it pairs with city_id under search[dist]. */
const RADIUS_ID = 'dist';

/** The range filters this server exposes; the rest of Otomoto's floats are out of scope. */
const RANGE_IDS = [
  'filter_float_price',
  'filter_float_year',
  'filter_float_mileage',
  'filter_float_engine_power',
  'filter_float_engine_capacity',
];

interface FilterValue {
  value: string;
  label: string;
}

function publicKey(filterId: string): string {
  return filterId.replace(/^filter_(?:enum|float|string)_/, '');
}

function findFilterData(): { components: unknown[]; states: unknown[]; sortOptions: unknown } {
  const pageProps = getPageProps(extractNextData(loadFixture(FIXTURE)));
  const urqlState = pageProps['urqlState'];
  if (!isRecord(urqlState)) throw new Error('fixture has no urqlState');
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
    if (!isRecord(data)) continue;
    const filters = data['filters'];
    if (!isRecord(filters)) continue;
    if (!Array.isArray(filters['components']) || !Array.isArray(filters['states'])) continue;
    return {
      components: filters['components'],
      states: filters['states'],
      sortOptions: data['sortOptions'],
    };
  }
  throw new Error('no filters.components/filters.states in the fixture payload');
}

function collectValues(state: Record<string, unknown>): FilterValue[] {
  const out: FilterValue[] = [];
  const groups = state['values'];
  if (!Array.isArray(groups)) return out;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group['values'])) continue;
    for (const value of group['values']) {
      if (!isRecord(value)) continue;
      const id = value['id'];
      if (typeof id !== 'string' || id === '') continue;
      const name = value['name'];
      out.push({ value: id, label: typeof name === 'string' && name !== '' ? name : id });
    }
  }
  return out;
}

const { components, states, sortOptions } = findFilterData();

const labels = new Map<string, string>();
for (const component of components) {
  if (!isRecord(component)) continue;
  const id = component['id'];
  const name = component['name'];
  if (typeof id === 'string' && typeof name === 'string') labels.set(id, name);
}

const enums = new Map<string, FilterValue[]>();
const modelsByMake = new Map<string, string[]>();
let makes: string[] = [];
let radiusValues: number[] = [];

for (const state of states) {
  if (!isRecord(state)) continue;
  const filterId = state['filterId'];
  if (typeof filterId !== 'string') continue;
  const conditions = Array.isArray(state['conditions']) ? state['conditions'] : [];

  if (filterId === 'filter_enum_make' && conditions.length === 0) {
    makes = collectValues(state).map((entry) => entry.value);
    continue;
  }

  if (filterId === 'filter_enum_model') {
    const make = conditions
      .filter(isRecord)
      .find((condition) => condition['filterId'] === 'filter_enum_make')?.['value'];
    if (typeof make !== 'string') continue;
    modelsByMake.set(
      make,
      collectValues(state).map((entry) => entry.value),
    );
    continue;
  }

  if (filterId === RADIUS_ID && conditions.length === 0) {
    radiusValues = collectValues(state)
      .map((entry) => Number(entry.value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    continue;
  }

  if (conditions.length > 0 || SKIPPED_ENUMS.has(filterId) || PATH_ENUMS.has(filterId)) continue;
  if (filterId.startsWith('filter_float_')) continue;
  const values = collectValues(state);
  if (values.length === 0) continue;
  enums.set(filterId, values);
}

const sorts: FilterValue[] = [];
if (isRecord(sortOptions) && Array.isArray(sortOptions['states'])) {
  for (const state of sortOptions['states']) {
    if (isRecord(state)) sorts.push(...collectValues(state));
  }
}

if (radiusValues.length === 0) throw new Error('no geo radius vocabulary found');
if (makes.length === 0) throw new Error('no make vocabulary found');
if (modelsByMake.size === 0) throw new Error('no model vocabulary found');
if (enums.size === 0) throw new Error('no enum vocabulary found');
if (sorts.length === 0) throw new Error('no sort options found');

const sortedEnums = [...enums.entries()].sort(([a], [b]) => a.localeCompare(b));
const sortedModels = [...modelsByMake.entries()].sort(([a], [b]) => a.localeCompare(b));
const json = (value: unknown): string => JSON.stringify(value);

const lines: string[] = [];
lines.push(`/**`);
lines.push(` * Generated by scripts/generate-filter-vocabulary.ts from the committed search fixture.`);
lines.push(` * Do not edit by hand.`);
lines.push(` *`);
lines.push(` * These are Otomoto's own filter ids, values and Polish labels, lifted from the filter`);
lines.push(` * definitions it ships in its search page payload. A snapshot, not a live lookup: it can`);
lines.push(` * lag a new model or colour, and regenerating it is how that gets fixed.`);
lines.push(` */`);
lines.push('');
lines.push(`export interface FilterValue {`);
lines.push(`  /** Machine code that goes into the URL. */`);
lines.push(`  value: string;`);
lines.push(`  /** Otomoto's own display label, in Polish. */`);
lines.push(`  label: string;`);
lines.push(`}`);
lines.push('');
lines.push(`export interface EnumFilterDefinition {`);
lines.push(`  key: string;`);
lines.push(`  filterId: string;`);
lines.push(`  label: string;`);
lines.push(`  values: FilterValue[];`);
lines.push(`}`);
lines.push('');
lines.push(`export interface RangeFilterDefinition {`);
lines.push(`  key: string;`);
lines.push(`  filterId: string;`);
lines.push(`  label: string;`);
lines.push(`}`);
lines.push('');
lines.push(`/** Date the source fixture was captured. */`);
lines.push(`export const VOCABULARY_CAPTURED_AT = ${json(new Date().toISOString().slice(0, 10))};`);
lines.push('');
lines.push(`export const ENUM_FILTERS: Record<string, EnumFilterDefinition> = {`);
for (const [filterId, values] of sortedEnums) {
  const key = publicKey(filterId);
  lines.push(`  ${json(key)}: {`);
  lines.push(`    key: ${json(key)},`);
  lines.push(`    filterId: ${json(filterId)},`);
  lines.push(`    label: ${json(labels.get(filterId) ?? key)},`);
  lines.push(`    values: [`);
  for (const value of values) {
    lines.push(`      { value: ${json(value.value)}, label: ${json(value.label)} },`);
  }
  lines.push(`    ],`);
  lines.push(`  },`);
}
lines.push(`};`);
lines.push('');
lines.push(`export const RANGE_FILTERS: Record<string, RangeFilterDefinition> = {`);
for (const filterId of RANGE_IDS) {
  const key = publicKey(filterId);
  lines.push(
    `  ${json(key)}: { key: ${json(key)}, filterId: ${json(filterId)}, label: ${json(labels.get(filterId) ?? key)} },`,
  );
}
lines.push(`};`);
lines.push('');
lines.push(`export const SORT_OPTIONS: FilterValue[] = [`);
for (const sort of sorts) {
  lines.push(`  { value: ${json(sort.value)}, label: ${json(sort.label)} },`);
}
lines.push(`];`);
lines.push('');
lines.push(`/** Radii Otomoto offers for search[dist], in km. */`);
lines.push(`export const RADIUS_KM_VALUES: number[] = [${radiusValues.join(', ')}];`);
lines.push('');
lines.push(`export const MAKES: string[] = [`);
for (const make of [...makes].sort()) lines.push(`  ${json(make)},`);
lines.push(`];`);
lines.push('');
lines.push(`export const MODELS_BY_MAKE: Record<string, string[]> = {`);
for (const [make, models] of sortedModels) {
  lines.push(`  ${json(make)}: [${[...models].sort().map(json).join(', ')}],`);
}
lines.push(`};`);
lines.push('');

const out = fileURLToPath(new URL('../src/filter-vocabulary.ts', import.meta.url));
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(
  `wrote ${out}: ${sortedEnums.length} enum filters, ${RANGE_IDS.length} ranges, ` +
    `${sorts.length} sort options, ${makes.length} makes, ${sortedModels.length} model lists`,
);
