# Unanimous

Anonymous unanimous-decision polls for groups of friends.

Someone asks a yes/no question ("Dinner together tonight?"). Everyone votes **Yes** or
**No (veto)**, and the only thing anybody learns is one bit: **unanimous yes**, or **not
unanimous**. Nobody can find out who said no, or how many did. That holds even for someone
who inspects all network traffic or opens the browser's developer tools, unless every other
participant colludes.

- **No backend.** It's a static site on GitHub Pages. Shared state lives, encrypted, on free
  public [Nostr](https://nostr.com) relays (kind 30078). There are no accounts or API keys.
- **Asynchronous.** People vote over hours, closing and reopening the link. Keeping the page
  open completes every step automatically.
- **Cryptography.** It uses the Anonymous Veto Network (Hao & Zieliński 2006) on secp256k1,
  with Schnorr proofs and a commit round. Cheating can only abort a poll, never fake a result.
  See [PROTOCOL.md](PROTOCOL.md).
- Works in mobile Safari (iOS 16+), Android Chrome and desktop Chrome, Firefox, Safari and Edge.

## Local development

Requires Node.js 20.19+ (CI uses the current LTS).

```sh
npm ci
npm run dev           # http://localhost:5173
npm test              # unit + simulated multi-party tests
npm run typecheck
npm run lint
npm run build         # → dist/
npm run preview       # serve dist/ (with the production CSP)
```

Network-dependent dev scripts (not run in CI):

```sh
npm run check-relays                     # do the default relays accept + return kind-30078 events?
npm run check-relays -- wss://some.relay # check other relays
npm run test:live                        # full 3-party polls through the real default relays
```

The default relays are in `src/nostr/default-relays.json`. They were chosen by running
`npm run check-relays` against a list of candidates.

## Deployment (GitHub Pages)

`.github/workflows/deploy.yml` runs on every push to `master`: install → typecheck → lint →
test → build. If all of that passes, it force-pushes `dist/` (plus `.nojekyll`) as a single
commit to an orphan `gh-pages` branch, overwriting it completely each time.

One-time setup:

1. In DNS, add `vote.risko.hu. CNAME <user>.github.io.` (the GitHub user/org, without the repo name).
2. Push this repository to GitHub on the `master` branch.
3. Wait for the first workflow run to finish. It creates the `gh-pages` branch, containing a
   `CNAME` file with `vote.risko.hu`.
4. Go to **Settings → Pages → Build and deployment**. Set **Source: Deploy from a branch**,
   **Branch: `gh-pages` / `(root)`**, then save. **Custom domain** should show `vote.risko.hu`
   (enter it if not). Wait for the DNS check to pass.
5. On the same page, tick **Enforce HTTPS**. This becomes available once GitHub has issued the
   certificate, which can take a few minutes.
6. The app is served at `https://vote.risko.hu/`.

The custom domain is set by `cname:` in the workflow. It has to live there rather than only in
Settings, because each deploy replaces `gh-pages` with a fresh orphan commit. To serve from
`https://<user>.github.io/<repo>/` instead, remove that line.

The workflow needs `permissions: contents: write`, which is already set in the file. If your
organisation restricts the default `GITHUB_TOKEN`, allow read/write under **Settings → Actions
→ General → Workflow permissions**.

The build uses relative asset paths (`base: './'`) and hash routing, so it works under any
subpath without server rewrites.

## How it works (short)

1. **Create.** The creator's browser generates a random poll secret and a per-poll key. The
   share link carries the secret in the URL fragment: 22 characters, e.g.
   `https://vote.risko.hu/#Xq3vT0bK9mQ2wLr8YcN4aE`. The fragment never reaches the web server.
   That one value also commits to the creator's key, so only the creator can set the question
   and lock the group. Relays only see AES-GCM ciphertext and a derived, opaque poll tag.
2. **Join.** Each participant's browser creates its own per-poll keys and publishes a name and
   an AV-net public key with a proof of knowledge.
3. **Lock.** The creator locks the group, which fixes membership and order. This happens
   automatically when the expected group size is reached and the creator's page is open.
4. **Commit.** Each browser computes its encrypted-looking vote share and publishes only a
   hash commitment.
5. **Reveal.** Once everyone has committed, each browser reveals its share with a proof. The
   shares sum to the identity point exactly when everyone said yes.

Votes are never logged. No count of no votes exists anywhere, and local secrets are wiped
once the poll is final. The in-app "How it works" page explains the guarantees and limits
in plain language.

### Trust and limits

- The creator controls membership but cannot learn votes. Names are visible to all, so sock
  puppets are visible.
- All other participants colluding can deanonymise a veto. With 2 people, "not unanimous"
  reveals the other person's vote.
- Someone who stops participating blocks the result until the deadline ("No decision").
- Relays see IP addresses and timing.
- Poll secrets live in the browser's localStorage. Switching device or browser, or clearing
  site data, means you can't continue that poll.

## Project layout

```
src/crypto/   pure AV-net, Schnorr proofs, hashing, key derivation, AES-GCM (no I/O)
src/nostr/    event codec (kind 30078, d/expiration tags, encryption), relay transport, relay list
src/state/    message formats, deterministic event → phase derivation, share links, local storage
src/app/      PollSession: automation (auto-lock, commit, reveal, wipe), browser wiring
src/ui/       Preact UI (home, poll page, how-it-works)
tests/        crypto, derivation and simulated multi-party sessions; tests/live: real relays
scripts/      check-relays and helpers
```

Security headers: the production build carries a strict Content-Security-Policy meta tag
(`default-src 'self'; connect-src 'self' wss:`). There are no inline scripts or styles, and
nothing is loaded from a CDN.
