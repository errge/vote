import { useMemo, useState } from 'preact/hooks';
import { browserDeps } from '../app/browser';
import { createPoll } from '../app/session';
import { DEFAULT_RELAYS, parseRelayList } from '../nostr/relays';
import { pollFragment } from '../state/link';
import { listPolls, loadName, saveName, storageAvailable } from '../state/local';
import { cleanText, MAX_GROUP, MAX_NAME, MAX_QUESTION } from '../state/messages';

export const DEADLINES: { label: string; seconds: number }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '3 hours', seconds: 3 * 3600 },
  { label: '6 hours', seconds: 6 * 3600 },
  { label: '12 hours', seconds: 12 * 3600 },
  { label: '24 hours', seconds: 24 * 3600 },
  { label: '2 days', seconds: 2 * 86400 },
  { label: '3 days', seconds: 3 * 86400 },
  { label: '1 week', seconds: 7 * 86400 },
];

export function Home() {
  const [question, setQuestion] = useState('');
  const [size, setSize] = useState('');
  const [deadline, setDeadline] = useState(24 * 3600);
  const [name, setName] = useState(loadName);
  const [relayText, setRelayText] = useState(DEFAULT_RELAYS.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polls = useMemo(() => listPolls(), []);
  const canStore = useMemo(() => storageAvailable(), []);

  const relayParse = parseRelayList(relayText);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    const q = cleanText(question);
    const n = cleanText(name);
    const sz = size.trim() === '' ? null : Number(size);
    if (!q) return setError('Please enter a question.');
    if (!n) return setError('Please enter your name.');
    if (sz !== null && (!Number.isInteger(sz) || sz < 2 || sz > MAX_GROUP)) {
      return setError(`Group size must be a whole number between 2 and ${MAX_GROUP}.`);
    }
    if (relayParse.invalid.length) return setError(`Invalid relay URL: ${relayParse.invalid[0]}`);
    if (!relayParse.relays.length) return setError('At least one relay is needed.');
    setBusy(true);
    try {
      saveName(n);
      const link = await createPoll(
        { question: q, size: sz, durationSeconds: deadline, name: n, relays: relayParse.relays },
        browserDeps(),
      );
      location.hash = pollFragment(link);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the poll.');
      setBusy(false);
    }
  }

  return (
    <div class="stack">
      <section class="card">
        <h1>Ask your group a yes/no question</h1>
        <p class="muted">
          Everyone votes <b>Yes</b> or <b>No</b>. The only thing anyone learns is whether it was{' '}
          <b>unanimously yes</b>. Nobody can find out who said no, or how many did.
        </p>
      </section>

      {!canStore && (
        <div class="banner error">
          This browser does not allow this site to store data (private mode?). Polls need local storage to keep your
          secret vote keys.
        </div>
      )}

      <form class="card stack" onSubmit={submit}>
        <h2>Create a poll</h2>
        <label class="field">
          <span>Question</span>
          <textarea
            rows={2}
            maxLength={MAX_QUESTION}
            placeholder="Dinner together tonight?"
            value={question}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            required
          />
        </label>
        <div class="row2">
          <label class="field">
            <span>Group size (optional)</span>
            <input
              type="number"
              inputMode="numeric"
              min={2}
              max={MAX_GROUP}
              placeholder="e.g. 6"
              value={size}
              onInput={(e) => setSize(e.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>Deadline</span>
            <select value={deadline} onChange={(e) => setDeadline(Number(e.currentTarget.value))}>
              {DEADLINES.map((d) => (
                <option key={d.seconds} value={d.seconds}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p class="hint">
          With a group size, voting starts automatically once that many people have joined (while your page is open).
          Otherwise you start it yourself.
        </p>
        <label class="field">
          <span>Your name (visible to the group)</span>
          <input
            type="text"
            maxLength={MAX_NAME}
            autoComplete="nickname"
            placeholder="Alex"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            required
          />
        </label>
        <details class="advanced">
          <summary>Advanced: relays</summary>
          <p class="hint">
            Poll messages are stored, encrypted, on these public Nostr relays (one <code>wss://</code> URL per line).
            Non-default relays are included in the share link.
          </p>
          <textarea rows={6} spellcheck={false} value={relayText} onInput={(e) => setRelayText(e.currentTarget.value)} />
          {relayParse.invalid.length > 0 && <p class="error-text">Invalid: {relayParse.invalid.join(', ')}</p>}
          <button type="button" class="btn small ghost" onClick={() => setRelayText(DEFAULT_RELAYS.join('\n'))}>
            Reset to defaults
          </button>
        </details>
        {error && <p class="error-text">{error}</p>}
        <button class="btn primary big" type="submit" disabled={busy || !canStore}>
          {busy ? 'Creating…' : 'Create poll'}
        </button>
      </form>

      {polls.length > 0 && (
        <section class="card">
          <h2>Your polls on this device</h2>
          <ul class="polllist">
            {polls.map((p) => (
              <li key={p.pollTag}>
                <a href={p.fragment}>{p.question ?? 'Untitled poll'}</a>
                <span class="muted small">
                  {new Date(p.createdAt).toLocaleString()}
                  {p.wiped ? ' · finished' : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
