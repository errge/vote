// Relay transport: one connection per relay, a live subscription for the poll
// filter, per-relay publish queues with OK/error tracking, and "healing"
// (re-publishing known events to relays that did not return them).
import { Relay, type Subscription } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';

export type RelayState = 'connecting' | 'open' | 'closed';

export interface RelayStatus {
  url: string;
  state: RelayState;
  /** initial fetch complete on the current subscription */
  synced: boolean;
  /** events this relay has returned or accepted */
  holds: number;
  accepted: number;
  rejected: number;
  lastError: string | null;
}

export interface PublishResult {
  url: string;
  ok: boolean;
  message: string;
}

export interface TransportHandlers {
  onEvent(ev: Event): void;
  onStatus(): void;
}

interface ConnHandlers extends TransportHandlers {
  onSynced(conn: RelayConn): void;
}

const CONNECT_TIMEOUT = 8000;
const BACKOFF = [2000, 5000, 15000, 30000, 60000];

interface Job {
  ev: Event;
  resolve: (r: PublishResult) => void;
}

class RelayConn {
  relay: Relay | null = null;
  sub: Subscription | null = null;
  status: RelayStatus;
  /** event ids this relay is known to hold */
  readonly holds = new Set<string>();
  /** event ids already offered to this relay during this sync cycle */
  private offered = new Set<string>();
  private queue: Job[] = [];
  private draining = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private generation = 0;

  constructor(
    readonly url: string,
    private readonly filter: Filter,
    private readonly seen: (id: string) => boolean,
    private readonly handlers: ConnHandlers,
  ) {
    this.status = { url, state: 'closed', synced: false, holds: 0, accepted: 0, rejected: 0, lastError: null };
  }

  private update(patch: Partial<RelayStatus>) {
    Object.assign(this.status, patch, { holds: this.holds.size });
    this.handlers.onStatus();
  }

  async connect(): Promise<void> {
    if (this.stopped || this.status.state !== 'closed') return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const gen = ++this.generation;
    this.update({ state: 'connecting', synced: false });
    const relay = new Relay(this.url, { enableReconnect: false, enablePing: false });
    try {
      await relay.connect({ timeout: CONNECT_TIMEOUT });
    } catch (e) {
      if (gen !== this.generation) return;
      this.update({ state: 'closed', lastError: errorText(e, 'connection failed') });
      this.scheduleReconnect();
      return;
    }
    if (gen !== this.generation || this.stopped) {
      relay.close();
      return;
    }
    this.relay = relay;
    this.attempts = 0;
    relay.onclose = () => {
      if (gen !== this.generation) return;
      this.relay = null;
      this.sub = null;
      this.update({ state: 'closed', synced: false });
      this.scheduleReconnect();
    };
    this.update({ state: 'open', lastError: null });
    this.subscribe();
    void this.drain();
  }

