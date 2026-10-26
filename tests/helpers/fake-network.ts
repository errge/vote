// In-memory relay network with NIP-01 addressable-event semantics, used to run
// whole polls through real PollSession instances.
import type { Event } from 'nostr-tools/pure';
import { createPoll, PollSession, type CreateParams, type SessionDeps, type TransportLike } from '../../src/app/session';
import type { PublishResult, RelayStatus, TransportHandlers } from '../../src/nostr/transport';
import type { PollLink } from '../../src/state/link';
import { MemoryKV } from '../../src/state/local';
import type { Vote } from '../../src/crypto';

type Filter = { kinds: number[]; '#d': string[] };

function matches(f: Filter, ev: Event) {
  const d = ev.tags.find((t) => t[0] === 'd')?.[1];
  return f.kinds.includes(ev.kind) && !!d && f['#d'].includes(d);
}

function addrKey(ev: Event) {
  return `${ev.kind}:${ev.pubkey}:${ev.tags.find((t) => t[0] === 'd')?.[1]}`;
}

interface Sub {
  url: string;
  filter: Filter;
  deliver: (ev: Event) => void;
}

export class FakeNetwork {
  readonly stores = new Map<string, Map<string, Event>>();
  private subs = new Set<Sub>();
  /** relays that reject every write */
  readonly rejecting = new Set<string>();
  /** relays that are unreachable */
  readonly down = new Set<string>();

  constructor(readonly urls: string[]) {
    for (const u of urls) this.stores.set(u, new Map());
  }

  publish(url: string, ev: Event): PublishResult {
    if (this.down.has(url)) return { url, ok: false, message: 'not connected' };
    if (this.rejecting.has(url)) return { url, ok: false, message: 'rate-limited: slow down' };
    const store = this.stores.get(url)!;
    const k = addrKey(ev);
    const cur = store.get(k);
    if (cur && (cur.created_at > ev.created_at || (cur.created_at === ev.created_at && cur.id <= ev.id))) {
      return { url, ok: cur.id === ev.id, message: cur.id === ev.id ? 'duplicate:' : 'replaced: have newer event' };
    }
    store.set(k, ev);
    for (const s of this.subs) if (s.url === url && matches(s.filter, ev)) setTimeout(() => s.deliver(ev), 0);
    return { url, ok: true, message: '' };
  }

  has(url: string, id: string) {
    return [...this.stores.get(url)!.values()].some((e) => e.id === id);
  }

  /** Simulate a relay that dropped an event. */
  drop(url: string, id: string) {
    const store = this.stores.get(url)!;
    for (const [k, e] of store) if (e.id === id) store.delete(k);
  }

  subscribe(s: Sub): () => void {
    this.subs.add(s);
    if (!this.down.has(s.url)) {
      for (const ev of this.stores.get(s.url)!.values()) if (matches(s.filter, ev)) setTimeout(() => s.deliver(ev), 0);
    }
    return () => this.subs.delete(s);
  }

  transport(urls: string[], filter: Filter, h: TransportHandlers): TransportLike {
    let unsubs: (() => void)[] = [];
    const start = () => {
      unsubs.forEach((u) => u());
      unsubs = urls.map((url) => this.subscribe({ url, filter, deliver: (ev) => h.onEvent(ev) }));
    };
    return {
      start,
      refresh: start,
      stop: () => unsubs.forEach((u) => u()),
      publish: async (ev) => urls.map((u) => this.publish(u, ev)),
      heal: (evs) => {
        for (const ev of evs) for (const u of urls) if (!this.down.has(u) && !this.has(u, ev.id)) this.publish(u, ev);
      },
      markSeen: () => {},
      status: (): RelayStatus[] => [],
    };
  }
}

export class Clock {
  constructor(public t = 1_800_000_000_000) {}
  now = () => this.t;
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
}

export class Party {
  readonly store = new MemoryKV();
  session: PollSession | null = null;

  constructor(
    readonly name: string,
    readonly net: FakeNetwork,
    readonly clock: Clock,
  ) {}

  deps(): SessionDeps {
    return {
      store: this.store,
      now: this.clock.now,
      createTransport: (relays, filter, h) => this.net.transport(relays, filter, h),
    };
  }

  async create(p: Partial<CreateParams> = {}): Promise<PollLink> {
    return createPoll(
      { question: 'Dinner together tonight?', size: null, durationSeconds: 86400, name: this.name, relays: this.net.urls, ...p },
      this.deps(),
    );
  }

  async open(link: PollLink): Promise<PollSession> {
    this.session = await PollSession.open(link, this.deps());
    await this.session.start();
    await new Promise((r) => setTimeout(r, 10)); // initial relay delivery
    await this.session.whenIdle();
    return this.session;
  }

  /** Close the page. */
  close() {
    this.session?.stop();
    this.session = null;
  }

  async join(link: PollLink, vote: Vote | null) {
    const s = await this.open(link);
    await s.join(this.name, vote);
    await s.whenIdle();
    return s;
  }
}

/** Let every open session process everything until the network is quiet. */
export async function settle(parties: Party[]) {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 40));
    for (const p of parties) await p.session?.whenIdle();
  }
}
