import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools/pure';
import { Clock, FakeNetwork, Party, settle } from './helpers/fake-network';
import { base64ToBytes, type Vote } from '../src/crypto';

const RELAYS = ['wss://a.test', 'wss://b.test', 'wss://c.test'];

async function runPoll(votes: Vote[], opts: { size?: boolean } = {}) {
  const net = new FakeNetwork(RELAYS);
  const clock = new Clock();
  const parties = votes.map((_, i) => new Party(`P${i}`, net, clock));
  const [creator, ...others] = parties;
  const link = await creator!.create({ size: opts.size ? votes.length : null });
  const cs = await creator!.open(link);
  await cs.setVote(votes[0]!);
  for (const [i, p] of others.entries()) await p.join(link, votes[i + 1]!);
  await settle(parties);
  if (!opts.size) {
    expect(cs.state.phase).toBe('joining');
    await cs.requestLock();
  }
  await settle(parties);
  return { net, clock, parties, link };
}

describe('simulated polls through sessions', () => {
  it('all yes → unanimous yes for everyone (manual lock)', async () => {
    const { parties } = await runPoll(['yes', 'yes', 'yes']);
    for (const p of parties) {
      expect(p.session!.state.phase).toBe('result');
      expect(p.session!.state.unanimous).toBe(true);
    }
  });

  it('auto-locks when the expected group size is reached', async () => {
    const { parties } = await runPoll(['yes', 'yes', 'yes', 'yes'], { size: true });
    for (const p of parties) expect(p.session!.state.unanimous).toBe(true);
  });

  it('single veto (at every position) → not unanimous for everyone', async () => {
    for (let v = 0; v < 3; v++) {
      const votes: Vote[] = ['yes', 'yes', 'yes'];
      votes[v] = 'veto';
      const { parties } = await runPoll(votes, { size: true });
      for (const p of parties) {
        expect(p.session!.state.phase).toBe('result');
        expect(p.session!.state.unanimous).toBe(false);
      }
    }
  });

  it('several vetoes → not unanimous', async () => {
    const { parties } = await runPoll(['veto', 'yes', 'veto', 'yes', 'veto'], { size: true });
    for (const p of parties) expect(p.session!.state.unanimous).toBe(false);
  });

  it('two people, both yes', async () => {
    const { parties } = await runPoll(['yes', 'yes'], { size: true });
    for (const p of parties) expect(p.session!.state.unanimous).toBe(true);
  });

  it('wipes local secrets once final, keeps public events', async () => {
    const { parties } = await runPoll(['yes', 'veto', 'yes'], { size: true });
    for (const p of parties) {
      const L = p.session!.local!;
      expect(L.wiped).toBe(true);
      expect(L.sk).toBeNull();
      expect(L.x).toBeNull();
      expect(L.vote).toBeNull();
      expect(L.ballot).toBeNull();
      expect(L.events.reveal).toBeDefined();
    }
  });

  it('commit/reveal events of yes and veto voters are indistinguishable in size and shape', async () => {
    const { net, parties } = await runPoll(['yes', 'veto', 'yes'], { size: true });
    const lens = (type: string) =>
      parties.map((p) => p.session!.local!.events[type as 'commit']!).map((e: Event) => e.content.length);
    for (const type of ['commit', 'reveal']) expect(new Set(lens(type)).size).toBe(1);
    // relays only ever see ciphertext
    for (const store of net.stores.values()) {
      for (const ev of store.values()) {
        expect(ev.content).toMatch(/^[A-Za-z0-9+/]+=*$/);
        const raw = new TextDecoder('latin1').decode(base64ToBytes(ev.content));
        for (const plain of ['Dinner together', '"name"', '"v":1']) expect(raw).not.toContain(plain);
      }
    }
  });
});

describe('asynchronous participation', () => {
  it('a participant who votes later commits on setVote; vote is final after commit', async () => {
    const net = new FakeNetwork(RELAYS);
    const clock = new Clock();
    const a = new Party('Alice', net, clock);
    const b = new Party('Bob', net, clock);
    const c = new Party('Carol', net, clock);
    const link = await a.create({ size: 3 });
    await a.open(link);
    await a.session!.setVote('yes');
    await b.join(link, 'veto');
    await b.session!.setVote('yes'); // changed before the lock: allowed
    await c.join(link, null); // no vote yet
    await settle([a, b, c]);
    expect(c.session!.state.phase).toBe('committing');
    expect(c.session!.state.waiting.commit).toEqual(['Carol']);
    await c.session!.setVote('yes');
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.session!.state.unanimous).toBe(true);
  });

  it('vote cannot be changed after the commit', async () => {
    const net = new FakeNetwork(RELAYS);
    const clock = new Clock();
    const [a, b, c] = ['A', 'B', 'C'].map((n) => new Party(n, net, clock)) as [Party, Party, Party];
    const link = await a.create({ size: 3 });
    await a.open(link);
    await a.session!.setVote('veto');
    await b.join(link, 'yes');
    await c.join(link, null);
    await settle([a, b, c]);
    expect(a.session!.local!.ballot).not.toBeNull();
    await a.session!.setVote('yes'); // ignored: already committed
    expect(a.session!.local!.vote).toBe('veto');
    await c.session!.setVote('yes');
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.session!.state.unanimous).toBe(false);
  });

  it('closing and reopening the page: reveal happens on reopen', async () => {
    const net = new FakeNetwork(RELAYS);
    const clock = new Clock();
    const [a, b, c] = ['A', 'B', 'C'].map((n) => new Party(n, net, clock)) as [Party, Party, Party];
    const link = await a.create({ size: 3 });
    await a.open(link);
    await a.session!.setVote('yes');
    await b.join(link, 'yes');
    await settle([a, b]);
    b.close(); // Bob closes the page before the group is complete
    await c.join(link, 'yes');
    await settle([a, c]);
    expect(a.session!.state.phase).toBe('committing');
    expect(a.session!.state.waiting.commit).toEqual(['B']);
    await b.open(link); // Bob comes back: commit…
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.session!.state.unanimous).toBe(true);
  });

  it('participants who are offline when everyone has committed reveal when they reopen', async () => {
    const net = new FakeNetwork(RELAYS);
    const clock = new Clock();
    const [a, b, c] = ['A', 'B', 'C'].map((n) => new Party(n, net, clock)) as [Party, Party, Party];
    const link = await a.create({ size: 3 });
    await a.open(link);
    await a.session!.setVote('yes');
    await b.join(link, 'yes');
    await settle([a, b]);
    a.close();
    b.close();
    await c.join(link, 'yes');
    await settle([c]);
    // the creator is offline, so nobody can lock the group yet
    expect(c.session!.state.phase).toBe('joining');
    await a.open(link); // creator back: auto-lock → commit
    await settle([a, c]);
    expect(a.session!.state.waiting.commit).toEqual(['B']);
    await b.open(link);
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.session!.state.phase).toBe('result');
  });
});

