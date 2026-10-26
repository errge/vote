import type { PollSession } from '../app/session';

export function RelayPanel({ session }: { session: PollSession }) {
  const relays = session.relayStatus();
  return (
    <div class="relays">
      <table>
        <thead>
          <tr>
            <th>Relay</th>
            <th>Status</th>
            <th title="poll events this relay holds">Events</th>
            <th title="accepted / rejected writes">Writes</th>
          </tr>
        </thead>
        <tbody>
          {relays.map((r) => (
            <tr key={r.url}>
              <td class="mono">
                {r.url.replace(/^wss:\/\//, '')}
                {r.lastError && <div class="error-text small">{r.lastError}</div>}
              </td>
              <td>
                <span class={`dot ${r.state}`} /> {r.state === 'open' ? (r.synced ? 'synced' : 'fetching') : r.state}
              </td>
              <td>{r.holds}</td>
              <td>
                {r.accepted}
                {r.rejected > 0 && <span class="error-text"> / {r.rejected}✗</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="hint">
        Every open page re-publishes the poll’s (encrypted, signed) messages to relays that are missing them, so a
        relay that drops data is healed automatically.
      </p>
    </div>
  );
}
