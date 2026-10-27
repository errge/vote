import { describe, expect, it } from 'vitest';
import { randomBytes } from '../src/crypto';
import { DEFAULT_RELAYS } from '../src/nostr/relays';
import { isPollFragment, parsePollFragment, pollFragment, shareUrl } from '../src/state/link';

describe('share links', () => {
  it('default relays: just 22 characters after #', () => {
    const link = { pollSecret: randomBytes(16), relays: [...DEFAULT_RELAYS] };
    const f = pollFragment(link);
    expect(f).toMatch(/^#[A-Za-z0-9_-]{22}$/);
    expect(isPollFragment(f)).toBe(true);
    expect(parsePollFragment(f)).toEqual(link);
    expect(shareUrl(link, 'https://vote.risko.hu/#/how')).toBe(`https://vote.risko.hu/${f}`);
    expect(shareUrl(link, 'https://u.github.io/repo/index.html?x=1')).toBe(`https://u.github.io/repo/index.html${f}`);
  });

  it('custom relays round-trip', () => {
    const link = { pollSecret: randomBytes(16), relays: ['wss://a.example', 'wss://b.example/path'] };
    const f = pollFragment(link);
    expect(f).toContain('&r=');
    expect(parsePollFragment(f)).toEqual(link);
  });

  it('rejects malformed fragments; routes do not collide', () => {
    expect(parsePollFragment('#')).toBeNull();
    expect(parsePollFragment('#abc')).toBeNull();
    expect(parsePollFragment('#' + 'A'.repeat(23))).toBeNull();
    expect(parsePollFragment('#' + 'A'.repeat(21) + '!')).toBeNull();
    expect(isPollFragment('#/how')).toBe(false);
    expect(isPollFragment('')).toBe(false);
  });
});
