import { useState } from 'preact/hooks';
import { Qr } from './Qr';

export function SharePanel({ url, bare }: { url: string; bare?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text so the user can copy it manually.
      const el = document.getElementById('share-url') as HTMLInputElement | null;
      el?.select();
    }
  }

  const body = (
    <div class="stack">
      {!bare && <h2>Invite the group</h2>}
      <p class="muted small">
        Anyone with this link can see the question and ask to join. The secret part after <code>#</code> never leaves
        your browser, so GitHub never sees it and relays only see encrypted data.
      </p>
      <input id="share-url" class="mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      <div class="btnrow">
        <button type="button" class="btn primary" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy link'}
        </button>
        {canShare && (
          <button
            type="button"
            class="btn"
            onClick={() => void navigator.share({ title: 'Unanimous poll', url }).catch(() => {})}
          >
            Share…
          </button>
        )}
        <button type="button" class="btn" onClick={() => setShowQr(!showQr)}>
          {showQr ? 'Hide QR' : 'QR code'}
        </button>
      </div>
      {showQr && (
        <div class="qrwrap">
          <Qr text={url} />
        </div>
      )}
    </div>
  );
  return bare ? body : <section class="card">{body}</section>;
}
