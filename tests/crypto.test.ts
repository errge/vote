import { describe, expect, it } from 'vitest';
import {
  castBallot,
  commitmentHash,
  commitmentMatches,
  computeYs,
  CryptoError,
  derivePollTag,
  G,
  isCreatorBinding,
  pollSecretFor,
  POLL_SECRET_BYTES,
  hexToBytes,
  isUnanimous,
  joinHash,
  makeJoinKey,
  mod,
  mul,
  N,
  O,
  pointFromHex,
  pointToHex,
  proofFromJson,
  prove,
  randomBytes,
  randomScalar,
  rosterHash,
  scalarFromHex,
  sortRoster,
  transcriptHash,
  verifyJoinProof,
  verifyProof,
  verifyRevealProof,
  type Vote,
} from '../src/crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const pollTagHex = derivePollTag(randomBytes(16));
const pollTag = hexToBytes(pollTagHex);

function party() {
  const pubkey = getPublicKey(generateSecretKey());
  return { pubkey, ...makeJoinKey(pollTag, pubkey) };
}

/** Run a full in-memory AV-net among `votes.length` parties. */
function simulate(votes: Vote[]) {
  const parties = votes.map(() => party()).sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
  const Ys = computeYs(parties.map((p) => p.X));
  const ballots = parties.map((p, i) => castBallot(pollTag, p.pubkey, p.x, Ys[i]!, votes[i]!, randomBytes(32)));
  ballots.forEach((b, i) => {
    expect(verifyRevealProof(pollTag, parties[i]!.pubkey, Ys[i]!, b.V, b.pok)).toBe(true);
    expect(commitmentMatches(pollTag, parties[i]!.pubkey, b.V, b.pok, b.salt, b.commitment)).toBe(true);
  });
  return isUnanimous(ballots.map((b) => b.V));
}

describe('AV-net simulated polls', () => {
  for (const n of [2, 3, 5, 9]) {
    it(`${n} parties, all yes → unanimous`, () => {
      expect(simulate(Array<Vote>(n).fill('yes'))).toBe(true);
    });
    it(`${n} parties, a single veto at each position → not unanimous`, () => {
      for (let i = 0; i < n; i++) {
        const votes = Array<Vote>(n).fill('yes');
        votes[i] = 'veto';
        expect(simulate(votes)).toBe(false);
      }
    });
    it(`${n} parties, several / all vetoes → not unanimous`, () => {
      expect(simulate(Array<Vote>(n).fill('veto'))).toBe(false);
      const votes = Array<Vote>(n).fill('yes');
      votes[0] = 'veto';
      votes[n - 1] = 'veto';
      expect(simulate(votes)).toBe(false);
    });
  }

  it('Σ x_i·Y_i = O', () => {
    const ps = [party(), party(), party(), party()];
    const Ys = computeYs(ps.map((p) => p.X));
    let S = O;
    ps.forEach((p, i) => (S = S.add(mul(Ys[i]!, p.x))));
    expect(S.is0()).toBe(true);
  });

  it('rejects an identity Y_i', () => {
    const x = randomScalar();
    const X1 = mul(G, x);
    const X2 = mul(G, N - x); // X1 + X2 = O → Y_0 = −(X1 + X2) = O
    expect(() => computeYs([mul(G, randomScalar()), X1, X2])).toThrow(CryptoError);
  });

  it('yes and veto ballots have the same shape', () => {
    const p = party();
    const Y = computeYs([p.X, party().X])[0]!;
    const yes = castBallot(pollTag, p.pubkey, p.x, Y, 'yes', randomBytes(32));
    const no = castBallot(pollTag, p.pubkey, p.x, Y, 'veto', randomBytes(32));
    expect(pointToHex(yes.V)).toHaveLength(pointToHex(no.V).length);
    expect(yes.commitment).toHaveLength(64);
    expect(no.commitment).toHaveLength(64);
  });
});

