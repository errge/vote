import { useEffect, useRef, useState } from 'preact/hooks';
import { browserDeps } from '../app/browser';
import { PollSession } from '../app/session';
import type { Vote } from '../crypto';
import type { PollState } from '../state/derive';
import { parsePollFragment, shareUrl } from '../state/link';
import { loadName, saveName } from '../state/local';
import { MAX_NAME } from '../state/messages';
import { RelayPanel } from './RelayPanel';
import { SharePanel } from './SharePanel';
import { formatRemaining } from './time';

const PHASE_LABEL: Record<PollState['phase'], string> = {
  loading: 'Loading',
  joining: 'Joining',
  committing: 'Voting',
  revealing: 'Revealing',
  result: 'Finished',
  incomplete: 'Closed',
  aborted: 'Aborted',
};

function useSession(fragment: string) {
  const [session, setSession] = useState<PollSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const link = parsePollFragment(fragment);
    if (!link) {
      setError('This link is not a valid poll link. Ask for the link again.');
      return;
    }
    let s: PollSession | null = null;
    let cancelled = false;
    const rerender = () => setTick((t) => t + 1);
    let hiddenAt = 0;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else {
        s?.refresh(hiddenAt > 0 && Date.now() - hiddenAt > 20_000);
        hiddenAt = 0;
      }
    };
    const onRefresh = () => s?.refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key?.endsWith(s?.pollTag ?? '\0')) s?.refresh();
    };
    void PollSession.open(link, browserDeps()).then(async (sess) => {
      if (cancelled) return;
      s = sess;
      sess.subscribe(rerender);
      await sess.start();
      setSession(sess);
    }, () => setError('Your browser does not support the cryptography this app needs.'));
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onRefresh);
    window.addEventListener('pageshow', onRefresh);
    window.addEventListener('storage', onStorage);
    const clock = setInterval(rerender, 30_000);
    return () => {
      cancelled = true;
      s?.stop();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onRefresh);
      window.removeEventListener('pageshow', onRefresh);
      window.removeEventListener('storage', onStorage);
      clearInterval(clock);
    };
  }, [fragment]);

  return { session, error };
}

/** Optional browser notifications on phase changes while the tab is in the background. */
function usePhaseNotifications(session: PollSession | null) {
  const last = useRef<string | null>(null);
  const phase = session?.state.phase ?? null;
  useEffect(() => {
    if (!session || !phase) return;
    const prev = last.current;
    last.current = phase;
    if (!prev || prev === phase || prev === 'loading') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
    const q = session.state.meta?.question ?? 'Your poll';
    const body: Partial<Record<string, string>> = {
      committing: 'The group is locked. Time to vote!',
      revealing: 'Everybody has voted. Revealing…',
      result: 'The result is in.',
      incomplete: 'The deadline passed without a decision.',
      aborted: 'The poll was aborted.',
    };
    if (body[phase]) {
      try {
        new Notification(q, { body: body[phase], tag: session.pollTag });
      } catch {
        /* some mobile browsers only allow notifications from a service worker */
      }
    }
  }, [session, phase]);
}

export function PollPage({ fragment }: { fragment: string }) {
  const { session, error } = useSession(fragment);
  usePhaseNotifications(session);

  if (error) return <div class="card error-card">{error}</div>;
  if (!session) return <div class="card">Opening poll…</div>;
  return <PollView session={session} />;
}

