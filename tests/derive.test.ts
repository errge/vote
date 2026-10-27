import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  bytesToHex,
  castBallot,
  commitmentHash,
  G,
  joinHash,
  N,
  pollSecretFor,
  pointToHex,
  prove,
  proofToJson,
  randomBytes,
  randomScalar,
  sortRoster,
  transcriptHash,
  type Ballot,
  type Point,
  type Proof,
  type Vote,
} from '../src/crypto';
import { derivePollKeys, openEvent, sealEvent, type OpenedEvent, type PollKeys } from '../src/nostr/codec';
import { derivePoll, type PollEvent } from '../src/state/derive';
import type { EventType } from '../src/state/messages';

const T0 = 1_800_000_000;
const DEADLINE = T0 + 86400;

interface P {
  sk: Uint8Array;
  pubkey: string;
  name: string;
  x: bigint;
  X: Point;
  pok: Proof;
}

class Builder {
  keys!: PollKeys;
  creator!: P;
  salt = randomBytes(32);
  t = T0;

  static async make(): Promise<Builder> {
    const b = new Builder();
    const sk = generateSecretKey();
    b.keys = await derivePollKeys(pollSecretFor(getPublicKey(sk), b.salt));
    b.creator = b.party('Creator', sk);
    return b;
  }

  party(name: string, sk = generateSecretKey(), x = randomScalar()): P {
    const pubkey = getPublicKey(sk);
    const { proof, P: X } = prove({ pollTag: this.keys.pollTagBytes, label: 'join', pubkey: hexOf(pubkey) }, G, x);
    return { sk, pubkey, name, x, X, pok: proof };
  }

  async ev(type: EventType, p: P, payload: object, at = ++this.t): Promise<OpenedEvent> {
    const raw = await sealEvent(this.keys, type, payload, p.sk, DEADLINE, at);
    const o = await openEvent(this.keys, raw);
    if (!o) throw new Error('could not open own event');
    return o;
  }

  meta(p = this.creator, over: object = {}) {
    return this.ev('meta', p, {
      v: 1,
      question: 'Q?',
      size: null,
      deadline: DEADLINE,
      created: T0,
      salt: bytesToHex(this.salt),
      ...over,
    });
  }

  join(p: P, over: object = {}) {
    return this.ev('join', p, { v: 1, name: p.name, X: pointToHex(p.X), pok: proofToJson(p.pok), ...over });
  }

  entry(p: P) {
    return { pubkey: p.pubkey, joinHash: joinHash(this.keys.pollTagBytes, p.pubkey, p.name, p.X, p.pok) };
  }

  roster(members: P[], by = this.creator, sorted = true) {
    const entries = members.map((m) => this.entry(m));
    return this.ev('roster', by, { v: 1, members: sorted ? sortRoster(entries) : entries });
  }
}

function hexOf(h: string) {
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** Build an honest, complete event set. */
async function honest(votes: Vote[]) {
  const b = await Builder.make();
  const ps = [b.creator, ...votes.slice(1).map((_, i) => b.party(`P${i + 1}`))];
  const events: OpenedEvent[] = [await b.meta()];
  for (const p of ps) events.push(await b.join(p));
  const rosterEv = await b.roster(ps);
  events.push(rosterEv);
  const pre = derivePoll(b.keys.pollTagBytes, b.keys.pollSecret, events, T0 + 100);
  expect(pre.phase).toBe('committing');
  const members = pre.roster!.members;
  const byPk = new Map(ps.map((p, i) => [p.pubkey, { p, vote: votes[i]! }]));
  const ballots = new Map<string, Ballot>();
  const commits: OpenedEvent[] = [];
  for (const m of members) {
    const { p, vote } = byPk.get(m.pubkey)!;
    const bal = castBallot(b.keys.pollTagBytes, p.pubkey, p.x, m.Y!, vote, randomBytes(32));
    ballots.set(p.pubkey, bal);
    commits.push(await b.ev('commit', p, { v: 1, C: bal.commitment, roster: pre.roster!.hash }));
  }
  const transcript = transcriptHash(pre.roster!.hash, members.map((m) => ballots.get(m.pubkey)!.commitment));
  const reveals: OpenedEvent[] = [];
  for (const m of members) {
    const { p } = byPk.get(m.pubkey)!;
    reveals.push(await b.ev('reveal', p, revealPayload(ballots.get(p.pubkey)!, transcript)));
  }
  return { b, ps, members, events, rosterEv, commits, reveals, ballots, transcript, rosterHash: pre.roster!.hash };
}

function revealPayload(bal: Ballot, transcript: string, over: object = {}) {
  return { v: 1, V: pointToHex(bal.V), pok: proofToJson(bal.pok), salt: bytesToHex(bal.salt), transcript, ...over };
}

const derive = (b: Builder, evs: PollEvent[], now = T0 + 1000) =>
  derivePoll(b.keys.pollTagBytes, b.keys.pollSecret, evs, now);

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j]!, r[i]!];
  }
  return r;
}

