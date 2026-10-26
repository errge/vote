// Fiat–Shamir Schnorr proof of knowledge of `a` such that P = a·B.
import { concatBytes, CryptoError, utf8 } from './bytes';
import { hashTagged } from './hash';
import {
  bytesToBigInt,
  mod,
  mul,
  pointFromHex,
  pointToBytes,
  pointToHex,
  randomScalar,
  scalarFromHex,
  scalarToBytes,
  scalarToHex,
  type Point,
} from './group';

export type ProofLabel = 'join' | 'reveal';

export interface ProofContext {
  /** 16-byte poll tag. */
  pollTag: Uint8Array;
  label: ProofLabel;
  /** 32-byte Nostr (x-only) pubkey of the prover. */
  pubkey: Uint8Array;
}

export interface Proof {
  R: Point;
  s: bigint;
}

export interface ProofJson {
  R: string;
  s: string;
}

function challenge(ctx: ProofContext, B: Point, P: Point, R: Point): bigint {
  const h = hashTagged(
    'pok',
    ctx.pollTag,
    utf8(ctx.label),
    ctx.pubkey,
    pointToBytes(B),
    pointToBytes(P),
    pointToBytes(R),
  );
  return mod(bytesToBigInt(h));
}

/** Prove knowledge of `a` with P = a·B. Returns the proof and P. */
export function prove(ctx: ProofContext, B: Point, a: bigint): { proof: Proof; P: Point } {
  const P = mul(B, a);
  for (;;) {
    const k = randomScalar();
    const R = mul(B, k);
    const e = challenge(ctx, B, P, R);
    const s = mod(k + e * a);
    // e = 0 or s = 0 happen with negligible probability; retry instead of
    // emitting a proof the verifier would reject.
    if (e !== 0n && s !== 0n) return { proof: { R, s }, P };
  }
}

export function verifyProof(ctx: ProofContext, B: Point, P: Point, proof: Proof): boolean {
  if (B.is0() || P.is0() || proof.R.is0()) return false;
  if (proof.s <= 0n) return false;
  const e = challenge(ctx, B, P, proof.R);
  if (e === 0n) return false;
  // s·B == R + e·P  (public values, so non-constant-time math is fine)
  const lhs = B.multiplyUnsafe(proof.s);
  const rhs = proof.R.add(P.multiplyUnsafe(e));
  return lhs.equals(rhs);
}

export function proofToJson(p: Proof): ProofJson {
  return { R: pointToHex(p.R), s: scalarToHex(p.s) };
}

export function proofFromJson(j: unknown): Proof {
  if (typeof j !== 'object' || j === null) throw new CryptoError('invalid proof');
  const o = j as Record<string, unknown>;
  return { R: pointFromHex(o.R), s: scalarFromHex(o.s) };
}

/** Canonical 65-byte encoding R (33) || s (32), used inside commitments. */
export function proofToBytes(p: Proof): Uint8Array {
  return concatBytes(pointToBytes(p.R), scalarToBytes(p.s));
}
