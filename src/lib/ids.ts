import { randomUUID } from 'expo-crypto';

/** Small helper so ids read the same everywhere (`ct_`, `pt_`…). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
