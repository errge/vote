// Poll events on Nostr: kind 30078 (NIP-78), d = "<pollTag>:<type>",
// NIP-40 expiration, AES-GCM content with AAD "pollTag|type|pubkey".
import { finalizeEvent, getPublicKey, verifyEvent, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import {
  aad,
  decryptContent,
  deriveEncKeyBytes,
  derivePollTag,
  encryptContent,
  hexToBytes,
  importEncKey,
  isHex,
} from '../crypto';
import { EVENT_TYPES, type EventType } from '../state/messages';

export const KIND = 30078;
export const EXPIRATION_GRACE = 7 * 86400;

export interface PollKeys {
  pollTag: string;
  pollTagBytes: Uint8Array;
  encKey: CryptoKey;
  /** creator pubkey from the share link; authenticates meta and roster */
  creator: string;
}

export async function derivePollKeys(pollSecret: Uint8Array, creator: string): Promise<PollKeys> {
  const pollTag = derivePollTag(pollSecret);
  return {
    pollTag,
    pollTagBytes: hexToBytes(pollTag),
    encKey: await importEncKey(deriveEncKeyBytes(pollSecret)),
    creator,
  };
}

export function dTag(pollTag: string, type: EventType): string {
  return `${pollTag}:${type}`;
}

export function pollFilter(pollTag: string) {
  return { kinds: [KIND], '#d': EVENT_TYPES.map((t) => dTag(pollTag, t)) };
}

export async function sealEvent(
  keys: PollKeys,
  type: EventType,
  payload: object,
  secretKey: Uint8Array,
  deadline: number,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<VerifiedEvent> {
  const pubkey = getPublicKey(secretKey);
  const content = await encryptContent(keys.encKey, JSON.stringify(payload), aad(keys.pollTag, type, pubkey));
  return finalizeEvent(
    {
      kind: KIND,
      created_at: createdAt,
      tags: [
        ['d', dTag(keys.pollTag, type)],
        ['expiration', String(deadline + EXPIRATION_GRACE)],
      ],
      content,
    },
    secretKey,
  );
}

export interface OpenedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  type: EventType;
  /** decrypted, JSON-parsed (not yet schema-validated) content */
  payload: unknown;
  raw: Event;
}

/** Event type from the d tag, or null if the event does not belong to this poll. */
export function eventType(pollTag: string, ev: Event): EventType | null {
  if (ev.kind !== KIND) return null;
  const d = ev.tags.find((t) => t[0] === 'd')?.[1];
  if (!d || !d.startsWith(pollTag + ':')) return null;
  const type = d.slice(pollTag.length + 1);
  return (EVENT_TYPES as readonly string[]).includes(type) ? (type as EventType) : null;
}

/** Verify signature, decrypt and JSON-parse. Returns null for anything invalid. */
export async function openEvent(keys: PollKeys, ev: Event): Promise<OpenedEvent | null> {
  const type = eventType(keys.pollTag, ev);
  if (!type || !isHex(ev.pubkey, 32)) return null;
  if (!verifyEvent(ev)) return null;
  try {
    const pt = await decryptContent(keys.encKey, ev.content, aad(keys.pollTag, type, ev.pubkey));
    return { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, type, payload: JSON.parse(pt), raw: ev };
  } catch {
    return null;
  }
}
