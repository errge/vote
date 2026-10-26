// A complete 3-party poll through the real default relays, using the real
// Transport. Each party has its own relay connections and storage.
import { describe, expect, it } from 'vitest';
import { createPoll, PollSession, type SessionDeps } from '../../src/app/session';
import { Transport } from '../../src/nostr/transport';
import { DEFAULT_RELAYS } from '../../src/nostr/relays';
import { MemoryKV } from '../../src/state/local';
import type { Vote } from '../../src/crypto';
import type { PollState } from '../../src/state/derive';

function deps(store: MemoryKV): SessionDeps {
  return {
    store,
    now: () => Date.now(),
    createTransport: (relays, filter, h) => new Transport(relays, filter, h),
  };
}

async function until(what: string, cond: () => boolean, ms = 90_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function livePoll(votes: Vote[]): Promise<PollState[]> {
  const stores = votes.map(() => new MemoryKV());
  const link = await createPoll(
    { question: 'Live test?', size: votes.length, durationSeconds: 3600, name: 'P0', relays: [...DEFAULT_RELAYS] },
    deps(stores[0]!),
  );
  const sessions: PollSession[] = [];
  try {
    for (const [i, store] of stores.entries()) {
      const s = await PollSession.open(link, deps(store));
      sessions.push(s);
      await s.start();
      await until(`P${i} sees the poll`, () => s.state.phase !== 'loading');
      if (i === 0) await s.setVote(votes[0]!);
      else await s.join(`P${i}`, votes[i]!);
    }
    await until('everyone sees the result', () => sessions.every((s) => s.state.phase === 'result'), 120_000);
    const status = sessions[0]!.relayStatus();
    console.warn(status.map((r) => `${r.url}: ${r.state} holds=${r.holds} ok=${r.accepted} err=${r.lastError ?? '-'}`).join('\n'));
    return sessions.map((s) => s.state);
  } finally {
    for (const s of sessions) s.stop();
  }
}

describe('live relays', () => {
  it('all yes → unanimous', async () => {
    for (const st of await livePoll(['yes', 'yes', 'yes'])) expect(st.unanimous).toBe(true);
  });
  it('one veto → not unanimous', async () => {
    for (const st of await livePoll(['yes', 'veto', 'yes'])) expect(st.unanimous).toBe(false);
  });
});
