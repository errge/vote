# Build: "Unanimous" — anonymous unanimous-decision web app (static, Nostr-backed, AV-net protocol)

## What you are building
A complete TypeScript web app, built from scratch in an empty repo. I will commit it to GitHub.
- The `master` branch holds normal source code (package.json, src/, tests, CI config).
- A GitHub Actions workflow builds the app on every push to `master`. It force-pushes the built static files to an orphan branch `gh-pages` as a single commit, fully overwritten each time (no history). Use `peaceiris/actions-gh-pages@v4` with `force_orphan: true`, or equivalent git commands.
- GitHub Pages serves `gh-pages` (root) over HTTPS at `https://<user>.github.io/<repo>/`.
- There is no backend of any kind. All shared state lives on public Nostr relays: free, no accounts, no API keys, no payment. No WebRTC, no TURN.
- It must work out of the box in mobile Safari (iOS 16+), Android Chrome, and desktop Chrome/Firefox/Safari/Edge on Linux, macOS and Windows.

## Purpose
A group of friends decides on a yes/no question ("Dinner together tonight?"). The result is only one bit: **unanimous yes**, or **not unanimous**. Nobody can find out who said no, or how many said no. This must hold even for someone inspecting all network traffic or using F12, unless all other participants collude. Voting is asynchronous: people vote over hours, closing and reopening the page.

## Tech stack
- Vite + TypeScript (strict mode). Vanilla TS or Preact; keep dependencies minimal.
- Runtime dependencies: `nostr-tools` (relay pool, event signing), `@noble/curves` (secp256k1 point math), `@noble/hashes` (SHA-256, HKDF). Optional: a small QR-code library.
- Bundle everything. No runtime CDN loads. Add a strict Content-Security-Policy meta tag: `default-src 'self'`, `connect-src 'self' wss:`, no inline scripts.
- Vite `base: './'` so the app works under the `/<repo>/` subpath. Use hash-based routing only, since there are no server rewrites.
- Use WebCrypto AES-GCM for encryption and `crypto.getRandomValues` for all randomness.
- Vitest for unit tests. CI runs typecheck, lint, tests, then build; deploy only if all pass.
- Use the current Node LTS in CI. Commit the lockfile.

## Cryptographic protocol: Anonymous Veto Network (Hao & Zieliński 2006) plus a commit round, 3 rounds

### Notation
- Additive notation on secp256k1: generator G, group order n, `H` = SHA-256.
- All points are compressed hex.
- Reject invalid points, the identity point, and zero scalars everywhere.
- Every hash input is prefixed with a domain-separation tag, e.g. `"unanimous/v1/<purpose>"`.

### Poll setup (creator)
1. Generate:
   - A per-poll Nostr keypair for the creator. The creator is also a participant and uses the same key.
   - `salt`: 32 random bytes. It is stored inside the encrypted META.
   - `pollSecret = H("unanimous/v1/poll" || creatorPubkey || salt)[0..16]`: 16 bytes (128 bits). It is both the poll's only secret and a commitment to the creator's pubkey.
2. Derive:
   - `pollTag = hex(H("unanimous/v1/tag" || pollSecret))[0..32]`. This is public on relays and links the poll's events. It must not reveal the secret.
   - `encKey = HKDF-SHA256(pollSecret, info="unanimous/v1/enc")`, used as the AES-GCM-256 key.
3. Share link: `https://vote.risko.hu/#<base64url(pollSecret)>` (22 chars after `#`), plus `&r=<relays>` only if non-default.
   - The poll secret is the "invitation key". `pollTag` and `encKey` are derived from it, so whoever holds the link can find the poll's events on the relays, decrypt them, and ask to join. It must never leave the fragment. 128 bits is ample. Votes don't depend on it at all, since the AV-net protects them.
   - It also identifies the creator, with no separate creator parameter. A META authenticates its author as the creator iff `H("unanimous/v1/poll" || event.pubkey || meta.salt)[0..16] == pollSecret`. Forging that is a 128-bit second preimage. If more than one pubkey passes, abort.
   - Only the creator may publish META (question, deadline) and ROSTER (the group lock). Ignore META/ROSTER events from any other key. Otherwise any link holder could change the question after people voted, or lock or kick people out of the group.
   - `r` (relays, optional): a comma-separated list of percent-encoded `wss://` URLs. It is present only when the creator chose non-default relays.
   - The fragment never reaches the web server.
