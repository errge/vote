// Deterministic derivation of the whole poll state from a set of decrypted,
// signature-checked events. Pure: no I/O, no clock (the caller passes `now`).
import {
  commitmentMatches,
  computeYs,
  hexToBytes,
  isCanonicalRoster,
  isUnanimous,
  joinHash,
  pointFromHex,
  proofFromJson,
  rosterHash,
  transcriptHash,
  verifyJoinProof,
  verifyRevealProof,
  type Point,
} from '../crypto';
import {
  MAX_GROUP,
  parseMessage,
  type CommitMsg,
  type EventType,
  type MessageMap,
  type MetaMsg,
} from './messages';

export interface PollEvent {
  id: string;
  pubkey: string;
  created_at: number;
  type: EventType;
  /** decrypted JSON content, not yet validated */
  payload: unknown;
}

export type Phase = 'loading' | 'joining' | 'committing' | 'revealing' | 'result' | 'incomplete' | 'aborted';

export interface Joiner {
  pubkey: string;
  name: string;
  /** name, disambiguated with a pubkey prefix when two joiners share a name */
  label: string;
  X: Point;
  joinHash: string;
  joinedAt: number;
}

export interface Member {
  index: number;
  pubkey: string;
  label: string;
  join: Joiner | null;
  Y: Point | null;
  commit: CommitMsg | null;
  /** true once the reveal has been fully verified */
  revealed: boolean;
}

export interface Abort {
  reason: string;
  pubkey?: string;
  label?: string;
}

export interface PollState {
  phase: Phase;
  meta: MetaMsg | null;
  /** valid JOINs, in join order */
  joiners: Joiner[];
  roster: { hash: string; members: Member[] } | null;
  transcript: string | null;
  unanimous: boolean | null;
  abort: Abort | null;
  progress: { joined: number; committed: number; revealed: number; total: number };
  waiting: { join: string[]; commit: string[]; reveal: string[] };
  /** ids of the current valid poll events, to be re-published to relays that lack them */
  healIds: string[];
}

/** NIP-01 replaceable semantics: newest created_at wins, ties go to the lowest id. */
function newer(a: PollEvent, b: PollEvent): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

function latestByKey(events: Iterable<PollEvent>): Map<string, PollEvent> {
  const m = new Map<string, PollEvent>();
  for (const e of events) {
    const k = `${e.type}:${e.pubkey}`;
    const cur = m.get(k);
    if (!cur || newer(e, cur)) m.set(k, e);
  }
  return m;
}

function tryParse<K extends EventType>(type: K, ev: PollEvent | undefined): MessageMap[K] | null | undefined {
  if (!ev) return undefined;
  try {
    return parseMessage(type, ev.payload);
  } catch {
    return null;
  }
}

export function shortKey(pubkey: string): string {
  return pubkey.slice(0, 6) + '…';
}

function emptyState(phase: Phase, meta: MetaMsg | null): PollState {
  return {
    phase,
    meta,
    joiners: [],
    roster: null,
    transcript: null,
    unanimous: null,
    abort: null,
    progress: { joined: 0, committed: 0, revealed: 0, total: meta?.size ?? 0 },
    waiting: { join: [], commit: [], reveal: [] },
    healIds: [],
  };
}