describe('state derivation: phases', () => {
  it('loading without META; META from another key is ignored', async () => {
    const b = await Builder.make();
    expect(derive(b, []).phase).toBe('loading');
    const other = b.party('X');
    expect(derive(b, [await b.meta(other)]).phase).toBe('loading');
  });

  it('the creator is identified through the poll secret; impostors are ignored', async () => {
    const b = await Builder.make();
    const impostor = b.party('Mallory');
    // An impostor cannot reuse the creator's salt, nor bring their own.
    const fake1 = await b.meta(impostor, { question: 'Fake?' });
    const fake2 = await b.meta(impostor, { question: 'Fake?', salt: bytesToHex(randomBytes(32)) });
    expect(derive(b, [fake1, fake2]).phase).toBe('loading');
    const st = derive(b, [fake1, await b.meta(), fake2]);
    expect(st.creator).toBe(b.creator.pubkey);
    expect(st.meta!.question).toBe('Q?');
    // nor publish a roster
    const p = b.party('P');
    const r = await b.roster([b.creator, p], impostor);
    expect(derive(b, [await b.meta(), await b.join(b.creator), await b.join(p), r]).phase).toBe('joining');
  });

  it('a newer creator META without a binding salt aborts', async () => {
    const b = await Builder.make();
    const st = derive(b, [await b.meta(), await b.meta(b.creator, { salt: bytesToHex(randomBytes(32)) })]);
    expect(st.phase).toBe('aborted');
  });

  it('invalid META aborts', async () => {
    const b = await Builder.make();
    expect(derive(b, [await b.meta(b.creator, { deadline: 'tomorrow' })]).phase).toBe('aborted');
  });

  it('joining: lists valid joins, ignores bad proofs, disambiguates duplicate names', async () => {
    const b = await Builder.make();
    const a1 = b.party('Anna');
    const a2 = b.party('Anna');
    const bad = b.party('Bad');
    const st = derive(b, [
      await b.meta(),
      await b.join(b.creator),
      await b.join(a1),
      await b.join(a2),
      await b.join(bad, { pok: proofToJson(a1.pok) }), // stolen proof
    ]);
    expect(st.phase).toBe('joining');
    expect(st.joiners).toHaveLength(3);
    expect(st.joiners.filter((j) => j.label.startsWith('Anna ('))).toHaveLength(2);
    expect(st.progress.joined).toBe(3);
  });

  it('a ROSTER from someone other than the creator is ignored', async () => {
    const b = await Builder.make();
    const p = b.party('P');
    const st = derive(b, [await b.meta(), await b.join(b.creator), await b.join(p), await b.roster([b.creator, p], p)]);
    expect(st.phase).toBe('joining');
  });

  it('full honest run: all yes → unanimous; any veto → not; independent of event order', async () => {
    for (const votes of [
      ['yes', 'yes', 'yes'],
      ['yes', 'veto', 'yes'],
      ['veto', 'veto', 'veto', 'yes'],
    ] as Vote[][]) {
      const h = await honest(votes);
      const all = [...h.events, ...h.commits, ...h.reveals];
      for (let i = 0; i < 3; i++) {
        const st = derive(h.b, shuffle(all));
        expect(st.phase).toBe('result');
        expect(st.unanimous).toBe(!votes.includes('veto'));
        expect(st.progress).toEqual({ joined: votes.length, committed: votes.length, revealed: votes.length, total: votes.length });
      }
    }
  });

  it('progress and waiting lists per phase', async () => {
    const h = await honest(['yes', 'yes', 'yes']);
    const st1 = derive(h.b, [...h.events, h.commits[0]!]);
    expect(st1.phase).toBe('committing');
    expect(st1.progress.committed).toBe(1);
    expect(st1.waiting.commit).toHaveLength(2);
    expect(st1.waiting.reveal).toEqual([]);
    const st2 = derive(h.b, [...h.events, ...h.commits, h.reveals[2]!]);
    expect(st2.phase).toBe('revealing');
    expect(st2.progress.revealed).toBe(1);
    expect(st2.waiting.reveal).toEqual([h.members[0]!.label, h.members[1]!.label]);
  });

  it('a reveal seen before all commitments is not counted and does not abort', async () => {
    const h = await honest(['yes', 'yes', 'yes']);
    const st = derive(h.b, [...h.events, h.commits[0]!, h.commits[1]!, h.reveals[0]!]);
    expect(st.phase).toBe('committing');
    expect(st.progress.revealed).toBe(0);
  });

  it('a roster member whose JOIN has not arrived is listed as waiting', async () => {
    const h = await honest(['yes', 'yes', 'yes']);
    const withoutJoin = h.events.filter((e) => !(e.type === 'join' && e.pubkey === h.members[1]!.pubkey));
    const st = derive(h.b, withoutJoin);
    expect(st.phase).toBe('committing');
    expect(st.waiting.join).toHaveLength(1);
    expect(st.waiting.join[0]).toMatch(/^unknown/);
  });

  it('deadline: incomplete; events dated after the deadline do not count', async () => {
    const h = await honest(['yes', 'yes']);
    expect(derive(h.b, [...h.events, ...h.commits], DEADLINE + 1).phase).toBe('incomplete');
    const late = await h.b.ev('reveal', h.ps[1]!, { not: 'checked' }, DEADLINE + 5);
    const st = derive(h.b, [...h.events, ...h.commits, h.reveals.find((r) => r.pubkey === h.ps[0]!.pubkey)!, late], DEADLINE + 10);
    expect(st.phase).toBe('incomplete');
    expect(st.abort).toBeNull();
    // a completed result stays a result after the deadline
    expect(derive(h.b, [...h.events, ...h.commits, ...h.reveals], DEADLINE + 10).phase).toBe('result');
  });

  it('heal set contains the current valid events but not foreign META', async () => {
    const h = await honest(['yes', 'yes']);
    const foreign = await h.b.meta(h.ps[1]!);
    const all = [...h.events, ...h.commits, ...h.reveals, foreign];
    const st = derive(h.b, all);
    expect(new Set(st.healIds)).toEqual(new Set([...h.events, ...h.commits, ...h.reveals].map((e) => e.id)));
  });
});

