import { z } from 'zod';

import { InvalidArgumentError } from '../errors.ts';
import {
  ENUM_FILTERS,
  MAKES,
  MODELS_BY_MAKE,
  RADIUS_KM_VALUES,
  RANGE_FILTERS,
  SORT_OPTIONS,
  VOCABULARY_CAPTURED_AT,
} from '../filter-vocabulary.ts';
import { RANGE_FIELD_NAMES } from '../filters.ts';
import { jsonResult, toToolError, type ToolResult } from './shared.ts';

/**
 * The filter vocabulary, so an agent can look up `gearbox` instead of inventing `"stick"`.
 *
 * Answered from the table generated out of Otomoto's own filter definitions - no request is
 * made, which is what makes it cheap enough to call before every search.
 */

export const filterOptionsInputSchema = {
  field: z
    .string()
    .optional()
    .describe(
      'Filter to describe: "make", "model", "sort", "radius", or any enum filter key such ' +
        'as "fuel_type". Omit for an index of every filter this server accepts.',
    ),
  make: z.string().optional().describe('Required with field "model": the make to list models for.'),
};

export const filterOptionsToolConfig = {
  title: 'Otomoto filter vocabulary',
  description:
    'List the filter keys and values otomoto_search accepts, with Otomoto\'s own Polish ' +
    'labels. Answered from a table checked into this server, so it costs no request. Call it ' +
    'before guessing an enum value: unrecognised values are rejected, not silently ignored.',
  inputSchema: filterOptionsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export function runFilterOptions(args: {
  field?: string | undefined;
  make?: string | undefined;
}): ToolResult {
  try {
    return jsonResult(describeField(args.field, args.make));
  } catch (error) {
    return toToolError(error);
  }
}

function vocabularyNote(): string {
  return (
    `Vocabulary snapshot captured ${VOCABULARY_CAPTURED_AT} from Otomoto's own filter ` +
    `definitions. A value Otomoto added since then will be rejected until the snapshot is ` +
    `regenerated.`
  );
}

function describeField(field: string | undefined, make: string | undefined): unknown {
  if (field === undefined) {
    return {
      note: vocabularyNote(),
      pathFilters: {
        make: { count: MAKES.length, hint: 'Call again with field "make" for the list.' },
        model: {
          hint: 'Call again with field "model" and a make. Models are per-make.',
        },
      },
      rangeFilters: Object.values(RANGE_FILTERS).map((range) => ({
        key: range.key,
        label: range.label,
        fields: RANGE_FIELD_NAMES[range.key],
      })),
      enumFilters: Object.values(ENUM_FILTERS).map((definition) => ({
        key: definition.key,
        label: definition.label,
        valueCount: definition.values.length,
      })),
      sort: SORT_OPTIONS,
      radiusKm: RADIUS_KM_VALUES,
      geoNote:
        'Search around a place with city (Polish name or slug, e.g. "Kraków") or cityId, plus ' +
        'radiusKm. Both halves are required: a city without a radius gets Otomoto\'s silent ' +
        '~50 km default. There is no city list here; an unrecognised city fails with ' +
        'UNKNOWN_LOCATION after one request.',
    };
  }

  const key = field.trim().toLowerCase();

  if (key === 'make') {
    return { field: 'make', note: vocabularyNote(), count: MAKES.length, values: MAKES };
  }

  if (key === 'model') {
    if (make === undefined) {
      throw new InvalidArgumentError(
        'field "model" needs a make: Otomoto scopes models to a make. ' +
          'Call with field "make" first.',
      );
    }
    const models = MODELS_BY_MAKE[make];
    if (models === undefined) {
      throw new InvalidArgumentError(
        `unknown make "${make}". Call with field "make" for the ${MAKES.length} valid makes.`,
      );
    }
    return {
      field: 'model',
      make,
      note:
        `${vocabularyNote()} Note that a model family is often split into variants: audi has ` +
        `"a4-avant" and "a4-limousine" but no plain "a4".`,
      count: models.length,
      values: models,
    };
  }

  if (key === 'sort') {
    return { field: 'sort', note: vocabularyNote(), values: SORT_OPTIONS };
  }

  if (key === 'radius' || key === 'radiuskm' || key === 'dist') {
    return {
      field: 'radiusKm',
      note: 'Requires city or cityId.',
      values: RADIUS_KM_VALUES,
    };
  }

  const range = RANGE_FILTERS[key];
  if (range !== undefined) {
    return {
      field: range.key,
      label: range.label,
      kind: 'range',
      fields: RANGE_FIELD_NAMES[range.key],
    };
  }

  const definition = ENUM_FILTERS[key];
  if (definition === undefined) {
    throw new InvalidArgumentError(
      `unknown filter "${field}". Call otomoto_filter_options without a field for the index.`,
    );
  }
  return {
    field: definition.key,
    label: definition.label,
    kind: 'enum',
    note: vocabularyNote(),
    values: definition.values,
  };
}
