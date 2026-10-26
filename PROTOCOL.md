# Unanimous protocol, v1

Unanimous computes one bit, "everybody said yes" or "not unanimous", without revealing
individual votes. It is the Anonymous Veto Network (AV-net) of Hao & Zieliński (2006) with
an added commit round, carried over public Nostr relays. There is no server.

Reference implementation: `src/crypto` (pure math), `src/nostr/codec.ts` (event format),
`src/state/derive.ts` (validation and state derivation), `src/app/session.ts` (client behaviour).

## 1. Notation and encodings

- Group: secp256k1 with additive notation. Generator `G`, order `n`, identity `O`.
- **Point**: 33-byte compressed SEC1, lowercase hex (66 chars). Decoders reject wrong lengths,
  uppercase hex, uncompressed form, points not on the curve, and the identity, which has no
  encoding.
- **Scalar**: 32-byte big-endian, lowercase hex (64 chars), in `[1, n-1]`. Zero and values ≥ n
  are rejected.
- **Pubkey**: a Nostr x-only public key, 32 bytes / 64 hex. Each participant uses a fresh,
  per-poll Nostr keypair.
- `pollTag`: 16 bytes / 32 hex. Inside hashes it is used as the 16 raw bytes.
- **Hash** `H(purpose; p1, …, pk)` = SHA-256 over

  ```
  len(tag) ‖ tag ‖ len(p1) ‖ p1 ‖ … ‖ len(pk) ‖ pk
  ```

  where `tag = UTF-8("unanimous/v1/" + purpose)` and `len` is a 4-byte big-endian length.
  Every element is length-prefixed, so the encoding is injective.
- Hex values passed to `H` are decoded to raw bytes first. Strings are UTF-8.
- A proof `π = (R, s)` is encoded in JSON as `{"R": <point>, "s": <scalar>}`. As bytes it
  is `R (33) ‖ s (32)`.

## 2. Poll setup (creator)

```
pollSecret  ← 32 random bytes
(skC, pkC)  ← fresh Nostr keypair (the creator is also a participant)
pollTag     = hex(H("tag"; pollSecret))[0..32]
encKey      = HKDF-SHA256(ikm = pollSecret, salt = none (zeros), info = "unanimous/v1/enc", L = 32)
```

Share link:

```
https://<user>.github.io/<repo>/#p=<base64url(pollSecret), no padding>&c=<pkC hex>[&r=<relay>,<relay>…]
```

`r` is present only when the relay list differs from the defaults. Each relay is
percent-encoded, and the list is comma-separated. The fragment is never sent to the web
server. The creator pubkey `c` authenticates `meta` and `roster` events, and such events from
any other key are ignored.

## 3. Transport

Every message is a Nostr event:

| field        | value |
|--------------|-------|
| `kind`       | `30078` (NIP-78 application data, addressable) |
| `tags`       | `["d", "<pollTag>:<type>"]`, `["expiration", "<deadline + 604800>"]` (NIP-40) |
| `content`    | `base64( iv(12) ‖ AES-256-GCM(encKey, iv, plaintext, aad) )` |
| `aad`        | UTF-8 `"<pollTag>|<type>|<pubkey>"` |

`type` is one of `meta`, `roster`, `join`, `commit`, `reveal`. Because the events are
addressable, each `(pubkey, type)` has exactly one current event. When several are seen,
the one with the newest `created_at` wins, and on a tie the lowest `id` wins (NIP-01).
Clients fetch everything with

```json
{"kinds": [30078], "#d": ["<pollTag>:meta", "<pollTag>:roster", "<pollTag>:join", "<pollTag>:commit", "<pollTag>:reveal"]}
```

and stay subscribed while the page is open. Signature, `d` tag and successful AEAD
decryption are required. Anything else is ignored. Every client re-publishes every current,
valid poll event it knows to each relay that did not return it (healing). After the page
returns from the background it reconnects and refetches.

Events with `created_at > deadline` do not count, except `meta` itself.

## 4. Messages (plaintext JSON)

Objects must have exactly the listed fields. Strings must be non-empty and already
normalised: no control, zero-width or bidi-override characters, whitespace collapsed,
trimmed. `name` is at most 40 code points and `question` at most 300.

### meta (creator only)
```json
{"v":1, "question":"Dinner together tonight?", "size":6, "deadline":1800086400, "created":1800000000}
```
- `size` is the expected group size, an integer from 2 to 50, or `null`.
- `deadline` and `created` are unix seconds, with `created + 60 ≤ deadline ≤ created + 31 days`.

### join (round 1, every participant including the creator)
```
x ← random scalar,  X = x·G
pokJoin = PoK{x : X = x·G}  with label "join"
```
```json
{"v":1, "name":"Alex", "X":"02…", "pok":{"R":"03…","s":"…"}}
```
`joinHash = H("join"; pollTag, pubkey, UTF-8(name), X, R ‖ s)`

### roster (creator only)
```json
{"v":1, "members":[{"pubkey":"…","joinHash":"…"}, …]}
```
- `members` is sorted strictly ascending by pubkey (lowercase hex order). The position is the index `i`.
- It has 2 to 50 members and must contain the creator.
- `rosterHash = H("roster"; pollTag, pk_1 ‖ jh_1, …, pk_m ‖ jh_m)`, with each part being 64 bytes.

