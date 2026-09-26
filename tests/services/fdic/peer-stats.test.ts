/**
 * @fileoverview Tests for peer statistics: linear-interpolation quartiles, the
 * ties-count-half percentile, and rank among the institution plus its peers.
 * @module tests/services/fdic/peer-stats.test
 */

import { describe, expect, it } from 'vitest';
import { computePeerStats, quantile } from '@/services/fdic/peer-stats.js';

describe('quantile', () => {
  it('interpolates linearly between order statistics', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(quantile([7], 0.25)).toBe(7);
  });
});

describe('computePeerStats', () => {
  it('computes median, quartiles, range, percentile, and rank from unsorted peers', () => {
    expect(computePeerStats(1.25, [2, 0.5, 1.5, 1])).toEqual({
      peer_count_with_value: 4,
      peer_median: 1.25,
      peer_p25: 0.875,
      peer_p75: 1.625,
      peer_min: 0.5,
      peer_max: 2,
      percentile: 50,
      rank: 3,
      rank_of: 5,
    });
  });

  it('counts tied peers as half below', () => {
    const stats = computePeerStats(1, [1, 1, 0, 2]);
    expect(stats.percentile).toBe((100 * (1 + 2 / 2)) / 4);
    // Ties share the institution's rank: only the one strictly higher peer ranks above it.
    expect(stats.rank).toBe(2);
    expect(stats.rank_of).toBe(5);
  });

  it('ranks the highest value first and the lowest last', () => {
    expect(computePeerStats(9, [1, 2, 3])).toMatchObject({ percentile: 100, rank: 1, rank_of: 4 });
    expect(computePeerStats(-106, [1, 2, 3])).toMatchObject({ percentile: 0, rank: 4, rank_of: 4 });
  });

  it('keeps peer statistics but nulls percentile and rank when the institution has no value', () => {
    expect(computePeerStats(null, [1, 3])).toEqual({
      peer_count_with_value: 2,
      peer_median: 2,
      peer_p25: 1.5,
      peer_p75: 2.5,
      peer_min: 1,
      peer_max: 3,
      percentile: null,
      rank: null,
      rank_of: null,
    });
  });

  it('returns null statistics for an empty peer set, ranking a present value 1 of 1', () => {
    expect(computePeerStats(4, [])).toEqual({
      peer_count_with_value: 0,
      peer_median: null,
      peer_p25: null,
      peer_p75: null,
      peer_min: null,
      peer_max: null,
      percentile: null,
      rank: 1,
      rank_of: 1,
    });
    expect(computePeerStats(null, [])).toMatchObject({ rank: null, rank_of: null });
  });
});
