// secp256k1 group helpers (additive notation). Every decoder rejects invalid
// encodings, off-curve points, the identity and zero / out-of-range scalars.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, CryptoError, hexToBytes, isHex, randomBytes } from './bytes';

export const Point = secp256k1.Point;
export type Point = InstanceType<typeof secp256k1.Point>;
export const G: Point = Point.BASE;
export const O: Point = Point.ZERO;
export const N: bigint = Point.Fn.ORDER;

export function mod(a: bigint): bigint {
  const r = a % N;
  return r < 0n ? r + N : r;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigIntToBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function isValidScalar(s: bigint): boolean {
  return s > 0n && s < N;
}

/** Uniform scalar in [1, n-1] by rejection sampling. */
export function randomScalar(): bigint {
  for (;;) {
    const s = bytesToBigInt(randomBytes(32));
    if (isValidScalar(s)) return s;
  }
}

export function scalarToBytes(s: bigint): Uint8Array {
  if (!isValidScalar(s)) throw new CryptoError('invalid scalar');
  return bigIntToBytes32(s);
}

export function scalarToHex(s: bigint): string {
  return bytesToHex(scalarToBytes(s));
}

export function scalarFromHex(hex: unknown): bigint {
  if (!isHex(hex, 32)) throw new CryptoError('invalid scalar encoding');
  const s = bytesToBigInt(hexToBytes(hex));
  if (!isValidScalar(s)) throw new CryptoError('scalar out of range or zero');
  return s;
}

/** Compressed SEC1 encoding (33 bytes). The identity has no encoding. */
export function pointToBytes(P: Point): Uint8Array {
  if (P.is0()) throw new CryptoError('cannot encode the identity point');
  return P.toBytes(true);
}

export function pointToHex(P: Point): string {
  return bytesToHex(pointToBytes(P));
}

export function pointFromHex(hex: unknown): Point {
  if (!isHex(hex, 33)) throw new CryptoError('invalid point encoding');
  let P: Point;
  try {
    P = Point.fromBytes(hexToBytes(hex));
    P.assertValidity();
  } catch {
    throw new CryptoError('point is not on the curve');
  }
  if (P.is0()) throw new CryptoError('identity point');
  return P;
}

/** Secret-scalar multiplication (constant time). */
export function mul(P: Point, k: bigint): Point {
  if (!isValidScalar(k)) throw new CryptoError('invalid scalar');
  return P.multiply(k);
}

export function sumPoints(points: Point[]): Point {
  let acc = O;
  for (const P of points) acc = acc.add(P);
  return acc;
}