describe('deadline', () => {
  it('incomplete after the deadline, naming who is missing, and secrets are wiped', async () => {
    const net = new FakeNetwork(RELAYS);
    const clock = new Clock();
    const [a, b, c] = ['A', 'B', 'C'].map((n) => new Party(n, net, clock)) as [Party, Party, Party];
    const link = await a.create({ size: 3, durationSeconds: 3600 });
    await a.open(link);
    await a.session!.setVote('yes');
    await b.join(link, 'yes');
    await c.join(link, null);
    await settle([a, b, c]);
    clock.advance(3601);
    for (const p of [a, b, c]) p.session!.recompute();
    await settle([a, b, c]);
    for (const p of [a, b, c]) {
      expect(p.session!.state.phase).toBe('incomplete');
      expect(p.session!.state.waiting.commit).toEqual(['C']);
      expect(p.session!.state.unanimous).toBeNull();
      expect(p.session!.local!.wiped).toBe(true);
    }
    // C can no longer vote
    await c.session!.setVote('yes');
    expect(c.session!.local!.events.commit).toBeUndefined();
  });
});

describe('resilience', () => {
  it('re-publishes events to relays that dropped them', async () => {
    const { net, parties } = await runPoll(['yes', 'yes', 'yes'], { size: true });
    const ev = parties[1]!.session!.local!.events.commit!;
    net.drop('wss://a.test', ev.id);
    expect(net.has('wss://a.test', ev.id)).toBe(false);
    await parties[2]!.open(parties[2]!.session!.link);
    await settle(parties);
    expect(net.has('wss://a.test', ev.id)).toBe(true);
  });

  it('works when one relay rejects everything and another is down', async () => {
    const net = new FakeNetwork(RELAYS);
    net.rejecting.add('wss://a.test');
    net.down.add('wss://b.test');
    const clock = new Clock();
    const [a, b, c] = ['A', 'B', 'C'].map((n) => new Party(n, net, clock)) as [Party, Party, Party];
    const link = await a.create({ size: 3 });
    await a.open(link);
    await a.session!.setVote('yes');
    await b.join(link, 'yes');
    await c.join(link, 'veto');
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.session!.state.unanimous).toBe(false);
    const log = a.session!.publishLog.find((l) => l.type === 'commit')!;
    expect(log.results!.map((r) => r.ok)).toEqual([false, false, true]);
  });

  it('two tabs of the same participant never produce two commitments', async () => {
    const net = new FakeNetwork(RELAYS);
    const clock = new Clock();
    const [a, b] = ['A', 'B'].map((n) => new Party(n, net, clock)) as [Party, Party];
    const link = await a.create({ size: 2 });
    await a.open(link);
    await a.session!.setVote('yes');
    await b.join(link, 'yes');
    await settle([a, b]);
    // second "tab" sharing Bob's storage
    const tab2 = new Party('B', net, clock);
    Object.assign(tab2, { store: b.store });
    await tab2.open(link);
    await settle([a, b, tab2]);
    expect(b.session!.state.unanimous).toBe(true);
    expect(tab2.session!.state.unanimous).toBe(true);
  });
});

describe('membership', () => {
  it('creator can exclude a duplicate join; excluded device cannot vote', async () => {
    const net = new FakeNetwork(RELAYS);
    const clock = new Clock();
    const [a, b, dup] = ['A', 'B', 'B'].map((n) => new Party(n, net, clock)) as [Party, Party, Party];
    const link = await a.create();
    const cs = await a.open(link);
    await cs.setVote('yes');
    await b.join(link, 'yes');
    await dup.join(link, 'veto');
    await settle([a, b, dup]);
    expect(cs.state.joiners.map((j) => j.label).filter((l) => l.startsWith('B ('))).toHaveLength(2);
    cs.setExcluded(dup.session!.myPubkey!, true);
    await cs.requestLock();
    await settle([a, b, dup]);
    expect(dup.session!.me).toBeNull();
    expect(dup.session!.local!.events.commit).toBeUndefined();
    for (const p of [a, b]) expect(p.session!.state.unanimous).toBe(true);
  });

  it('cannot join after the group is locked', async () => {
    const { net, clock, link, parties } = await runPoll(['yes', 'yes'], { size: true });
    const late = new Party('Late', net, clock);
    const s = await late.open(link);
    await s.join('Late', 'veto');
    expect(s.actionError).toMatch(/locked/);
    expect(parties[0]!.session!.state.unanimous).toBe(true);
  });
});