function PollView({ session }: { session: PollSession }) {
  const st = session.state;
  const L = session.local;
  const joined = !!L?.events.join;
  const me = session.me;
  const final = st.phase === 'result' || st.phase === 'incomplete' || st.phase === 'aborted';
  const url = shareUrl(session.link);

  if (st.phase === 'loading') return <Loading session={session} />;

  return (
    <div class="stack">
      <section class="card">
        <div class="phase-row">
          <span class={`badge phase-${st.phase}`}>{PHASE_LABEL[st.phase]}</span>
          {st.meta && !final && <span class="muted small">closes {formatRemaining(st.meta.deadline)}</span>}
        </div>
        <h1 class="question">{st.meta?.question}</h1>
        <Progress st={st} />
      </section>

      {st.phase === 'result' && <Result unanimous={st.unanimous!} />}
      {st.phase === 'incomplete' && <Incomplete st={st} />}
      {st.phase === 'aborted' && (
        <section class="card result-card aborted">
          <div class="result-big">⚠️ Poll aborted</div>
          <p>{st.abort?.reason}</p>
          <p class="muted small">
            An integrity check failed, so no result is shown. Cheating can only ever stop a poll, never fake its
            result. Start a new poll if needed.
          </p>
        </section>
      )}

      {!final && !joined && <JoinCard session={session} />}
      {!final && joined && st.roster && !me && (
        <section class="card">
          <h2>You are not part of this group</h2>
          <p class="muted">
            The creator locked the group without this device (for example because you joined twice from different
            devices). You can still watch the result here.
          </p>
        </section>
      )}
      {!final && joined && (!st.roster || me) && <VoteCard session={session} />}

      {!final && session.isCreator && st.phase === 'joining' && <CreatorPanel session={session} />}
      {!final && <Waiting st={st} session={session} />}

      {(st.phase === 'joining' || session.isCreator) && !final ? (
        <SharePanel url={url} />
      ) : (
        <details class="card details-card">
          <summary>Share link</summary>
          <SharePanel url={url} bare />
        </details>
      )}

      {!final && <InfoCard />}

      {session.actionError && <div class="banner error">{session.actionError}</div>}
      <PublishNote session={session} />

      <details class="card details-card">
        <summary>Advanced: relays &amp; device</summary>
        <RelayPanel session={session} />
        <p class="hint">
          Your secret keys for this poll are stored only in this browser. If you switch device or browser, or clear
          site data, you cannot continue this poll from there.
          {L?.wiped && ' This poll is finished, so the secrets have already been erased from this device.'}
        </p>
      </details>
    </div>
  );
}

function Loading({ session }: { session: PollSession }) {
  const relays = session.relayStatus();
  const synced = relays.filter((r) => r.synced).length;
  const done = relays.length > 0 && relays.every((r) => r.synced || r.state === 'closed');
  return (
    <div class="stack">
      <section class="card">
        <h1>Loading poll…</h1>
        <p class="muted">
          Fetching from relays ({synced}/{relays.length} answered).
        </p>
        {done && (
          <p class="error-text">
            The poll was not found on any relay yet. If it was just created, wait a moment. Otherwise check that the
            link is complete.
          </p>
        )}
      </section>
      <details class="card details-card" open={done}>
        <summary>Relays</summary>
        <RelayPanel session={session} />
      </details>
    </div>
  );
}

function Progress({ st }: { st: PollState }) {
  const p = st.progress;
  const total = p.total || '?';
  const items: [string, number, boolean][] = [['Joined', p.joined, true]];
  if (st.roster) items.push(['Voted', p.committed, true], ['Revealed', p.revealed, p.committed === p.total]);
  return (
    <div class="progress">
      {items.map(([label, n, active]) => (
        <div key={label} class={`pstep ${active ? '' : 'dim'}`}>
          <span class="pnum">
            {n}/{st.roster ? p.total : total}
          </span>
          <span class="plabel">{label}</span>
        </div>
      ))}
    </div>
  );
}

function JoinCard({ session }: { session: PollSession }) {
  const st = session.state;
  const [name, setName] = useState(loadName);
  const [vote, setVote] = useState<Vote | null>(null);
  const [busy, setBusy] = useState(false);

  if (st.roster) {
    return (
      <section class="card">
        <h2>Voting has already started</h2>
        <p class="muted">The group was locked before you joined, so you cannot take part in this poll.</p>
      </section>
    );
  }

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    saveName(name.trim());
    await session.join(name, vote);
    setBusy(false);
  }

  return (
    <form class="card stack" onSubmit={submit}>
      <h2>Join this poll</h2>
      <label class="field">
        <span>Your name (visible to the group; your vote is not)</span>
        <input
          type="text"
          maxLength={MAX_NAME}
          autoComplete="nickname"
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
          required
        />
      </label>
      <div>
        <p class="label">Your vote (optional now, you can change it until the group is locked)</p>
        <VoteButtons selected={vote} onPick={(v) => setVote(vote === v ? null : v)} />
      </div>
      <button class="btn primary big" type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Joining…' : 'Join'}
      </button>
      <p class="hint">Joining stores secret keys for this poll in this browser. Use the same device to come back.</p>
    </form>
  );
}

