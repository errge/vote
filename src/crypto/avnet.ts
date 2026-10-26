// Anonymous Veto Network (Hao & Zieliński 2006) with a commit round.
// Pure functions; all inputs are already-decoded group elements.
import { bytesToHex, concatBytes, CryptoError, equalBytes, hexToBytes, utf8 } from './bytes';
import { hashTagged } from './hash';
import { G, O, pointToBytes, randomScalar, sumPoints, type Point } from './group';
import { prove, proofToBytes, verifyProof, type Proof, type ProofContext } from './proof';

export type Vote = 'yes' | 'veto';

export interface RosterEntry {
  /** 64-hex Nostr pubkey */
  pubkey: string;
  /** 64-hex hash of the member's JOIN payload */
  joinHash: string;
}

function ctx(pollTag: Uint8Array, label: 'join' | 'reveal', pubkey: string): ProofContext {
  return { pollTag, label, pubkey: hexToBytes(pubkey, 32) };
}

// ---- Round 1: JOIN ----------------------------------------------------------

export function makeJoinKey(pollTag: Uint8Array, pubkey: string): { x: bigint; X: Point; pok: Proof } {
  const x = randomScalar();
  const { proof, P } = prove(ctx(pollTag, 'join', pubkey), G, x);
  return { x, X: P, pok: proof };
}

export function verifyJoinProof(pollTag: Uint8Array, pubkey: string, X: Point, pok: Proof): boolean {
  return verifyProof(ctx(pollTag, 'join', pubkey), G, X, pok);
}

/** H(joinPayload): binds pubkey, display name, X and the proof. */
export function joinHash(pollTag: Uint8Array, pubkey: string, name: string, X: Point, pok: Proof): string {
  return bytesToHex(
    hashTagged('join', pollTag, hexToBytes(pubkey, 32), utf8(name), pointToBytes(X), proofToBytes(pok)),
  );
}

// ---- Roster -----------------------------------------------------------------

export function compareHex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortRoster(entries: RosterEntry[]): RosterEntry[] {
  return [...entries].sort((a, b) => compareHex(a.pubkey, b.pubkey));
}

export function isCanonicalRoster(entries: RosterEntry[]): boolean {
  for (let i = 1; i < entries.length; i++) {
    if (compareHex(entries[i - 1]!.pubkey, entries[i]!.pubkey) >= 0) return false;
  }
  return true;
}

export function rosterHash(pollTag: Uint8Array, entries: RosterEntry[]): string {
  if (!isCanonicalRoster(entries)) throw new CryptoError('roster is not sorted / has duplicates');
  const parts = entries.map((e) => concatBytes(hexToBytes(e.pubkey, 32), hexToBytes(e.joinHash, 32)));
  return bytesToHex(hashTagged('roster', pollTag, ...parts));
}

// ---- Y_i --------------------------------------------------------------------

/** Y_i = Σ_{j<i} X_j − Σ_{j>i} X_j. Throws if any Y_i is the identity. */
export function computeYs(Xs: Point[]): Point[] {
  const Ys: Point[] = [];
  const total = sumPoints(Xs);
  let before = O; // Σ_{j<i} X_j
  for (let i = 0; i < Xs.length; i++) {
    const Xi = Xs[i]!;
    const after = total.subtract(before).subtract(Xi); // Σ_{j>i} X_j
    const Y = before.subtract(after);
    if (Y.is0()) throw new CryptoError(`Y_${i} is the identity`);
    Ys.push(Y);
    before = before.add(Xi);
  }
  return Ys;
}

// ---- Round 2: COMMIT ----------------------------------------------------------

export interface Ballot {
  V: Point;
  pok: Proof;
  salt: Uint8Array;
  commitment: string;
}

/**
 * Yes: c = x. Veto: c is a fresh random scalar ≠ x. V = c·Y, and the proof of
 * knowledge of c w.r.t. base Y is produced identically for both choices.
 */
export function castBallot(
  pollTag: Uint8Array,
  pubkey: string,
  x: bigint,
  Y: Point,
  vote: Vote,
  salt: Uint8Array,
): Ballot {
  let c = x;
  if (vote === 'veto') {
    do c = randomScalar();
    while (c === x);
  }
  const { proof, P: V } = prove(ctx(pollTag, 'reveal', pubkey), Y, c);
  return { V, pok: proof, salt, commitment: commitmentHash(pollTag, pubkey, V, proof, salt) };
}

export function commitmentHash(pollTag: Uint8Array, pubkey: string, V: Point, pok: Proof, salt: Uint8Array): string {
  if (salt.length !== 32) throw new CryptoError('salt must be 32 bytes');
  return bytesToHex(
    hashTagged('commit', pollTag, hexToBytes(pubkey, 32), pointToBytes(V), proofToBytes(pok), salt),
  );
}

// ---- Round 3: REVEAL ----------------------------------------------------------

/** H(rosterHash || C_1 || … || C_n) with commitments in roster order. */
export function transcriptHash(rosterHashHex: string, commitments: string[]): string {
  return bytesToHex(
    hashTagged('transcript', hexToBytes(rosterHashHex, 32), ...commitments.map((c) => hexToBytes(c, 32))),
  );
}

export function verifyRevealProof(pollTag: Uint8Array, pubkey: string, Y: Point, V: Point, pok: Proof): boolean {
  return verifyProof(ctx(pollTag, 'reveal', pubkey), Y, V, pok);
}

export function commitmentMatches(
  pollTag: Uint8Array,
  pubkey: string,
  V: Point,
  pok: Proof,
  salt: Uint8Array,
  commitment: string,
): boolean {
  return equalBytes(hexToBytes(commitmentHash(pollTag, pubkey, V, pok, salt)), hexToBytes(commitment, 32));
}

// ---- Result -------------------------------------------------------------------

/** True iff Σ V_i is the identity, i.e. everybody voted yes. */
export function isUnanimous(Vs: Point[]): boolean {
  return sumPoints(Vs).is0();
}

