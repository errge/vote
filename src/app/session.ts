// A poll session: owns the event set, derives state, persists local secrets and
// performs the automatic protocol steps (auto-lock, commit, reveal, wipe).
// UI-independent so that whole polls can be simulated in tests.
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import {
  bytesToHex,
  castBallot,
  hexToBytes,
  makeJoinKey,
  pointToHex,
  proofToJson,
  randomBytes,
  scalarFromHex,
  scalarToHex,
  sortRoster,
  type Vote,
} from '../crypto';
import { derivePollKeys, openEvent, pollFilter, sealEvent, type OpenedEvent, type PollKeys } from '../nostr/codec';
import type { PublishResult, RelayStatus, TransportHandlers } from '../nostr/transport';
import { derivePoll, type Member, type PollState } from '../state/derive';
import { pollFragment, type PollLink } from '../state/link';
import {
  loadPoll,
  newLocalPoll,
  savePoll,
  wipeSecrets,
  type KV,
  type LocalPoll,
} from '../state/local';
import { cleanText, MAX_GROUP, type EventType, type MetaMsg } from '../state/messages';

export interface TransportLike {
  start(): void;
  stop(): void;
  refresh(hard?: boolean): void;
  publish(ev: Event): Promise<PublishResult[]>;
  heal(events: Event[]): void;
  markSeen(id: string): void;
  status(): RelayStatus[];
}

export interface SessionDeps {
  store: KV | null;
  /** milliseconds */
  now(): number;
  createTransport(relays: string[], filter: ReturnType<typeof pollFilter>, h: TransportHandlers): TransportLike;
  /** cross-tab mutual exclusion (Web Locks); defaults to in-process only */
  lock?<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface PublishLog {
  type: EventType;
  at: number;
  results: PublishResult[] | null;
}

const FINAL_PHASES = new Set(['result', 'aborted', 'incomplete']);
/** Do not start a protocol step this close to the deadline (clock skew margin). */
const DEADLINE_MARGIN = 5;

export interface CreateParams {
  question: string;
  size: number | null;
  durationSeconds: number;
  name: string;
  relays: string[];
}

/** Create a new poll: creator key, META and the creator's own JOIN. Returns the link. */
export async function createPoll(p: CreateParams, deps: Pick<SessionDeps, 'store' | 'now'>): Promise<PollLink> {
  const question = cleanText(p.question);
  const name = cleanText(p.name);
  if (!question || !name) throw new Error('question and name are required');
  if (p.size !== null && (!Number.isInteger(p.size) || p.size < 2 || p.size > MAX_GROUP)) {
    throw new Error('invalid group size');
  }
  const pollSecret = randomBytes(32);
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const link: PollLink = { pollSecret, creator: pubkey, relays: p.relays };
  const keys = await derivePollKeys(pollSecret, pubkey);
  const created = Math.floor(deps.now() / 1000);
  const meta: MetaMsg = { v: 1, question, size: p.size, deadline: created + p.durationSeconds, created };
  const metaEv = await sealEvent(keys, 'meta', meta, sk, meta.deadline, created);
  const { x, X, pok } = makeJoinKey(keys.pollTagBytes, pubkey);
  const joinEv = await sealEvent(
    keys,
    'join',
    { v: 1, name, X: pointToHex(X), pok: proofToJson(pok) },
    sk,
    meta.deadline,
    created,
  );
  const local: LocalPoll = {
    ...newLocalPoll(keys.pollTag, pollFragment(link)),
    question,
    createdAt: deps.now(),
    sk: bytesToHex(sk),
    x: scalarToHex(x),
    name,
    events: { meta: metaEv, join: joinEv },
  };
  savePoll(local, deps.store);
  return link;
}

export class PollSession {
  readonly events = new Map<string, OpenedEvent>();
  state: PollState;
  local: LocalPoll | null;
  publishLog: PublishLog[] = [];
  /** last local action error (storage full, …) */
  actionError: string | null = null;
  private transport: TransportLike | null = null;
  private listeners = new Set<() => void>();
  private pendingOpens = 0;
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  private constructor(
    readonly link: PollLink,
    readonly keys: PollKeys,
    private readonly deps: SessionDeps,
  ) {
    this.local = loadPoll(keys.pollTag, deps.store);
    this.state = this.derive();
  }

  static async open(link: PollLink, deps: SessionDeps): Promise<PollSession> {
    return new PollSession(link, await derivePollKeys(link.pollSecret, link.creator), deps);
  }

  get pollTag() {
    return this.keys.pollTag;
  }

  get myPubkey(): string | null {
    const ev = this.local?.events.join;
    return ev ? ev.pubkey : this.local?.sk ? getPublicKey(hexToBytes(this.local.sk)) : null;
  }

  get isCreator(): boolean {
    return this.myPubkey === this.link.creator;
  }