function VoteButtons({ selected, onPick, disabled }: { selected: Vote | null; onPick: (v: Vote) => void; disabled?: boolean }) {
  return (
    <div class="votes">
      <button
        type="button"
        class={`btn vote yes ${selected === 'yes' ? 'selected' : ''}`}
        aria-pressed={selected === 'yes'}
        disabled={disabled}
        onClick={() => onPick('yes')}
      >
        <span class="vicon">👍</span> Yes
      </button>
      <button
        type="button"
        class={`btn vote no ${selected === 'veto' ? 'selected' : ''}`}
        aria-pressed={selected === 'veto'}
        disabled={disabled}
        onClick={() => onPick('veto')}
      >
        <span class="vicon">✋</span> No (veto)
      </button>
    </div>
  );
}

function VoteCard({ session }: { session: PollSession }) {
  const st = session.state;
  const L = session.local!;
  const [confirm, setConfirm] = useState<Vote | null>(null);
  const committed = !!L.ballot || !!session.me?.commit;
  const locked = !!st.roster;

  if (committed) {
    return (
      <section class="card locked-card">
        <h2>🔒 Your vote is locked in</h2>
        {L.vote && <p>You voted <b>{L.vote === 'yes' ? 'Yes' : 'No (veto)'}</b>. This is final.</p>}
        <p class="muted small">
          {st.phase === 'revealing'
            ? 'Everyone has voted. Each person’s page now reveals their (still anonymous) vote share.'
            : 'Waiting for the others to vote. Nobody, including you, can see any result before everyone has voted.'}
        </p>
      </section>
    );
  }

  if (!locked) {
    return (
      <section class="card stack">
        <h2>Your vote</h2>
        <VoteButtons selected={L.vote} onPick={(v) => void session.setVote(L.vote === v ? null : v)} />
        <p class="hint">
          {L.vote
            ? 'Pre-selected. You can still change it. It becomes final automatically once the group is locked.'
            : 'You can pick now or later. It becomes final once the group is locked.'}
        </p>
      </section>
    );
  }

  return (
    <section class="card stack">
      <h2>Cast your vote</h2>
      {confirm ? (
        <div class="confirm stack">
          <p>
            Lock in <b>{confirm === 'yes' ? 'Yes' : 'No (veto)'}</b>? You cannot change it afterwards.
          </p>
          <div class="votes">
            <button type="button" class="btn ghost" onClick={() => setConfirm(null)}>
              Back
            </button>
            <button
              type="button"
              class={`btn ${confirm === 'yes' ? 'yesbg' : 'nobg'}`}
              onClick={() => {
                void session.setVote(confirm);
                setConfirm(null);
              }}
            >
              Confirm {confirm === 'yes' ? 'Yes' : 'No'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <VoteButtons selected={null} onPick={setConfirm} />
          <p class="hint">The group is complete, so your choice is final as soon as you confirm it.</p>
        </>
      )}
    </section>
  );
}

function CreatorPanel({ session }: { session: PollSession }) {
  const st = session.state;
  const excluded = new Set(session.local?.excluded ?? []);
  const candidates = session.lockCandidates();
  const n = candidates.length;
  const [busy, setBusy] = useState(false);
  return (
    <section class="card stack">
      <h2>You are the organizer</h2>
      <p class="muted small">
        Untick duplicates (for example the same person on two devices). Names are visible to everyone, so nobody can
        sneak in unnoticed.
      </p>
      <ul class="joiners">
        {st.joiners.map((j) => (
          <li key={j.pubkey}>
            <label class="check">
              <input
                type="checkbox"
                checked={!excluded.has(j.pubkey) || j.pubkey === session.creator}
                disabled={j.pubkey === session.creator}
                onChange={(e) => session.setExcluded(j.pubkey, !e.currentTarget.checked)}
              />
              <span>
                {j.label}
                {j.pubkey === session.creator && <span class="muted"> (you)</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {st.meta?.size && (
        <p class="hint">
          Voting starts automatically when {st.meta.size} people have joined, as long as this page is open.
        </p>
      )}
      {n === 2 && (
        <p class="warn-text">
          With only 2 people, a “not unanimous” result tells each of you what the other voted.
        </p>
      )}
      <button
        type="button"
        class="btn primary big"
        disabled={n < 2 || busy}
        onClick={async () => {
          setBusy(true);
          await session.requestLock();
          setBusy(false);
        }}
      >
        Lock group &amp; start voting ({n})
      </button>
      {n < 2 && <p class="hint">At least 2 participants are needed.</p>}
    </section>
  );
}

function Waiting({ st, session }: { st: PollState; session: PollSession }) {
  let title = '';
  let names: string[] = [];
  if (st.phase === 'joining') {
    return (
      <section class="card">
        <h2>Joined so far</h2>
        <p>{st.joiners.map((j) => j.label).join(', ') || 'Nobody yet.'}</p>
        <p class="muted small">
          {session.isCreator
            ? 'Share the link below with the group.'
            : 'Waiting for the organizer to lock the group and start voting.'}
        </p>
      </section>
    );
  }
  if (st.waiting.join.length) {
    title = 'Waiting for data from';
    names = st.waiting.join;
  } else if (st.phase === 'committing') {
    title = 'Still to vote';
    names = st.waiting.commit;
  } else if (st.phase === 'revealing') {
    title = 'Waiting for these people to reopen the link';
    names = st.waiting.reveal;
  }
  if (!names.length) return null;
  return (
    <section class="card">
      <h2>{title}</h2>
      <p>{names.join(', ')}</p>
      {st.phase === 'revealing' && (
        <p class="muted small">
          Everyone has voted. Each person’s page has to publish its reveal, which happens automatically as soon as they
          open the link again.
        </p>
      )}
    </section>
  );
}

function Result({ unanimous }: { unanimous: boolean }) {
  return (
    <section class={`card result-card ${unanimous ? 'yes' : 'no'}`}>
      <div class="result-big">{unanimous ? '✅ Unanimous YES' : 'Not unanimous'}</div>
      <p class="muted">
        {unanimous
          ? 'Everybody said yes.'
          : 'At least one person said no. Nobody can find out who, or how many.'}
      </p>
    </section>
  );
}

function Incomplete({ st }: { st: PollState }) {
  const rows: [string, string[]][] = [];
  if (!st.roster) rows.push(['The group was never locked', []]);
  else {
    if (st.waiting.join.length) rows.push(['Join data missing', st.waiting.join]);
    if (st.waiting.commit.length) rows.push(['Did not vote', st.waiting.commit]);
    else if (st.waiting.reveal.length) rows.push(['Did not reopen the link to reveal', st.waiting.reveal]);
  }
  return (
    <section class="card result-card incomplete">
      <div class="result-big">⏱ No decision (incomplete)</div>
      <p class="muted">The deadline passed before everyone completed every step. No votes are revealed.</p>
      {rows.map(([label, names]) => (
        <p key={label}>
          <b>{label}</b>
          {names.length ? `: ${names.join(', ')}` : ''}
        </p>
      ))}
    </section>
  );
}

function InfoCard() {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return (
    <section class="card info">
      <p>
        You can close this page and come back with the same link. Keeping it open completes everything
        automatically.
      </p>
      <p>
        <b>After everyone has voted, each person needs to open the link once more</b> so their vote can be revealed.
      </p>
      {perm === 'default' && (
        <button
          type="button"
          class="btn small ghost"
          onClick={() => void Notification.requestPermission().then(setPerm)}
        >
          🔔 Notify me while this tab is open
        </button>
      )}
      {perm === 'granted' && <p class="muted small">🔔 Notifications are on while this tab is open.</p>}
    </section>
  );
}

function PublishNote({ session }: { session: PollSession }) {
  const last = session.publishLog[0];
  if (!last?.results) return null;
  const ok = last.results.filter((r) => r.ok).length;
  const what = { meta: 'Poll', roster: 'Group list', join: 'Your join', commit: 'Your vote', reveal: 'Your reveal' }[last.type];
  if (ok === 0) {
    return (
      <div class="banner error">
        {what} could not be stored on any relay yet. It is saved on this device and will be retried automatically.
      </div>
    );
  }
  return (
    <p class="muted small center">
      {what} stored on {ok} of {last.results.length} relays.
    </p>
  );
}
