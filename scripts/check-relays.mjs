#!/usr/bin/env node
// Verifies that relays accept and return a kind-30078 (NIP-78) event with a
// NIP-40 expiration, the way Unanimous uses them.
//   npm run check-relays                  # default relays
//   npm run check-relays -- wss://a wss://b
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';

if (typeof WebSocket === 'undefined') {
  console.error('This script needs a global WebSocket (Node >= 22, or Node 20 with --experimental-websocket).');
  process.exit(2);
}

const defaults = JSON.parse(readFileSync(new URL('../src/nostr/default-relays.json', import.meta.url), 'utf8'));
const relays = process.argv.slice(2).length ? process.argv.slice(2) : defaults;
const TIMEOUT = 10_000;

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
}

async function check(url) {
  const t0 = Date.now();
  const sk = generateSecretKey();
  const tag = randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const ev = finalizeEvent(
    {
      kind: 30078,
      created_at: now,
      tags: [
        ['d', `${tag}:join`],
        ['expiration', String(now + 3600)],
      ],
      // same shape as real content: base64(iv || AES-GCM ciphertext)
      content: randomBytes(12 + 200 + 16).toString('base64'),
    },
    sk,
  );
  let relay;
  try {
    relay = await withTimeout(Relay.connect(url), TIMEOUT, 'connect');
  } catch (e) {
    return { url, ok: false, step: 'connect', msg: String(e.message ?? e) };
  }
  const connectMs = Date.now() - t0;
  try {
    await withTimeout(relay.publish(ev), TIMEOUT, 'publish');
  } catch (e) {
    relay.close();
    return { url, ok: false, step: 'publish', msg: String(e.message ?? e), connectMs };
  }
  // Read back on a fresh connection so we know it was stored, not just echoed.
  relay.close();
  let reader;
  try {
    reader = await withTimeout(Relay.connect(url), TIMEOUT, 'reconnect');
    const got = await withTimeout(
      new Promise((resolve) => {
        const found = [];
        const sub = reader.subscribe([{ kinds: [30078], '#d': [`${tag}:join`, `${tag}:meta`] }], {
          onevent: (e) => found.push(e),
          oneose: () => {
            sub.close();
            resolve(found);
          },
        });
      }),
      TIMEOUT,
      'query',
    );
    reader.close();
    if (!got.some((e) => e.id === ev.id)) return { url, ok: false, step: 'query', msg: 'event not returned', connectMs };
    return { url, ok: true, connectMs, totalMs: Date.now() - t0 };
  } catch (e) {
    reader?.close();
    return { url, ok: false, step: 'query', msg: String(e.message ?? e), connectMs };
  }
}

const results = await Promise.all(relays.map(check));
let good = 0;
for (const r of results) {
  if (r.ok) {
    good++;
    console.log(`OK    ${r.url.padEnd(36)} connect ${r.connectMs} ms, round trip ${r.totalMs} ms`);
  } else {
    console.log(`FAIL  ${r.url.padEnd(36)} at ${r.step}: ${r.msg}`);
  }
}
console.log(`\n${good}/${results.length} relays accept and return kind-30078 events.`);
process.exit(good === results.length ? 0 : 1);
