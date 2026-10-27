// Share links: #<base64url(pollSecret)>[&r=<relay>,<relay>…]
// The 16-byte poll secret is the only thing needed: it encrypts and locates the
// poll and also identifies the creator (see pollSecretFor).
import { base64urlToBytes, bytesToBase64url, POLL_SECRET_BYTES } from '../crypto';
import { DEFAULT_RELAYS, isDefaultRelaySet, normalizeRelay } from '../nostr/relays';

export interface PollLink {
  pollSecret: Uint8Array;
  relays: string[];
}

const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;

/** True if the fragment looks like a poll link (for routing). */
export function isPollFragment(fragment: string): boolean {
  return SECRET_RE.test(fragment.replace(/^#/, '').split('&')[0]!);
}

export function parsePollFragment(fragment: string): PollLink | null {
  const [p, ...rest] = fragment.replace(/^#/, '').split('&');
  if (!p || !SECRET_RE.test(p)) return null;
  let pollSecret: Uint8Array;
  try {
    pollSecret = base64urlToBytes(p);
  } catch {
    return null;
  }
  if (pollSecret.length !== POLL_SECRET_BYTES) return null;
  let relays = [...DEFAULT_RELAYS];
  const r = new URLSearchParams(rest.join('&')).get('r');
  if (r) {
    const parsed = r
      .split(',')
      .map((x) => normalizeRelay(x))
      .filter((x): x is string => !!x);
    if (parsed.length) relays = [...new Set(parsed)];
  }
  return { pollSecret, relays };
}

export function pollFragment(link: PollLink): string {
  let f = `#${bytesToBase64url(link.pollSecret)}`;
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
