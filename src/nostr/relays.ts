import defaults from './default-relays.json';

export const DEFAULT_RELAYS: readonly string[] = defaults;
export const MAX_RELAYS = 12;

/** Normalise a relay URL; returns null unless it is a plain wss:// URL. */
export function normalizeRelay(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'wss:' || u.username || u.password || u.hash) return null;
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return `wss://${u.host}${path}${u.search}`;
}

/** Parse a user-entered relay list (newline / comma / space separated). */
export function parseRelayList(text: string): { relays: string[]; invalid: string[] } {
  const relays: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const n = normalizeRelay(part);
    if (!n) invalid.push(part);
    else if (!relays.includes(n)) relays.push(n);
  }
  return { relays: relays.slice(0, MAX_RELAYS), invalid };
}

export function isDefaultRelaySet(relays: readonly string[]): boolean {
  return relays.length === DEFAULT_RELAYS.length && relays.every((r) => DEFAULT_RELAYS.includes(r));
}