export function derivePoll(
  pollTag: Uint8Array,
  creator: string,
  events: Iterable<PollEvent>,
  now: number,
): PollState {
  const all = [...events];
  const metaEv = latestByKey(all.filter((e) => e.type === 'meta' && e.pubkey === creator)).get(`meta:${creator}`);
  const meta = tryParse('meta', metaEv);
  if (meta === undefined) return emptyState('loading', null);
  if (meta === null) {
    const s = emptyState('aborted', null);
    s.abort = { reason: 'The poll description published by the creator is invalid.' };
    return s;
  }

  // Events dated after the deadline do not count.
  const latest = latestByKey(all.filter((e) => e.created_at <= meta.deadline));
  const st = emptyState('joining', meta);
  st.healIds.push(metaEv!.id);
  const fail = (reason: string, pubkey?: string, label?: string): PollState => {
    st.phase = 'aborted';
    st.abort = { reason, pubkey, label };
    return st;
  };

  // ---- JOINs ----------------------------------------------------------------
  const joinErrors = new Map<string, string>();
  const joinsByKey = new Map<string, Joiner>();
  for (const ev of latest.values()) {
    if (ev.type !== 'join') continue;
    const msg = tryParse('join', ev);
    try {
      if (!msg) throw new Error('malformed');
      const X = pointFromHex(msg.X);
      const pok = proofFromJson(msg.pok);
      if (!verifyJoinProof(pollTag, ev.pubkey, X, pok)) throw new Error('bad proof');
      joinsByKey.set(ev.pubkey, {
        pubkey: ev.pubkey,
        name: msg.name,
        label: msg.name,
        X,
        joinHash: joinHash(pollTag, ev.pubkey, msg.name, X, pok),
        joinedAt: ev.created_at,
      });
      st.healIds.push(ev.id);
    } catch {
      joinErrors.set(ev.pubkey, msg ? msg.name : shortKey(ev.pubkey));
    }
  }
  st.joiners = [...joinsByKey.values()].sort((a, b) =>
    a.joinedAt !== b.joinedAt ? a.joinedAt - b.joinedAt : a.pubkey < b.pubkey ? -1 : 1,
  );
  const nameCount = new Map<string, number>();
  for (const j of st.joiners) nameCount.set(j.name, (nameCount.get(j.name) ?? 0) + 1);
  for (const j of st.joiners) if (nameCount.get(j.name)! > 1) j.label = `${j.name} (${shortKey(j.pubkey)})`;
  const labelOf = (pk: string) => joinsByKey.get(pk)?.label ?? joinErrors.get(pk) ?? `unknown (${shortKey(pk)})`;

  // ---- ROSTER ---------------------------------------------------------------
  const rosterEv = latest.get(`roster:${creator}`);
  const roster = tryParse('roster', rosterEv);
  if (roster === undefined) {
    st.progress.joined = st.joiners.length;
    st.progress.total = Math.max(meta.size ?? 0, st.joiners.length);
    if (now > meta.deadline) st.phase = 'incomplete';
    return st;
  }
  st.healIds.push(rosterEv!.id);
  if (roster === null) return fail('The group list published by the creator is malformed.');
  const entries = roster.members;
  if (entries.length < 2 || entries.length > MAX_GROUP) return fail('The group list has an invalid size.');
  if (!isCanonicalRoster(entries)) return fail('The group list is not canonically ordered or has duplicates.');
  if (!entries.some((e) => e.pubkey === creator)) return fail('The group list does not include the creator.');
  const rHash = rosterHash(pollTag, entries);

  const members: Member[] = entries.map((e, index) => ({
    index,
    pubkey: e.pubkey,
    label: labelOf(e.pubkey),
    join: null,
    Y: null,
    commit: null,
    revealed: false,
  }));
  st.roster = { hash: rHash, members };
  st.progress.total = members.length;

  for (const [i, m] of members.entries()) {
    if (joinErrors.has(m.pubkey)) return fail(`${m.label} has an invalid join message.`, m.pubkey, m.label);
    const j = joinsByKey.get(m.pubkey);
    if (!j) continue;
    if (j.joinHash !== entries[i]!.joinHash) {
      return fail(`${m.label}'s join message does not match the locked group list.`, m.pubkey, m.label);
    }
    m.join = j;
  }
  const seenX = new Set<string>();
  for (const m of members) {
    if (!m.join) continue;
    const xh = m.join.X.toHex(true);
    if (seenX.has(xh)) return fail(`${m.label} reused another member's key.`, m.pubkey, m.label);
    seenX.add(xh);
  }
  if (members.every((m) => m.join)) {
    let Ys: Point[];
    try {
      Ys = computeYs(members.map((m) => m.join!.X));
    } catch {
      return fail('The group keys combine to a degenerate value (identity Y).');
    }
    members.forEach((m, i) => (m.Y = Ys[i]!));
  }

  // ---- COMMITs --------------------------------------------------------------
  for (const m of members) {
    const ev = latest.get(`commit:${m.pubkey}`);
    const c = tryParse('commit', ev);
    if (c === undefined) continue;
    st.healIds.push(ev!.id);
    if (c === null) return fail(`${m.label} published a malformed vote commitment.`, m.pubkey, m.label);
    if (c.roster !== rHash) {
      return fail(`${m.label} committed to a different group list.`, m.pubkey, m.label);
    }
    m.commit = c;
  }
  const allCommitted = members.every((m) => m.commit);
  if (allCommitted) st.transcript = transcriptHash(rHash, members.map((m) => m.commit!.C));

  // ---- REVEALs --------------------------------------------------------------
  const Vs: Point[] = [];
  for (const m of members) {
    const ev = latest.get(`reveal:${m.pubkey}`);
    const r = tryParse('reveal', ev);
    if (r === undefined) continue;
    st.healIds.push(ev!.id);
    if (r === null) return fail(`${m.label} published a malformed reveal.`, m.pubkey, m.label);
    // Can only be checked once we know their commitment, Y_i and the full transcript.
    if (!m.commit || !m.Y || !st.transcript) continue;
    let V: Point;
    let ok: boolean;
    try {
      V = pointFromHex(r.V);
      const pok = proofFromJson(r.pok);
      if (!commitmentMatches(pollTag, m.pubkey, V, pok, hexToBytes(r.salt), m.commit.C)) {
        return fail(`${m.label}'s reveal does not match their commitment.`, m.pubkey, m.label);
      }
      ok = verifyRevealProof(pollTag, m.pubkey, m.Y, V, pok);
    } catch {
      return fail(`${m.label} published an invalid reveal.`, m.pubkey, m.label);
    }
    if (!ok) return fail(`${m.label}'s vote proof is invalid.`, m.pubkey, m.label);
    if (r.transcript !== st.transcript) {
      return fail(
        `${m.label} revealed against a different set of commitments: someone replaced a commitment ` +
          `(or ${m.label} is misbehaving).`,
        m.pubkey,
        m.label,
      );
    }
    m.revealed = true;
    Vs.push(V);
  }

  // ---- Progress & phase -------------------------------------------------------
  st.progress.joined = members.filter((m) => m.join).length;
  st.progress.committed = members.filter((m) => m.commit).length;
  st.progress.revealed = members.filter((m) => m.revealed).length;
  st.waiting.join = members.filter((m) => !m.join).map((m) => m.label);
  st.waiting.commit = members.filter((m) => !m.commit).map((m) => m.label);
  st.waiting.reveal = allCommitted ? members.filter((m) => !m.revealed).map((m) => m.label) : [];

  if (allCommitted && members.every((m) => m.revealed)) {
    st.unanimous = isUnanimous(Vs);
    st.phase = 'result';
  } else if (now > meta.deadline) {
    st.phase = 'incomplete';
  } else {
    st.phase = allCommitted ? 'revealing' : 'committing';
  }
  return st;
}