4. Publish a META event: question, optional expected group size N, deadline (default 24h, selectable), and creation time.

### Round 1 — JOIN
Each participant, on first opening the link (per device):
- Generate a per-poll Nostr keypair and a secret scalar `x_i`. Compute `X_i = x_i·G`.
- Choose a display name, prefilled from localStorage. Names are intentionally visible to the group; only votes are secret.
- Optionally pre-select a vote (yes/veto). It stays changeable locally until the commit.
- Publish JOIN: `{name, X_i, pokJoin}`, where `pokJoin` is a Schnorr proof of knowledge of `x_i` with base G (see Proofs). This prevents rogue-key attacks.

### Roster lock (creator)
- The creator's page shows joined participants. It offers "Lock group & start voting", enabled when at least 2 have joined, with a warning below 3.
- Auto-lock when the expected N is reached and the creator's page is open.
- Publish ROSTER: the list of `(pubkey, H(joinPayload))`, sorted by pubkey. This order defines index i. `rosterHash = H(canonical roster)`.
- The creator can exclude duplicates, e.g. the same person joining from two devices.
- Trust assumption, document it: the creator controls membership but cannot learn votes. Everyone sees the roster names, so sock puppets are visible.
- A participant whose current JOIN payload hash doesn't match the roster is invalid, and the poll aborts.

### Computing Y_i
`Y_i = Σ_{j<i} X_j − Σ_{j>i} X_j`. This guarantees `Σ_i x_i·Y_i = O` (the identity point).
- If any `Y_i` is the identity, abort.

### Round 2 — COMMIT
When the roster is known and the user has a selected vote, the client does this automatically. It runs on page open or live if the page is open.
- Yes: `c_i = x_i`. Veto: `c_i` = a fresh random scalar, with `c_i ≠ x_i`.
- `V_i = c_i·Y_i`.
- `pokReveal` = Schnorr proof of knowledge of `c_i` with base `Y_i` and public point `V_i`. Yes and veto proofs are indistinguishable.
- `salt` = 32 random bytes.
- `C_i = H("unanimous/v1/commit" || pollTag || pubkey || V_i || pokReveal || salt)`.
- Publish COMMIT: `{C_i, rosterHash}`.
- After committing, the vote is final and the UI must say so. Store `c_i`, `V_i`, the proof and the salt in localStorage for the reveal.

### Round 3 — REVEAL
When all roster members have committed, every client auto-reveals:
- `transcriptHash = H(rosterHash || all C_j sorted by roster order)`.
- Publish REVEAL: `{V_i, pokReveal, salt, transcriptHash}`.

The commit round prevents last-voter advantage: nobody can see the outcome before their own vote is fixed.

### Result
Valid when every roster member has a REVEAL where:
- the commitment matches,
- the proof verifies,
- `transcriptHash` is identical across all participants.

`S = Σ V_i`. If `S == O`, the result is **UNANIMOUS YES**. Otherwise it is **NOT UNANIMOUS**.

### Failure states, derived deterministically
- Deadline passes before the result: "No decision (incomplete)". Show which names haven't completed which phase. This reveals no votes.
- Any integrity failure aborts the poll with a clear message naming the offending pubkey/name. Cheating must only ever cause an abort, never a wrong result. Integrity failures include:
  - a bad proof,
  - a commitment mismatch,
  - a transcript mismatch, e.g. someone replaced their COMMIT after others revealed,
  - a JOIN changed after the roster.

### Proofs (Fiat–Shamir Schnorr NIZK)
To prove knowledge of `a` with `P = a·B`:
- Pick random `k`. `R = k·B`.
- `e = H("unanimous/v1/pok" || pollTag || label || pubkey || B || P || R) mod n`.
- `s = k + e·a mod n`.
- The proof is `(R, s)`. Verify that `s·B == R + e·P`.
- Labels: `"join"` (B = G) and `"reveal"` (B = Y_i).