  get me(): Member | null {
    const pk = this.myPubkey;
    return this.state.roster?.members.find((m) => m.pubkey === pk) ?? null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  relayStatus(): RelayStatus[] {
    return this.transport?.status() ?? [];
  }

  async start() {
    for (const ev of Object.values(this.local?.events ?? {})) {
      if (ev) await this.addRaw(ev, true);
    }
    this.transport = this.deps.createTransport(this.link.relays, pollFilter(this.pollTag), {
      onEvent: (ev) => void this.addRaw(ev, false),
      onStatus: () => this.emit(),
    });
    for (const id of this.events.keys()) this.transport.markSeen(id);
    this.transport.start();
    this.tickTimer = setInterval(() => this.recompute(), 15_000);
    this.recompute();
  }

  stop() {
    this.stopped = true;
    this.transport?.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
    this.listeners.clear();
  }

  /** Reconnect and refetch (page became visible again, network came back, …). */
  refresh(hard = false) {
    this.reloadLocal();
    this.transport?.refresh(hard);
    this.recompute();
  }

  /** Re-read local storage (another tab may have changed it). */
  reloadLocal() {
    this.local = loadPoll(this.pollTag, this.deps.store);
  }

  /** Resolves once all received events are processed and queued actions have run. */
  async whenIdle(): Promise<void> {
    for (;;) {
      if (this.pendingOpens === 0 && !this.recomputeTimer) {
        const c = this.chain;
        await c;
        if (c === this.chain && this.pendingOpens === 0 && !this.recomputeTimer) return;
      } else {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  }

  private async addRaw(ev: Event, own: boolean) {
    if (this.events.has(ev.id)) return;
    this.pendingOpens++;
    try {
      const opened = await openEvent(this.keys, ev);
      if (opened && !this.events.has(ev.id)) {
        this.events.set(ev.id, opened);
        if (!own) this.scheduleRecompute();
      }
    } finally {
      this.pendingOpens--;
    }
  }

  private scheduleRecompute() {
    if (this.recomputeTimer || this.stopped) return;
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      this.recompute();
    }, 30);
  }

  private derive(): PollState {
    return derivePoll(
      this.keys.pollTagBytes,
      this.link.creator,
      this.events.values(),
      Math.floor(this.deps.now() / 1000),
    );
  }

  recompute() {
    if (this.stopped) return;
    this.state = this.derive();
    if (this.local && this.state.meta && this.local.question !== this.state.meta.question) {
      this.local = { ...this.local, question: this.state.meta.question };
      this.persist(this.local);
    }
    const heal = this.state.healIds.map((id) => this.events.get(id)?.raw).filter((e): e is Event => !!e);
    this.transport?.heal(heal);
    this.emit();
    this.enqueue(() => this.automate());
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn).catch((e: unknown) => {
      this.actionError = e instanceof Error ? e.message : String(e);
      this.emit();
    });
    this.chain = run;
    return run;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.lock ? this.deps.lock(`unanimous:${this.pollTag}`, fn) : fn();
  }

  private persist(p: LocalPoll) {
    savePoll(p, this.deps.store);
    this.local = p;
  }

  private async publishOwn(type: EventType, ev: Event) {
    await this.addRaw(ev, true);
    this.transport?.markSeen(ev.id);
    const entry: PublishLog = { type, at: this.deps.now(), results: null };
    this.publishLog = [entry, ...this.publishLog].slice(0, 10);
    this.recompute();
    // Not awaited: the event is persisted already, and slow relays must not hold up the next step.
    void this.transport?.publish(ev).then((results) => {
      entry.results = results;
      this.emit();
    });
  }

  private nowS() {
    return Math.floor(this.deps.now() / 1000);
  }

  private beforeDeadline(): boolean {
    const m = this.state.meta;
    return !!m && this.nowS() < m.deadline - DEADLINE_MARGIN;
  }

  // ---- automatic protocol steps --------------------------------------------------

  private async automate() {
    const s = this.state;
    if (!s.meta || this.stopped) return;
    if (FINAL_PHASES.has(s.phase)) {
      if (this.local && !this.local.wiped) {
        await this.withLock(async () => {
          this.reloadLocal();
          if (this.local && !this.local.wiped) this.persist(wipeSecrets(this.local));
        });
        this.emit();
      }
      return;
    }
    if (!this.beforeDeadline()) return;
    if (s.phase === 'joining' && this.isCreator && s.meta.size !== null) {
      if (this.lockCandidates().length >= s.meta.size) await this.lock();
    } else if (s.phase === 'committing') {
      await this.maybeCommit();
    } else if (s.phase === 'revealing') {
      await this.maybeReveal();
    }
  }

