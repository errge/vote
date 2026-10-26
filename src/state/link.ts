// Share links: #p=<base64url(pollSecret)>&c=<creatorPubkeyHex>[&r=<relays>]
import { base64urlToBytes, bytesToBase64url, isHex, POLL_SECRET_BYTES } from '../crypto';
import { DEFAULT_RELAYS, isDefaultRelaySet, normalizeRelay } from '../nostr/relays';

export interface PollLink {
  pollSecret: Uint8Array;
  creator: string;
  relays: string[];
}

export function parsePollFragment(fragment: string): PollLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const p = params.get('p');
  const c = params.get('c');
  if (!p || !c || !isHex(c, 32)) return null;
  let pollSecret: Uint8Array;
  try {
    pollSecret = base64urlToBytes(p);
  } catch {
    return null;
  }
  if (pollSecret.length !== POLL_SECRET_BYTES) return null;
  let relays = [...DEFAULT_RELAYS];
  const r = params.get('r');
  if (r) {
    const parsed = r
      .split(',')
      .map((x) => normalizeRelay(x))
      .filter((x): x is string => !!x);
    if (parsed.length) relays = [...new Set(parsed)];
  }
  return { pollSecret, creator: c, relays };
}

export function pollFragment(link: PollLink): string {
  let f = `#p=${bytesToBase64url(link.pollSecret)}&c=${link.creator}`;
  if (!isDefaultRelaySet(link.relays)) f += `&r=${link.relays.map(encodeURIComponent).join(',')}`;
  return f;
}

/** Absolute share URL for the current deployment (works under any subpath). */
export function shareUrl(link: PollLink, base: string = location.href): string {
  const u = new URL(base);
  u.hash = '';
  u.search = '';
  return u.toString().replace(/#$/, '') + pollFragment(link);
}
