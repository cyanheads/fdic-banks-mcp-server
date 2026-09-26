/**
 * @fileoverview Peer distribution statistics for one metric: quartiles by linear
 * interpolation between order statistics, the institution's percentile (ties
 * counted half), and its rank among itself plus its peers.
 * @module services/fdic/peer-stats
 */

/** Statistics for one metric. Every value is `null` when it cannot be computed. */
export interface PeerStats {
  peer_count_with_value: number;
  peer_max: number | null;
  peer_median: number | null;
  peer_min: number | null;
  peer_p25: number | null;
  peer_p75: number | null;
  /** 100 × (peers below + ½ × peers tied) / peers with a value. */
  percentile: number | null;
  /** 1 = highest value among the institution plus its peers with a value. */
  rank: number | null;
  rank_of: number | null;
}

/** Quantile `p` (0–1) of an ascending-sorted, non-empty list, interpolating linearly. */
export function quantile(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lo = sorted[lower] as number;
  const hi = sorted[upper] as number;
  return lo + (hi - lo) * (position - lower);
}

/**
 * Statistics of `value` against `peerValues`. Peers without a value must already
 * be excluded; the institution itself must not be among the peers.
 */
export function computePeerStats(value: number | null, peerValues: readonly number[]): PeerStats {
  const sorted = peerValues.toSorted((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return {
      peer_count_with_value: 0,
      peer_median: null,
      peer_p25: null,
      peer_p75: null,
      peer_min: null,
      peer_max: null,
      percentile: null,
      rank: value === null ? null : 1,
      rank_of: value === null ? null : 1,
    };
  }
  let below = 0;
  let tied = 0;
  let above = 0;
  if (value !== null) {
    for (const peer of sorted) {
      if (peer < value) below++;
      else if (peer === value) tied++;
      else above++;
    }
  }
  return {
    peer_count_with_value: n,
    peer_median: quantile(sorted, 0.5),
    peer_p25: quantile(sorted, 0.25),
    peer_p75: quantile(sorted, 0.75),
    peer_min: sorted[0] as number,
    peer_max: sorted[n - 1] as number,
    percentile: value === null ? null : (100 * (below + tied / 2)) / n,
    rank: value === null ? null : above + 1,
    rank_of: value === null ? null : n + 1,
  };
}
