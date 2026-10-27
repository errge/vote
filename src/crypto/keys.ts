// Poll-level key derivation and AES-GCM content encryption (WebCrypto).
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  concatBytes,
  CryptoError,
  equalBytes,
  hexToBytes,
  randomBytes,
  utf8,
} from './bytes';
import { DOMAIN, hashTagged } from './hash';

/** 128-bit poll secret: 22 base64url characters in the share link. */
export const POLL_SECRET_BYTES = 16;
export const CREATOR_SALT_BYTES = 32;

/**
 * The poll secret doubles as a commitment to the creator's pubkey:
 * pollSecret = H("unanimous/v1/poll" || creatorPubkey || salt)[0..16], where the
 * random salt travels inside the encrypted META. Anyone holding the link can check
 * which pubkey is the creator, and forging another one is a 128-bit second preimage.
 */
export function pollSecretFor(creatorPubkey: string, salt: Uint8Array): Uint8Array {
  if (salt.length !== CREATOR_SALT_BYTES) throw new CryptoError('creator salt must be 32 bytes');
  return hashTagged('poll', hexToBytes(creatorPubkey, 32), salt).slice(0, POLL_SECRET_BYTES);
}

export function isCreatorBinding(pollSecret: Uint8Array, pubkey: string, saltHex: unknown): boolean {
  if (typeof saltHex !== 'string' || !/^[0-9a-f]{64}$/.test(saltHex) || !/^[0-9a-f]{64}$/.test(pubkey)) return false;
  return equalBytes(pollSecretFor(pubkey, hexToBytes(saltHex)), pollSecret);
}

/** pollTag = first 16 bytes (32 hex chars) of H("unanimous/v1/tag" || pollSecret). */
export function derivePollTag(pollSecret: Uint8Array): string {
  if (pollSecret.length !== POLL_SECRET_BYTES) throw new CryptoError('poll secret must be 16 bytes');
  return bytesToHex(hashTagged('tag', pollSecret)).slice(0, 32);
}

/** encKey = HKDF-SHA256(ikm = pollSecret, salt = none, info = "unanimous/v1/enc", 32 bytes). */
export function deriveEncKeyBytes(pollSecret: Uint8Array): Uint8Array {
  if (pollSecret.length !== POLL_SECRET_BYTES) throw new CryptoError('poll secret must be 16 bytes');
  return hkdf(sha256, pollSecret, undefined, utf8(DOMAIN + 'enc'), 32);
}

export function importEncKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export function aad(pollTag: string, type: string, pubkey: string): Uint8Array {
  return utf8(`${pollTag}|${type}|${pubkey}`);
}

/** Returns base64(iv || ciphertext+tag) with a random 12-byte IV. */
export async function encryptContent(key: CryptoKey, plaintext: string, additionalData: Uint8Array): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: additionalData as BufferSource },
      key,
      utf8(plaintext) as BufferSource,
    ),
  );
  return bytesToBase64(concatBytes(iv, ct));
}

export async function decryptContent(key: CryptoKey, content: string, additionalData: Uint8Array): Promise<string> {
  const raw = base64ToBytes(content);
  if (raw.length < 12 + 16) throw new CryptoError('ciphertext too short');
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: additionalData as BufferSource },
      key,
      raw.slice(12),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(pt);
  } catch {
    throw new CryptoError('decryption failed');
  }
}
