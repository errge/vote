import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8 } from './bytes';

export const DOMAIN = 'unanimous/v1/';

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/**
 * Domain-separated hash: SHA-256 over the length-prefixed encoding of
 * `"unanimous/v1/<purpose>"` followed by every part. Each element is written
 * as a 4-byte big-endian length and the raw bytes, so no two different
 * part lists can produce the same hash input.
 */
export function hashTagged(purpose: string, ...parts: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of [utf8(DOMAIN + purpose), ...parts]) chunks.push(u32be(p.length), p);
  return sha256(concatBytes(...chunks));
}