  private async maybeCommit() {
    await this.withLock(async () => {
      this.reloadLocal();
      const L = this.local;
      const me = this.me;
      const rosterHash = this.state.roster?.hash;
      if (!L || L.ballot || L.events.commit || !L.vote || !L.x || !L.sk || !me?.Y || !rosterHash) return;
      if (me.commit) return; // already on relays (e.g. from another tab)
      const sk = hexToBytes(L.sk);
      const b = castBallot(this.keys.pollTagBytes, me.pubkey, scalarFromHex(L.x), me.Y, L.vote, randomBytes(32));
      const ev = await sealEvent(this.keys, 'commit', { v: 1, C: b.commitment, roster: rosterHash }, sk, this.state.meta!.deadline);
      // Persist before publishing: we must never produce a second, different commitment.
      this.persist({
        ...L,
        ballot: { V: pointToHex(b.V), pok: proofToJson(b.pok), salt: bytesToHex(b.salt), C: b.commitment },
        events: { ...L.events, commit: ev },
      });
      await this.publishOwn('commit', ev);
    });
  }

  private async maybeReveal() {
    await this.withLock(async () => {
      this.reloadLocal();
      const L = this.local;
      const me = this.me;
      const transcript = this.state.transcript;
      if (!L || !L.ballot || L.events.reveal || !L.sk || !me?.commit || !transcript) return;
      if (me.commit.C !== L.ballot.C) {
        throw new Error('The commitment stored on the relays differs from the one on this device; not revealing.');
      }
      const ev = await sealEvent(
        this.keys,
        'reveal',
        { v: 1, V: L.ballot.V, pok: L.ballot.pok, salt: L.ballot.salt, transcript },
        hexToBytes(L.sk),
        this.state.meta!.deadline,
      );
      this.persist({ ...L, events: { ...L.events, reveal: ev } });
      await this.publishOwn('reveal', ev);
    });
  }

  // ---- user actions --------------------------------------------------------------

  /** Join this poll from this device. */
  join(name: string, vote: Vote | null): Promise<void> {
    return this.enqueue(() =>
      this.withLock(async () => {
        this.reloadLocal();
        if (this.local?.events.join) return;
        const meta = this.state.meta;
        if (!meta) throw new Error('The poll has not loaded yet.');
        if (this.state.roster) throw new Error('The group is already locked.');
        if (!this.beforeDeadline()) throw new Error('The deadline has passed.');
        const clean = cleanText(name);
        if (!clean) throw new Error('Please enter a name.');
        const sk = generateSecretKey();
        const pubkey = getPublicKey(sk);
        const { x, X, pok } = makeJoinKey(this.keys.pollTagBytes, pubkey);
        const ev = await sealEvent(
          this.keys,
          'join',
          { v: 1, name: clean, X: pointToHex(X), pok: proofToJson(pok) },
          sk,
          meta.deadline,
        );
        this.persist({
          ...(this.local ?? newLocalPoll(this.pollTag, pollFragment(this.link))),
          question: meta.question,
          sk: bytesToHex(sk),
          x: scalarToHex(x),
          name: clean,
          vote,
          events: { join: ev },
        });
        await this.publishOwn('join', ev);
      }),
    );
  }

  /** Select / change the vote. Once the group is locked this triggers the (final) commit. */
  setVote(vote: Vote | null): Promise<void> {
    return this.enqueue(() =>
      this.withLock(async () => {
        this.reloadLocal();
        const L = this.local;
        if (!L || L.ballot || L.wiped) return;
        this.persist({ ...L, vote });
        this.emit();
      }).then(() => this.automate()),
    );
  }

  /** Valid joiners that would be included when locking now. */
  lockCandidates() {
    const excluded = new Set(this.local?.excluded ?? []);
    excluded.delete(this.link.creator);
    return this.state.joiners.filter((j) => !excluded.has(j.pubkey));
  }

  setExcluded(pubkey: string, exclude: boolean): void {
    const L = this.local;
    if (!L || pubkey === this.link.creator) return;
    const set = new Set(L.excluded);
    if (exclude) set.add(pubkey);
    else set.delete(pubkey);
    this.persist({ ...L, excluded: [...set] });
    this.recompute();
  }

  /** Creator: publish the roster. */
  lock(): Promise<void> {
    const run = async () => {
      this.reloadLocal();
      const L = this.local;
      if (!this.isCreator || !L?.sk || L.events.roster || this.state.roster || !this.state.meta) return;
      if (!this.beforeDeadline()) throw new Error('The deadline has passed.');
      const members = this.lockCandidates();
      if (!members.some((m) => m.pubkey === this.link.creator)) throw new Error('Your own join is missing.');
      if (members.length < 2) throw new Error('At least 2 participants are needed.');
      if (members.length > MAX_GROUP) throw new Error(`At most ${MAX_GROUP} participants are supported.`);
      const entries = sortRoster(members.map((m) => ({ pubkey: m.pubkey, joinHash: m.joinHash })));
      const ev = await sealEvent(
        this.keys,
        'roster',
        { v: 1, members: entries },
        hexToBytes(L.sk),
        this.state.meta.deadline,
      );
      this.persist({ ...L, events: { ...L.events, roster: ev } });
      await this.publishOwn('roster', ev);
    };
    return this.withLock(run);
  }

  /** User-facing wrapper of lock() that reports errors through actionError. */
  requestLock(): Promise<void> {
    return this.enqueue(() => this.lock());
  }
}