describe('Schnorr proofs', () => {
  const ctx = { pollTag, label: 'join' as const, pubkey: hexToBytes(getPublicKey(generateSecretKey())) };

  it('verifies a valid proof', () => {
    const a = randomScalar();
    const { proof, P } = prove(ctx, G, a);
    expect(verifyProof(ctx, G, P, proof)).toBe(true);
  });

  it('rejects tampered s, R, P, base, label, pubkey and pollTag', () => {
    const a = randomScalar();
    const B = mul(G, randomScalar());
    const { proof, P } = prove(ctx, B, a);
    expect(verifyProof(ctx, B, P, proof)).toBe(true);
    expect(verifyProof(ctx, B, P, { ...proof, s: mod(proof.s + 1n) })).toBe(false);
    expect(verifyProof(ctx, B, P, { ...proof, R: proof.R.add(G) })).toBe(false);
    expect(verifyProof(ctx, B, P.add(G), proof)).toBe(false);
    expect(verifyProof(ctx, G, P, proof)).toBe(false);
    expect(verifyProof({ ...ctx, label: 'reveal' }, B, P, proof)).toBe(false);
    expect(verifyProof({ ...ctx, pubkey: hexToBytes(getPublicKey(generateSecretKey())) }, B, P, proof)).toBe(false);
    expect(verifyProof({ ...ctx, pollTag: randomBytes(16) }, B, P, proof)).toBe(false);
    expect(verifyProof(ctx, B, P, { R: O, s: proof.s })).toBe(false);
    expect(verifyProof(ctx, B, P, { R: proof.R, s: 0n })).toBe(false);
  });

  it('a join proof cannot be replayed under another pubkey (rogue key / copy)', () => {
    const p = party();
    expect(verifyJoinProof(pollTag, p.pubkey, p.X, p.pok)).toBe(true);
    expect(verifyJoinProof(pollTag, getPublicKey(generateSecretKey()), p.X, p.pok)).toBe(false);
  });

  it('a reveal proof made for one Y does not verify for another', () => {
    const p = party();
    const [Y0, Y1] = computeYs([p.X, party().X, party().X]);
    const b = castBallot(pollTag, p.pubkey, p.x, Y0!, 'yes', randomBytes(32));
    expect(verifyRevealProof(pollTag, p.pubkey, Y0!, b.V, b.pok)).toBe(true);
    expect(verifyRevealProof(pollTag, p.pubkey, Y1!, b.V, b.pok)).toBe(false);
  });

  it('rejects a veto disguised with a forged proof (c unknown)', () => {
    const p = party();
    const Y = computeYs([p.X, party().X])[0]!;
    const b = castBallot(pollTag, p.pubkey, p.x, Y, 'yes', randomBytes(32));
    // Replace V by a random point while keeping the proof → must fail.
    expect(verifyRevealProof(pollTag, p.pubkey, Y, mul(G, randomScalar()), b.pok)).toBe(false);
  });
});