### commit (round 2)
```
Y_i = Σ_{j<i} X_j − Σ_{j>i} X_j          (abort if Y_i = O)
yes:  c_i = x_i
veto: c_i ← random scalar, c_i ≠ x_i
V_i = c_i·Y_i
pokReveal = PoK{c_i : V_i = c_i·Y_i}  with label "reveal"
salt ← 32 random bytes
C_i = H("commit"; pollTag, pubkey, V_i, R ‖ s, salt)
```
```json
{"v":1, "C":"<C_i hex>", "roster":"<rosterHash hex>"}
```
A client commits automatically once the roster is known and a vote is selected. It persists
`V_i`, the proof, the salt and `C_i` before publishing, and never produces a second commitment.

### reveal (round 3)
Sent once a commit from every roster member is visible:
```
transcriptHash = H("transcript"; rosterHash, C_1, …, C_m)     (roster order)
```
```json
{"v":1, "V":"<V_i>", "pok":{"R":"…","s":"…"}, "salt":"<salt>", "transcript":"<transcriptHash>"}
```

## 5. Proofs (Fiat–Shamir Schnorr)

To prove knowledge of `a` with `P = a·B`:

```
k ← random scalar,  R = k·B
e = H("pok"; pollTag, UTF-8(label), pubkey, B, P, R)  mod n      (as a big-endian integer)
s = k + e·a  mod n
```

The prover retries in the negligible case that `e = 0` or `s = 0`. To verify, the verifier
checks that `R ≠ O`, `s ≠ 0`, `e ≠ 0`, and `s·B = R + e·P`. Labels are `"join"` (with `B = G`)
and `"reveal"` (with `B = Y_i`). Because `pubkey` and `pollTag` are bound into the
challenge, a proof cannot be replayed by another participant or in another poll. That is
what prevents rogue-key and copy attacks.

## 6. Validation and result (deterministic)

`state = derive(events, now)` is a pure function. In order:

1. **meta**: the newest `meta` from `c`. If it is missing, the state is *loading*. If it is malformed, the poll **aborts**.
2. **joins**: a join is valid if it parses, `X` is a valid point, and `pokJoin` verifies. Invalid joins are ignored.
3. **roster**: the newest `roster` from `c`. If it is missing, the phase is *joining*. If it is malformed, has the wrong size,
   is not strictly sorted, or lacks the creator, the poll **aborts**.
4. For every member, in index order:
   - their current join is invalid: **abort**
   - their join is missing: wait
   - `joinHash` ≠ the roster entry: **abort** (the join changed after the roster was locked)
   - their `X` duplicates another member's: **abort**
5. Once all joins are present, compute every `Y_i`. If any `Y_i = O`: **abort**.
6. **commit** of each member: malformed, or `roster ≠ rosterHash`: **abort**.
7. Once every member has committed, compute `transcriptHash`. For each member's **reveal**:
   - malformed or an invalid point: **abort**
   - `H("commit"; …) ≠ C_i`: **abort** (commitment mismatch)
   - `pokReveal` does not verify with base `Y_i`: **abort**
   - `transcript ≠ transcriptHash`: **abort** (someone replaced a commitment)
8. When every member has a valid reveal, compute `S = Σ V_i`. If `S = O` the result is
   **UNANIMOUS YES**, otherwise **NOT UNANIMOUS**.
9. Otherwise, if `now > deadline`, the result is **No decision (incomplete)**, listing who has not finished which phase.

Abort messages name the offending member. A misbehaving participant can therefore cause an
abort, but never a wrong result:
- a veto voter would need a valid `pokReveal` for a `V` that cancels the others,
- the commitment binds `V` before anything is revealed,
- the transcript binds every view to the same set of commitments.

After a final state (result, abort or incomplete), clients erase `x`, the Nostr secret key,
the vote and the ballot from local storage.

## 7. Correctness and privacy (sketch)

`Σ_i x_i·Y_i = O` holds by construction, since each pair `x_i x_j G` appears once with `+`
and once with `−`. If everyone votes yes, `S = O`. A veto replaces `x_i·Y_i` with `c_i·Y_i`
for a random `c_i ≠ x_i`. Then `S = (c_i − x_i)·Y_i ≠ O`, because `Y_i ≠ O` and `n` is prime.

Under DDH, `x_i·Y_i` is indistinguishable from random for anyone who does not know `x_i` and
does not know all the other `x_j`. So the individual `V_i` reveal nothing beyond the final
sum, and several vetoes look the same as one. The commit round fixes every `V_i` before any
of them is revealed, which removes the last-voter advantage.

## 8. Trust assumptions and limits

- The creator controls membership: who is in the roster and duplicate exclusion. They cannot learn votes.
  Names are visible to everyone, so sock puppets are visible.
- All other participants together can determine one participant's vote.
- With 2 participants, "not unanimous" reveals the other person's vote.
- A participant who stops blocks the result until the deadline, which yields "incomplete".
- Relays learn IP addresses, timing and the `pollTag`. They do not learn the question,
  names or votes.
- Someone with access to the device can read the locally stored choice until it is wiped.
