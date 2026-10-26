// Plaintext message formats (the JSON inside the encrypted event content) and
// strict parsers. Parsers throw on anything unexpected.
import { isHex, type ProofJson, type RosterEntry } from '../crypto';

export const EVENT_TYPES = ['meta', 'roster', 'join', 'commit', 'reveal'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const MAX_QUESTION = 300;
export const MAX_NAME = 40;
export const MAX_GROUP = 50;

export interface MetaMsg {
  v: 1;
  question: string;
  /** expected group size, or null if open */
  size: number | null;
  /** unix seconds */
  deadline: number;
  /** unix seconds */
  created: number;
}

export interface JoinMsg {
  v: 1;
  name: string;
  X: string;
  pok: ProofJson;
}

export interface RosterMsg {
  v: 1;
  members: RosterEntry[];
}

export interface CommitMsg {
  v: 1;
  C: string;
  roster: string;
}

export interface RevealMsg {
  v: 1;
  V: string;
  pok: ProofJson;
  salt: string;
  transcript: string;
}

export interface MessageMap {
  meta: MetaMsg;
  roster: RosterMsg;
  join: JoinMsg;
  commit: CommitMsg;
  reveal: RevealMsg;
}

export class MessageError extends Error {
  override name = 'MessageError';
}

function obj(v: unknown, keys: string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new MessageError('not an object');
  const o = v as Record<string, unknown>;
  const actual = Object.keys(o).sort();
  const want = [...keys].sort();
  if (actual.length !== want.length || actual.some((k, i) => k !== want[i])) {
    throw new MessageError('unexpected fields');
  }
  if (o.v !== 1) throw new MessageError('unsupported version');
  return o;
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') throw new MessageError('expected string');
  if (v.length === 0 || v !== cleanText(v) || [...v].length > max) throw new MessageError('bad string');
  return v;
}

function int(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new MessageError('bad integer');
  return v;
}

function hex(v: unknown, bytes: number): string {
  if (!isHex(v, bytes)) throw new MessageError('bad hex');
  return v;
}

function proof(v: unknown): ProofJson {
  if (typeof v !== 'object' || v === null) throw new MessageError('bad proof');
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 2) throw new MessageError('bad proof');
  return { R: hex(o.R, 33), s: hex(o.s, 32) };
}

// Control characters, zero-width and bidi-override characters (name spoofing).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Normalises user-entered text: strips unsafe characters, collapses whitespace. */
export function cleanText(s: string): string {
  return s.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
}

const parsers: { [K in EventType]: (v: unknown) => MessageMap[K] } = {
  meta(v) {
    const o = obj(v, ['v', 'question', 'size', 'deadline', 'created']);
    const created = int(o.created, 1_600_000_000, 2 ** 40);
    const deadline = int(o.deadline, created + 60, created + 31 * 86400);
    const size = o.size === null ? null : int(o.size, 2, MAX_GROUP);
    return { v: 1, question: str(o.question, MAX_QUESTION), size, deadline, created };
  },
  join(v) {
    const o = obj(v, ['v', 'name', 'X', 'pok']);
    return { v: 1, name: str(o.name, MAX_NAME), X: hex(o.X, 33), pok: proof(o.pok) };
  },
  roster(v) {
    const o = obj(v, ['v', 'members']);
    if (!Array.isArray(o.members) || o.members.length > MAX_GROUP) throw new MessageError('bad members');
    const members = o.members.map((m: unknown) => {
      if (typeof m !== 'object' || m === null || Object.keys(m).length !== 2) throw new MessageError('bad member');
      const e = m as Record<string, unknown>;
      return { pubkey: hex(e.pubkey, 32), joinHash: hex(e.joinHash, 32) };
    });
    return { v: 1, members };
  },
  commit(v) {
    const o = obj(v, ['v', 'C', 'roster']);
    return { v: 1, C: hex(o.C, 32), roster: hex(o.roster, 32) };
  },
  reveal(v) {
    const o = obj(v, ['v', 'V', 'pok', 'salt', 'transcript']);
    return { v: 1, V: hex(o.V, 33), pok: proof(o.pok), salt: hex(o.salt, 32), transcript: hex(o.transcript, 32) };
  },
};

export function parseMessage<K extends EventType>(type: K, value: unknown): MessageMap[K] {
  return parsers[type](value);
}
