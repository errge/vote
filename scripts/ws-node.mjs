#!/usr/bin/env node
// Runs `node <args>` with a global WebSocket available (adds
// --experimental-websocket on Node 20, where it is not enabled by default).
import { spawnSync } from 'node:child_process';

// Via NODE_OPTIONS so that worker processes (vitest) get it as well.
const env = { ...process.env };
if (typeof WebSocket === 'undefined') {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --experimental-websocket --no-warnings`.trim();
}
const r = spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit', env });
if (r.status !== 0) console.error(`exit status ${r.status ?? r.signal}`);
process.exit(r.status ?? 1);