describe('state derivation: deterministic replaceable-event selection', () => {
  it('newest created_at wins; ties go to the lowest id', async () => {
    const b = await Builder.make();
    const p = b.party('Old');
    const j1 = await b.join(p, {}, );
    const j2 = await b.ev('join', p, { v: 1, name: 'New', X: pointToHex(p.X), pok: proofToJson(p.pok) }, j1.created_at + 1);
    expect(derive(b, [await b.meta(), j1, j2]).joiners[0]!.name).toBe('New');
    expect(derive(b, [await b.meta(), j2, j1]).joiners[0]!.name).toBe('New');
    const tieA = await b.ev('join', p, { v: 1, name: 'A', X: pointToHex(p.X), pok: proofToJson(p.pok) }, 5_000_000_000 - 1);
    const tieB = await b.ev('join', p, { v: 1, name: 'B', X: pointToHex(p.X), pok: proofToJson(p.pok) }, 5_000_000_000 - 1);
    const lowest = tieA.id < tieB.id ? 'A' : 'B';
    const metaEv = await b.meta(b.creator, { deadline: 5_000_000_000, created: 4_999_000_000 });
    expect(derive(b, [metaEv, tieA, tieB]).joiners[0]!.name).toBe(lowest);
    expect(derive(b, [metaEv, tieB, tieA]).joiners[0]!.name).toBe(lowest);
  });

  it('roster order is by pubkey regardless of join order', async () => {
    const h = await honest(['yes', 'yes', 'yes', 'yes']);
    const pks = h.members.map((m) => m.pubkey);
    expect(pks).toEqual([...pks].sort());
    expect(h.members.map((m) => m.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('state derivation: integrity failures abort', () => {
  it('unsorted roster', async () => {
    const b = await Builder.make();
    const ps = [b.creator, b.party('A'), b.party('B')];
    const entries = ps.map((p) => b.entry(p));
    const unsorted = sortRoster(entries).reverse();
    const st = derive(b, [
      await b.meta(),
      ...(await Promise.all(ps.map((p) => b.join(p)))),
      await b.ev('roster', b.creator, { v: 1, members: unsorted }),
    ]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.reason).toMatch(/order/);
  });

  it('roster without the creator, or with fewer than 2 members', async () => {
    const b = await Builder.make();
    const a = b.party('A');
    const c = b.party('C');
    const base = [await b.meta(), await b.join(b.creator), await b.join(a), await b.join(c)];
    expect(derive(b, [...base, await b.roster([a, c])]).abort!.reason).toMatch(/creator/);
    expect(derive(b, [...base, await b.roster([b.creator])]).abort!.reason).toMatch(/size/);
  });

  it('JOIN changed after the roster (roster mismatch) names the participant', async () => {
    const h = await honest(['yes', 'yes', 'yes']);
    const victim = h.ps[2]!;
    const changed = await h.b.ev('join', victim, { v: 1, name: 'Renamed', X: pointToHex(victim.X), pok: proofToJson(victim.pok) });
    const st = derive(h.b, [...h.events, changed]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.pubkey).toBe(victim.pubkey);
    expect(st.abort!.reason).toMatch(/Renamed's join message does not match/);
  });

  it('roster member with an invalid join proof', async () => {
    const b = await Builder.make();
    const a = b.party('A');
    const bad = await b.join(a, { pok: proofToJson(b.creator.pok) });
    const roster = await b.ev('roster', b.creator, {
      v: 1,
      members: sortRoster([b.entry(b.creator), { pubkey: a.pubkey, joinHash: '11'.repeat(32) }]),
    });
    const st = derive(b, [await b.meta(), await b.join(b.creator), bad, roster]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.pubkey).toBe(a.pubkey);
  });

  it('identity Y_i', async () => {
    const b = await Builder.make();
    // Make the members at roster positions 1 and 2 have X_1 + X_2 = O, so Y_0 = O.
    const ps = [b.creator, b.party('A'), b.party('B')].sort((p, q) => (p.pubkey < q.pubkey ? -1 : 1));
    const x = randomScalar();
    ps[1] = b.party(ps[1]!.name, ps[1]!.sk, x);
    ps[2] = b.party(ps[2]!.name, ps[2]!.sk, N - x);
    expect(ps[1]!.X.add(ps[2]!.X).is0()).toBe(true);
    const creator = ps.find((p) => p.pubkey === b.creator.pubkey)!;
    b.creator = creator;
    const st = derive(b, [await b.meta(), ...(await Promise.all(ps.map((p) => b.join(p)))), await b.roster(ps)]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.reason).toMatch(/identity/);
  });

  it('duplicate X in the roster', async () => {
    const b = await Builder.make();
    const x = randomScalar();
    const a = b.party('A', generateSecretKey(), x);
    const c = b.party('C', generateSecretKey(), x);
    const st = derive(b, [await b.meta(), await b.join(b.creator), await b.join(a), await b.join(c), await b.roster([b.creator, a, c])]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.reason).toMatch(/reused/);
  });

  it('commit bound to a different roster', async () => {
    const h = await honest(['yes', 'yes']);
    const p = h.ps[1]!;
    const bad = await h.b.ev('commit', p, { v: 1, C: '22'.repeat(32), roster: '33'.repeat(32) });
    const st = derive(h.b, [...h.events, ...h.commits.filter((c) => c.pubkey !== p.pubkey), bad]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.reason).toMatch(/different group list/);
  });

  it('commitment mismatch (reveal with a different salt or V)', async () => {
    const h = await honest(['yes', 'veto', 'yes']);
    const p = h.ps[1]!;
    const bal = h.ballots.get(p.pubkey)!;
    const bad = await h.b.ev('reveal', p, revealPayload(bal, h.transcript, { salt: bytesToHex(randomBytes(32)) }));
    const st = derive(h.b, [...h.events, ...h.commits, ...h.reveals.filter((r) => r.pubkey !== p.pubkey), bad]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.pubkey).toBe(p.pubkey);
    expect(st.abort!.reason).toMatch(/does not match their commitment/);
  });

  it('a veto voter cannot flip the result to yes (bad proof under a matching commitment)', async () => {
    // Cheater wants Σ V = O although someone vetoed: they commit to V' = -(Σ others) with a fake proof.
    const h = await honest(['yes', 'veto', 'yes']);
    const cheaterIdx = 0;
    const cheater = h.members[cheaterIdx]!;
    const p = h.ps.find((q) => q.pubkey === cheater.pubkey)!;
    const others = h.members.filter((m) => m.pubkey !== cheater.pubkey).map((m) => h.ballots.get(m.pubkey)!.V);
    const Vfake = others.reduce((a, v) => a.add(v)).negate();
    const fakePok = h.ballots.get(p.pubkey)!.pok;
    const salt = randomBytes(32);
    const C = commitmentHash(h.b.keys.pollTagBytes, p.pubkey, Vfake, fakePok, salt);
    const commitEv = await h.b.ev('commit', p, { v: 1, C, roster: h.rosterHash });
    const commits = h.members.map((m) => (m.pubkey === p.pubkey ? C : h.ballots.get(m.pubkey)!.commitment));
    const transcript = transcriptHash(h.rosterHash, commits);
    const reveal = await h.b.ev('reveal', p, {
      v: 1,
      V: pointToHex(Vfake),
      pok: proofToJson(fakePok),
      salt: bytesToHex(salt),
      transcript,
    });
    const honestReveals = [];
    for (const m of h.members) {
      if (m.pubkey === p.pubkey) continue;
      const q = h.ps.find((x) => x.pubkey === m.pubkey)!;
      honestReveals.push(await h.b.ev('reveal', q, revealPayload(h.ballots.get(q.pubkey)!, transcript)));
    }
    const st = derive(h.b, [...h.events, ...h.commits.filter((c) => c.pubkey !== p.pubkey), commitEv, reveal, ...honestReveals]);
    expect(st.phase).toBe('aborted');
    expect(st.unanimous).toBeNull();
    expect(st.abort!.reason).toMatch(/proof is invalid/);
  });

  it('transcript mismatch: a commitment replaced after others revealed', async () => {
    const h = await honest(['yes', 'yes', 'yes']);
    const p = h.ps[2]!;
    const m = h.members.find((x) => x.pubkey === p.pubkey)!;
    // Re-vote: new ballot + newer commit event, after the others revealed against the old transcript.
    const nb = castBallot(h.b.keys.pollTagBytes, p.pubkey, p.x, m.Y!, 'veto', randomBytes(32));
    const recommit = await h.b.ev('commit', p, { v: 1, C: nb.commitment, roster: h.rosterHash });
    const others = h.reveals.filter((r) => r.pubkey !== p.pubkey);
    const st = derive(h.b, [...h.events, ...h.commits, recommit, ...others]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.reason).toMatch(/different set of commitments/);
  });

  it('a reveal with a wrong transcript hash', async () => {
    const h = await honest(['yes', 'yes']);
    const p = h.ps[0]!;
    const bad = await h.b.ev('reveal', p, revealPayload(h.ballots.get(p.pubkey)!, '44'.repeat(32)));
    const st = derive(h.b, [...h.events, ...h.commits, bad]);
    expect(st.phase).toBe('aborted');
    expect(st.abort!.pubkey).toBe(p.pubkey);
  });

  it('a reveal with an invalid point', async () => {
    const h = await honest(['yes', 'yes']);
    const p = h.ps[0]!;
    const bal = h.ballots.get(p.pubkey)!;
    const bad = await h.b.ev('reveal', p, revealPayload(bal, h.transcript, { V: '02' + 'ff'.repeat(32) }));
    const st = derive(h.b, [...h.events, ...h.commits, bad]);
    expect(st.phase).toBe('aborted');
  });

  it('malformed commit from a roster member', async () => {
    const h = await honest(['yes', 'yes']);
    const bad = await h.b.ev('commit', h.ps[1]!, { v: 1, C: 'nothex', roster: h.rosterHash });
    expect(derive(h.b, [...h.events, bad]).phase).toBe('aborted');
  });

  it('events from non-members do not affect the result', async () => {
    const h = await honest(['yes', 'yes']);
    const outsider = h.b.party('Out');
    const st = derive(h.b, [
      ...h.events,
      ...h.commits,
      ...h.reveals,
      await h.b.join(outsider),
      await h.b.ev('commit', outsider, { v: 1, C: '55'.repeat(32), roster: h.rosterHash }),
      await h.b.ev('reveal', outsider, revealPayload(h.ballots.values().next().value!, h.transcript)),
    ]);
    expect(st.phase).toBe('result');
    expect(st.unanimous).toBe(true);
  });
});

describe('codec', () => {
  it('rejects events with a tampered content, AAD mismatch or bad signature', async () => {
    const b = await Builder.make();
    const raw = await sealEvent(b.keys, 'join', { v: 1 }, b.creator.sk, DEADLINE);
    expect(await openEvent(b.keys, raw)).not.toBeNull();
    // (JSON round trip: like events from a relay, without nostr-tools' cached verification flag)
    const tampered = JSON.parse(JSON.stringify({ ...raw, sig: raw.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }));
    expect(await openEvent(b.keys, tampered)).toBeNull();
    const tamperedContent = JSON.parse(JSON.stringify(raw));
    tamperedContent.content = tamperedContent.content.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A'));
    expect(await openEvent(b.keys, tamperedContent)).toBeNull();
    // moving the ciphertext to another type (d tag) breaks AAD; re-sign to pass the signature check
    const moved = await sealEvent(b.keys, 'commit', { v: 1 }, b.creator.sk, DEADLINE);
    const { finalizeEvent } = await import('nostr-tools/pure');
    const resigned = finalizeEvent({ kind: moved.kind, created_at: moved.created_at, tags: moved.tags, content: raw.content }, b.creator.sk);
    expect(await openEvent(b.keys, resigned)).toBeNull();
    const other = await derivePollKeys(randomBytes(16));
    expect(await openEvent(other, raw)).toBeNull();
  });

  it('sets d and expiration tags', async () => {
    const b = await Builder.make();
    const raw = await sealEvent(b.keys, 'reveal', { v: 1 }, b.creator.sk, DEADLINE);
    expect(raw.kind).toBe(30078);
    expect(raw.tags).toContainEqual(['d', `${b.keys.pollTag}:reveal`]);
    expect(raw.tags).toContainEqual(['expiration', String(DEADLINE + 7 * 86400)]);
  });
});


