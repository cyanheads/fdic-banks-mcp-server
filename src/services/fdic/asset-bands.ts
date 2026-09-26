/**
 * @fileoverview Peer asset-size bands used by fdic_compare_peers. Bounds are total
 * assets in thousands of US dollars; `min` is inclusive and `max` exclusive.
 * @module services/fdic/asset-bands
 */

export const ASSET_BAND_CODES = [
  'under_100m',
  '100m_1b',
  '1b_10b',
  '10b_250b',
  'over_250b',
] as const;

export type AssetBandCode = (typeof ASSET_BAND_CODES)[number];

interface AssetBand {
  code: AssetBandCode;
  label: string;
  /** Exclusive upper bound, USD thousands. Absent for the top band. */
  max?: number;
  /** Inclusive lower bound, USD thousands. Absent for the bottom band. */
  min?: number;
  /** Phrase for a peer-group definition sentence ("total assets of …"). */
  phrase: string;
}

export const ASSET_BANDS: readonly AssetBand[] = [
  {
    code: 'under_100m',
    label: 'Total assets under $100 million',
    max: 100_000,
    phrase: 'under $100 million',
  },
  {
    code: '100m_1b',
    label: 'Total assets of $100 million to under $1 billion',
    min: 100_000,
    max: 1_000_000,
    phrase: '$100 million–$1 billion',
  },
  {
    code: '1b_10b',
    label: 'Total assets of $1 billion to under $10 billion',
    min: 1_000_000,
    max: 10_000_000,
    phrase: '$1–10 billion',
  },
  {
    code: '10b_250b',
    label: 'Total assets of $10 billion to under $250 billion',
    min: 10_000_000,
    max: 250_000_000,
    phrase: '$10–250 billion',
  },
  {
    code: 'over_250b',
    label: 'Total assets of $250 billion or more',
    min: 250_000_000,
    phrase: '$250 billion or more',
  },
];

/** The band a total-assets value (USD thousands) falls in. */
export function assetBandFor(totalAssets: number): AssetBand {
  const band = ASSET_BANDS.find(
    (b) =>
      (b.min === undefined || totalAssets >= b.min) && (b.max === undefined || totalAssets < b.max),
  );
  // The bands tile the number line, so a finite value always lands in one.
  return band ?? (ASSET_BANDS.at(-1) as AssetBand);
}

/** The band for a code. */
export function assetBand(code: AssetBandCode): AssetBand {
  return ASSET_BANDS.find((b) => b.code === code) as AssetBand;
}