### Security properties to state in the "How it works" page
- Votes are hidden under DDH. Even with full traffic access, only the one-bit outcome is learned, not who vetoed or how many.
- One vote per roster member; ballot stuffing is impossible.
- Known limits:
  - All other participants colluding can deanonymize a veto.
  - With 2 people, a "no" result reveals the other person's vote.
  - Someone who stops participating blocks the result (until the deadline).
  - Relays see IP addresses and timing.
  - Someone with access to a voter's device can read their stored choice. Wipe local secrets once the result is final.

## Nostr transport
- Event kind 30078 (NIP-78 application data, addressable). Tags:
  - `["d", "<pollTag>:<type>"]` with type ∈ `meta`, `roster`, `join`, `commit`, `reveal`.
  - `["expiration", deadline + 7 days]` (NIP-40).
- Query with filters like `{kinds:[30078], "#d":["<pollTag>:join", ...]}`.
- Event content is AES-GCM ciphertext: random 12-byte IV, AAD = `pollTag|type|pubkey`. Relays see only opaque blobs plus the pollTag.
- Default relays: 5–6 free public relays, e.g. `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr-pub.wellorder.net`, `wss://nostr.mom`, `wss://offchain.pub`.
  - Make the list configurable in an "Advanced" section.
  - Add a dev script `npm run check-relays` that verifies each default relay accepts and returns a kind-30078 test event. Use its results to choose defaults.
- Publish to all relays. Handle `OK false` messages (rate limits, PoW requirements) and show per-relay status.
- Resilience: every client re-publishes all valid signed poll events it knows, including other participants' events, to all relays on each page load. This heals relays that dropped events.
- Subscribe live while the page is open. Derive the whole UI state purely from the fetched events plus local secrets. No other state.
- Handle Safari backgrounding: on `visibilitychange`, reconnect and refetch.

## UI/UX
- English only. Mobile-first, clean, large tap targets, works in light and dark mode.
- **Home**: "Create a poll" form (question, optional group size, deadline, your name). After creation, show the share link with Copy, `navigator.share`, and a QR code for in-person use.
- **Poll page**:
  - Question, current phase, and progress: "Joined 4/6", "Voted 5/6", "Revealed 3/6".
  - Names of who we're still waiting for, per phase.
  - Two big buttons, **Yes** / **No (veto)**, with clear text that the choice locks once the group is complete. Before the commit, the vote can be changed.
- Explain that the user can close the page and come back via the same link, and that keeping it open completes everything automatically. Each person needs to reopen the link after everyone has voted so their vote can be revealed. Add an optional browser notification while the tab is open.
- **Result screen**: a big "✅ Unanimous YES" or "Not unanimous". Never show a count of no votes, never show names in connection with votes, and never log vote choices or secrets to the console.
- A "How it works / privacy" page explaining the protocol in plain language.
- Persist per-poll secrets in localStorage keyed by pollTag. Warn that switching device or browser, or clearing site data, means you can't continue that poll.

## Repo deliverables
- `src/` structured as:
  - `crypto/` (pure AV-net and proof functions, no I/O),
  - `nostr/` (transport),
  - `state/` (event-to-phase derivation),
  - `ui/`.
- `tests/` covering:
  - simulated N-party polls (all yes gives unanimous; any single veto or several vetoes gives not unanimous),
  - proof verification and rejection of tampered values,
  - commitment mismatch, transcript mismatch, invalid points, identity Y_i, roster mismatch,
  - deterministic ordering,
  - state derivation from event sets.
- `.github/workflows/deploy.yml`: on push to master → install → typecheck → lint → test → build → force-push `dist/` (plus `.nojekyll`) as a single-commit orphan branch `gh-pages`. Needs `permissions: contents: write`.
- `README.md`: what it is, local dev (`npm run dev`), and one-time GitHub Pages setup (Settings → Pages → Deploy from branch `gh-pages` / root, Enforce HTTPS).
- `PROTOCOL.md`: the exact protocol and message formats above.
- Everything must build and pass tests with no manual edits.
