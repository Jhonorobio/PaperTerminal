/**
 * FOMO feed filters — pure functions over the token list, mirroring the server's
 * `readFeed` (fomo-ws.js). Cheap bounds run first (mcap), then age, then the
 * sort, then KOL (which is only meaningful once the visible candidates have been
 * enriched via Pulse). Records missing a bound's data are excluded, exactly like
 * the server does.
 */

import type { FomoFilters, FomoToken } from '../types';

export const EMPTY_FILTERS: FomoFilters = {};

/** Raw input from the screen's text fields: digits or empty, parsed by `normalizeFilters`. */
export type RawFilters = Partial<Record<keyof FomoFilters, string>>;

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Normalize raw input (strings from text fields) into a filter set. */
export function normalizeFilters(raw: Partial<Record<keyof FomoFilters, string | number | undefined | null>>): FomoFilters {
  const out: FomoFilters = {};
  const ageMin = num(raw.ageMinMin);
  const ageMax = num(raw.ageMaxMin);
  const mcapMin = num(raw.mcapMin);
  const mcapMax = num(raw.mcapMax);
  const kolMin = num(raw.kolMin);
  const kolMax = num(raw.kolMax);
  const limit = num(raw.limit);
  if (ageMin) out.ageMinMin = ageMin;
  if (ageMax) out.ageMaxMin = ageMax;
  if (mcapMin) out.mcapMin = mcapMin;
  if (mcapMax) out.mcapMax = mcapMax;
  if (kolMin) out.kolMin = kolMin;
  if (kolMax) out.kolMax = kolMax;
  if (limit) out.limit = limit;
  return out;
}

export function activeFilterCount(filters: FomoFilters): number {
  return Object.values(filters).filter((v) => v != null).length;
}

/** The feed's order: trending by rank (unknown rank last). */
export function feedOrder() {
  return (a: FomoToken, b: FomoToken) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Apply the filters to a token list. `nowSec` is unix seconds — injected so this
 * stays pure. Age is in minutes; a token without `createdAt` is excluded when an
 * age bound is set (the caller enriches via Pulse first when it can).
 */
export function applyFomoFilters(tokens: FomoToken[], filters: FomoFilters, nowSec: number): FomoToken[] {
  let list = [...tokens];

  if (filters.mcapMin != null || filters.mcapMax != null) {
    list = list.filter(
      (t) => t.mcap != null && (filters.mcapMin == null || t.mcap >= filters.mcapMin) && (filters.mcapMax == null || t.mcap <= filters.mcapMax),
    );
  }

  if (filters.ageMinMin != null || filters.ageMaxMin != null) {
    const minSec = filters.ageMinMin != null ? filters.ageMinMin * 60 : null;
    const maxSec = filters.ageMaxMin != null ? filters.ageMaxMin * 60 : null;
    list = list.filter(
      (t) => t.createdAt != null && (minSec == null || nowSec - t.createdAt >= minSec) && (maxSec == null || nowSec - t.createdAt <= maxSec),
    );
  }

  list.sort(feedOrder()); // trending: rank asc, unknown last

  if (filters.kolMin != null || filters.kolMax != null) {
    list = list.filter(
      (t) => t.kolCount != null && (filters.kolMin == null || t.kolCount >= filters.kolMin) && (filters.kolMax == null || t.kolCount <= filters.kolMax),
    );
  }

  const cap = Math.min(Math.max(Math.floor(filters.limit ?? 200), 1), 1000);
  return list.slice(0, cap);
}
export function selectFomoTokens(tokens: FomoToken[], filters: FomoFilters, nowSec: number): FomoToken[] {
  const filtered = applyFomoFilters(tokens, filters, nowSec);
  return filtered.sort(feedOrder());
}

/** Token age in minutes, or null when unknown. */
export function ageMinutes(t: FomoToken, nowSec: number): number | null {
  return t.createdAt != null ? Math.max(0, Math.round((nowSec - t.createdAt) / 60)) : null;
}
