/**
 * Summary statistics over a sample of listings.
 *
 * The sample is whatever a few pages of results happened to contain, so every figure here is
 * reported together with how many rows it came from. A median over 32 rows of a 4000-row
 * result set is a useful hint and a terrible market valuation, and the output has to make that
 * difference visible rather than leaving it to the caller's optimism.
 */

export interface Distribution {
  count: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

/** Linear interpolation between order statistics - the same convention as numpy's default. */
export function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) throw new Error('percentile of an empty sample');
  if (sortedValues.length === 1) return sortedValues[0]!;
  const position = fraction * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower]!;
  const weight = position - lower;
  return sortedValues[lower]! * (1 - weight) + sortedValues[upper]! * weight;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Returns null for an empty sample rather than zeroes, which would read as real data. */
export function describe(values: (number | null | undefined)[]): Distribution | null {
  const sample = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sample.length === 0) return null;

  const sum = sample.reduce((total, value) => total + value, 0);
  return {
    count: sample.length,
    min: sample[0]!,
    p25: round(percentile(sample, 0.25)),
    median: round(percentile(sample, 0.5)),
    p75: round(percentile(sample, 0.75)),
    max: sample[sample.length - 1]!,
    mean: round(sum / sample.length),
  };
}
