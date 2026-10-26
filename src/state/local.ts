// Per-poll local secrets and our own signed events, in localStorage keyed by pollTag.
import type { Event } from 'nostr-tools/pure';
import type { ProofJson, Vote } from '../crypto';
import type { EventType } from './messages';

export interface StoredBallot {
  V: string;
  pok: ProofJson;
  salt: string;
  C: string;
}

export interface LocalPoll {
  v: 1;
  pollTag: string;
  /** share-link fragment, so the poll can be reopened from the home page */
  fragment: string;
  question: string | null;
  createdAt: number;
  /** Nostr secret key (hex) for this poll; null once wiped */
  sk: string | null;
  /** AV-net secret x_i (hex); null once wiped */
  x: string | null;
  name: string | null;
  /** selected vote; locked once `ballot` exists */
  vote: Vote | null;
  /** commit-round material needed for the reveal; null once wiped */
  ballot: StoredBallot | null;
  /** our own signed events (also used to heal relays) */
  events: Partial<Record<EventType, Event>>;
  /** creator only: pubkeys excluded from the roster */
  excluded: string[];
  /** secrets were wiped because the poll reached a final state */
  wiped: boolean;
}

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const PREFIX = 'unanimous:v1:poll:';
const NAME_KEY = 'unanimous:v1:name';

function kv(): KV | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function storageAvailable(store: KV | null = kv()): boolean {
  if (!store) return false;
  try {
    store.setItem('unanimous:v1:probe', '1');
    store.removeItem('unanimous:v1:probe');
    return true;
  } catch {
    return false;
  }
}

export function newLocalPoll(pollTag: string, fragment: string): LocalPoll {
  return {
    v: 1,
    pollTag,
    fragment,
    question: null,
    createdAt: Date.now(),
    sk: null,
    x: null,
    name: null,
    vote: null,
    ballot: null,
    events: {},
    excluded: [],
    wiped: false,
  };
}

export function loadPoll(pollTag: string, store: KV | null = kv()): LocalPoll | null {
  const raw = store?.getItem(PREFIX + pollTag);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as LocalPoll;
    return p && p.v === 1 && p.pollTag === pollTag ? p : null;
  } catch {
    return null;
  }
}

/** Throws if storage is unavailable/full: callers must not publish what they cannot remember. */
export function savePoll(p: LocalPoll, store: KV | null = kv()): void {
  if (!store) throw new Error('local storage is unavailable');
  store.setItem(PREFIX + p.pollTag, JSON.stringify(p));
}

export function deletePoll(pollTag: string, store: KV | null = kv()): void {
  store?.removeItem(PREFIX + pollTag);
}

export function listPolls(store: KV | null = kv()): LocalPoll[] {
  if (!store) return [];
  const out: LocalPoll[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    const p = loadPoll(k.slice(PREFIX.length), store);
    if (p) out.push(p);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Drop every secret once the poll is final; keep the public events and the link. */
export function wipeSecrets(p: LocalPoll): LocalPoll {
  return { ...p, sk: null, x: null, vote: null, ballot: null, wiped: true };
}

export function loadName(store: KV | null = kv()): string {
  try {
    return store?.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string, store: KV | null = kv()): void {
  try {
    store?.setItem(NAME_KEY, name);
  } catch {
    /* not critical */
  }
}

/** In-memory KV for tests. */
export class MemoryKV implements KV {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
}
