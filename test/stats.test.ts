import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describe as summarise, percentile } from '../src/stats.ts';

test('percentiles interpolate between order statistics', () => {
  const sample = [1, 2, 3, 4];
  assert.equal(percentile(sample, 0), 1);
  assert.equal(percentile(sample, 0.25), 1.75);
  assert.equal(percentile(sample, 0.5), 2.5);
  assert.equal(percentile(sample, 0.75), 3.25);
  assert.equal(percentile(sample, 1), 4);
});

test('a single-value sample has that value at every percentile', () => {
  assert.equal(percentile([42], 0.25), 42);
  assert.equal(percentile([42], 0.9), 42);
});

test('summarises an unsorted sample', () => {
  const result = summarise([30_000, 10_000, 50_000, 20_000, 40_000]);
  assert.deepEqual(result, {
    count: 5,
    min: 10_000,
    p25: 20_000,
    median: 30_000,
    p75: 40_000,
    max: 50_000,
    mean: 30_000,
  });
});

test('an odd-length sample takes the middle value as the median', () => {
  const result = summarise([1, 2, 100]);
  assert.equal(result?.median, 2);
  assert.equal(result?.mean, 34.33);
});

test('nulls and non-finite values are left out of the sample, not counted as zero', () => {
  const result = summarise([100, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 300]);
  assert.equal(result?.count, 2);
  assert.equal(result?.min, 100);
  assert.equal(result?.max, 300);
  assert.equal(result?.mean, 200);
});

test('an empty sample is null rather than a row of zeroes', () => {
  assert.equal(summarise([]), null);
  assert.equal(summarise([null, null]), null);
});

test('percentile of an empty sample is a programming error, not a zero', () => {
  assert.throws(() => percentile([], 0.5), /empty sample/);
});
