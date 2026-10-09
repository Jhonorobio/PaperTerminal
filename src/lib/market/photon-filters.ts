/**
 * Photon memescope filters — pure functions over the column's token list,
 * mirroring the server's FILTER_FIELDS (age, holders, tp_holders, mkt_cap, buys,
 * fresh_holding_perc, bundle_holders_count, bundle_holding_perc).
 *
 * The server keeps the authoritative filters for its own refreshes; the app
 * filters the pushed snapshot locally so New and Graduated can carry independent
 * filter sets (same model as the FOMO screen).
 */

import type { PhotonFilters, PhotonRange, PhotonToken } from '../types';

export const EMPTY_PHOTON_FILTERS: PhotonFilters = {};

/** Raw text-field input per column. Every value is a {min,max} string pair. */
export type RawPhotonFilters = Partial<Record<keyof PhotonFilters, PhotonRange>>;

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Cleans a column's raw ranges into a comparable filter set. */
export function normalizePhotonFilters(raw: RawPhotonFilters): PhotonFilters {
  const out: PhotonFilters = {};
  for (const [field, range] of Object.entries(raw ?? {})) {
    if (!range) continue;
    const pair: PhotonRange = {};
    const min = num(range.min);
    const max = num(range.max);
    if (min != null) pair.min = min;
    if (max != null) pair.max = max;
    if (pair.min != null || pair.max != null) out[field as keyof PhotonFilters] = pair;
  }
  return out;
}

export function activePhotonFilterCount(filters: PhotonFilters): number {
  return Object.values(filters).filter((r) => r && (r.min != null || r.max != null)).length;
}

/** mktCap is typed in thousands ($K) like the FOMO screen. */
const MKT_CAP_MULT = 1000;

export function applyPhotonFilters(tokens: PhotonToken[], filters: PhotonFilters): PhotonToken[] {
  const inRange = (value: number | null, range: PhotonRange | undefined, mult = 1): boolean => {
    if (!range || (range.min == null && range.max == null)) return true;
    if (value == null) return false;
    if (range.min != null && value < range.min * mult) return false;
    if (range.max != null && value > range.max * mult) return false;
    return true;
  };

  return tokens.filter(
    (t) =>
      inRange(t.mcap, filters.mktCap, MKT_CAP_MULT) &&
      inRange(t.holdersCount, filters.holders) &&
      inRange(t.tpHoldersCount, filters.tpHolders) &&
      inRange(t.buysCount, filters.buys) &&
      inRange(t.freshPct, filters.freshPct) &&
      inRange(t.bundleHolders, filters.bundleHolders) &&
      inRange(t.bundlePct, filters.bundlePct),
  );
}