describe('commitments and transcripts', () => {
  it('commitment mismatch on any changed field', () => {
    const p = party();
    const Y = computeYs([p.X, party().X])[0]!;
    const b = castBallot(pollTag, p.pubkey, p.x, Y, 'veto', randomBytes(32));
    expect(commitmentMatches(pollTag, p.pubkey, b.V, b.pok, b.salt, b.commitment)).toBe(true);
    expect(commitmentMatches(pollTag, p.pubkey, b.V, b.pok, randomBytes(32), b.commitment)).toBe(false);
    expect(commitmentMatches(pollTag, p.pubkey, b.V.add(G), b.pok, b.salt, b.commitment)).toBe(false);
    expect(
      commitmentMatches(pollTag, p.pubkey, b.V, { ...b.pok, s: mod(b.pok.s + 1n) }, b.salt, b.commitment),
    ).toBe(false);
    expect(commitmentMatches(pollTag, getPublicKey(generateSecretKey()), b.V, b.pok, b.salt, b.commitment)).toBe(
      false,
    );
    expect(commitmentHash(pollTag, p.pubkey, b.V, b.pok, b.salt)).toBe(b.commitment);
  });

  it('transcript changes when a commitment or the roster changes / is reordered', () => {
    const r = 'ab'.repeat(32);
    const c = ['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)];
    const t = transcriptHash(r, c);
    expect(transcriptHash(r, c)).toBe(t);
    expect(transcriptHash(r, [c[0]!, c[1]!, '04'.repeat(32)])).not.toBe(t);
    expect(transcriptHash(r, [c[1]!, c[0]!, c[2]!])).not.toBe(t);
    expect(transcriptHash('cd'.repeat(32), c)).not.toBe(t);
  });
});

describe('roster ordering', () => {
  it('sorting is deterministic and rosterHash is order-independent of input', () => {
    const entries = [party(), party(), party(), party()].map((p) => ({
      pubkey: p.pubkey,
      joinHash: joinHash(pollTag, p.pubkey, 'n', p.X, p.pok),
    }));
    const a = sortRoster(entries);
    const b = sortRoster([...entries].reverse());
    expect(a).toEqual(b);
    expect(rosterHash(pollTag, a)).toBe(rosterHash(pollTag, b));
    for (let i = 1; i < a.length; i++) expect(a[i - 1]!.pubkey < a[i]!.pubkey).toBe(true);
  });

  it('rejects unsorted or duplicate rosters', () => {
    const e = sortRoster(
      [party(), party()].map((p) => ({ pubkey: p.pubkey, joinHash: '00'.repeat(32) })),
    );
    expect(() => rosterHash(pollTag, [e[1]!, e[0]!])).toThrow(CryptoError);
    expect(() => rosterHash(pollTag, [e[0]!, e[0]!])).toThrow(CryptoError);
  });

  it('joinHash binds the name', () => {
    const p = party();
    expect(joinHash(pollTag, p.pubkey, 'Alice', p.X, p.pok)).not.toBe(joinHash(pollTag, p.pubkey, 'Alicf', p.X, p.pok));
  });
});

describe('encodings reject invalid input', () => {
  it('points', () => {
    const P = mul(G, randomScalar());
    expect(pointFromHex(pointToHex(P)).equals(P)).toBe(true);
    expect(() => pointFromHex('00')).toThrow(CryptoError); // identity / bad length
    expect(() => pointFromHex('02' + 'ff'.repeat(32))).toThrow(CryptoError); // x ≥ p
    expect(() => pointFromHex('05' + pointToHex(P).slice(2))).toThrow(CryptoError); // bad prefix
    expect(() => pointFromHex(P.toHex(false))).toThrow(CryptoError); // uncompressed not allowed
    expect(() => pointFromHex(pointToHex(P).toUpperCase())).toThrow(CryptoError);
    expect(() => pointFromHex(42)).toThrow(CryptoError);
    expect(() => pointToHex(O)).toThrow(CryptoError);
    // x = 5 is not on secp256k1 (5^3 + 7 = 132 is a non-residue mod p)
    expect(() => pointFromHex('02' + '00'.repeat(31) + '05')).toThrow(CryptoError);
  });

  it('scalars', () => {
    expect(() => scalarFromHex('00'.repeat(32))).toThrow(CryptoError);
    expect(() => scalarFromHex(N.toString(16).padStart(64, '0'))).toThrow(CryptoError);
    expect(() => scalarFromHex('01')).toThrow(CryptoError);
    expect(scalarFromHex('00'.repeat(31) + '01')).toBe(1n);
    expect(() => mul(G, 0n)).toThrow(CryptoError);
  });

  it('proof JSON', () => {
    expect(() => proofFromJson(null)).toThrow(CryptoError);
    expect(() => proofFromJson({ R: pointToHex(G), s: '00'.repeat(32) })).toThrow(CryptoError);
  });
});

describe('poll key derivation', () => {
  it('pollTag is 32 hex chars and deterministic', () => {
    const s = randomBytes(16);
    expect(derivePollTag(s)).toMatch(/^[0-9a-f]{32}$/);
    expect(derivePollTag(s)).toBe(derivePollTag(s));
    expect(derivePollTag(randomBytes(16))).not.toBe(derivePollTag(s));
    expect(() => derivePollTag(randomBytes(32))).toThrow(CryptoError);
  });

  it('the poll secret binds the creator pubkey', () => {
    const pk = getPublicKey(generateSecretKey());
    const salt = randomBytes(32);
    const secret = pollSecretFor(pk, salt);
    expect(secret).toHaveLength(POLL_SECRET_BYTES);
    expect(pollSecretFor(pk, salt)).toEqual(secret);
    const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(isCreatorBinding(secret, pk, saltHex)).toBe(true);
    expect(isCreatorBinding(secret, getPublicKey(generateSecretKey()), saltHex)).toBe(false);
    expect(isCreatorBinding(secret, pk, '00'.repeat(32))).toBe(false);
    expect(isCreatorBinding(secret, pk, 'zz')).toBe(false);
    expect(isCreatorBinding(secret, pk, undefined)).toBe(false);
  });
});