  private subscribe() {
    if (!this.relay) return;
    this.sub?.close();
    this.offered = new Set();
    this.update({ synced: false });
    this.sub = this.relay.subscribe([this.filter], {
      alreadyHaveEvent: (id) => this.seen(id),
      receivedEvent: (_relay, id) => {
        this.holds.add(id);
      },
      onevent: (ev) => this.handlers.onEvent(ev),
      oneose: () => {
        this.update({ synced: true });
        this.handlers.onSynced(this);
      },
      onclose: (reason) => {
        if (reason && !this.stopped) this.update({ lastError: `subscription closed: ${reason}` });
      },
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = BACKOFF[Math.min(this.attempts, BACKOFF.length - 1)]!;
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /**
   * Reconnect if needed and re-run the initial fetch. `hard` drops the current
   * socket first: after long backgrounding (iOS Safari) a socket can look open
   * while being dead.
   */
  refresh(hard = false) {
    if (this.stopped) return;
    if (hard && this.status.state === 'open') {
      this.generation++;
      const old = this.relay;
      this.relay = null;
      this.sub = null;
      this.status.state = 'closed';
      old?.close();
    }
    if (this.status.state === 'closed') {
      this.attempts = 0;
      void this.connect();
    } else if (this.status.state === 'open') {
      this.subscribe();
    }
  }

  publish(ev: Event, priority: boolean): Promise<PublishResult> {
    this.offered.add(ev.id);
    return new Promise((resolve) => {
      const job = { ev, resolve };
      if (priority) this.queue.unshift(job);
      else this.queue.push(job);
      void this.drain();
    });
  }

  /** Offer an event this relay does not hold (once per sync cycle). */
  heal(ev: Event) {
    if (!this.status.synced || this.holds.has(ev.id) || this.offered.has(ev.id)) return;
    void this.publish(ev, false);
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.relay && this.status.state === 'open') {
        const job = this.queue.shift()!;
        let result: PublishResult;
        try {
          const msg = await this.relay.publish(job.ev);
          this.holds.add(job.ev.id);
          result = { url: this.url, ok: true, message: msg };
          this.update({ accepted: this.status.accepted + 1 });
        } catch (e) {
          const message = errorText(e, 'rejected');
          // Allow a retry on the next sync cycle (rate limits are usually transient).
          this.offered.delete(job.ev.id);
          result = { url: this.url, ok: false, message };
          this.update({ rejected: this.status.rejected + 1, lastError: message });
          if (/rate|limit|slow down/i.test(message)) await sleep(1500);
        }
        job.resolve(result);
      }
    } finally {
      this.draining = false;
    }
    // Jobs queued while disconnected are resolved as failures right away so
    // callers are not left hanging; healing retries them after reconnecting.
    if (this.status.state !== 'open' || !this.relay) {
      for (const job of this.queue.splice(0)) {
        this.offered.delete(job.ev.id);
        job.resolve({ url: this.url, ok: false, message: 'not connected' });
      }
    }
  }

  stop() {
    this.stopped = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sub?.close();
    this.relay?.close();
    this.relay = null;
    for (const job of this.queue.splice(0)) job.resolve({ url: this.url, ok: false, message: 'stopped' });
  }
}

export class Transport {
  private readonly conns: RelayConn[];
  private readonly seenIds = new Set<string>();
  /** latest set of events worth healing, offered to each relay once it has synced */
  private healSet: Event[] = [];

  constructor(urls: string[], filter: Filter, handlers: TransportHandlers) {
    this.conns = urls.map(
      (u) =>
        new RelayConn(u, filter, (id) => this.seenIds.has(id), {
          onEvent: (ev) => {
            this.seenIds.add(ev.id);
            handlers.onEvent(ev);
          },
          onStatus: () => handlers.onStatus(),
          onSynced: (conn) => {
            for (const ev of this.healSet) conn.heal(ev);
          },
        }),
    );
  }

  start() {
    for (const c of this.conns) void c.connect();
  }

  refresh(hard = false) {
    for (const c of this.conns) c.refresh(hard);
  }

  stop() {
    for (const c of this.conns) c.stop();
  }

  status(): RelayStatus[] {
    return this.conns.map((c) => ({ ...c.status }));
  }

  /** Mark an event as known (e.g. our own events loaded from local storage). */
  markSeen(id: string) {
    this.seenIds.add(id);
  }

  /** Publish to every relay; resolves once every relay has answered (or failed). */
  publish(ev: Event): Promise<PublishResult[]> {
    this.seenIds.add(ev.id);
    return Promise.all(this.conns.map((c) => (c.holds.has(ev.id) ? ok(c.url) : c.publish(ev, true))));
  }

  /** Re-publish each event to relays that have synced but do not hold it. */
  heal(events: Event[]) {
    this.healSet = events;
    for (const ev of events) for (const c of this.conns) c.heal(ev);
  }
}

function ok(url: string): Promise<PublishResult> {
  return Promise.resolve({ url, ok: true, message: 'already stored' });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function errorText(e: unknown, fallback: string): string {
  const s = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return s.slice(0, 200) || fallback;
}
