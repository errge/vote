export function How() {
  return (
    <article class="card prose">
      <button type="button" class="btn small ghost" onClick={() => (history.length > 1 ? history.back() : (location.hash = '#/'))}>
        ← Back
      </button>
      <h1>How it works &amp; privacy</h1>

      <h2>What you get</h2>
      <p>
        A group answers one yes/no question. The only outcome is one bit: <b>unanimous yes</b> or <b>not unanimous</b>.
        Nobody, not even someone recording all network traffic or poking around with the browser’s developer tools,
        learns who said no or how many did. The only exception is if <i>all</i> other participants work together
        against one person.
      </p>

      <h2>No server</h2>
      <p>
        This page is a static website. All poll messages travel through several public{' '}
        <a href="https://nostr.com" target="_blank" rel="noopener noreferrer">
          Nostr
        </a>{' '}
        relays. Every message is encrypted with a key derived from the secret part of the link (after the <code>#</code>
        , which browsers never send to the web server). Relays only see opaque encrypted data and a random-looking poll
        tag.
      </p>

      <h2>The voting math, in plain words</h2>
      <p>
        The protocol is the <i>Anonymous Veto Network</i> (Hao &amp; Zieliński, 2006), with an extra commit round. It
        runs in three steps:
      </p>
      <ol>
        <li>
          <b>Join.</b> Each person’s browser picks a secret random number and publishes a matching public key, with a
          proof that it really knows the secret. The organizer then locks the group, which fixes who takes part and in
          which order.
        </li>
        <li>
          <b>Commit.</b> Every browser combines its own secret with everybody else’s public keys. A <i>yes</i> uses the
          secret itself. A <i>no</i> uses a fresh random number instead. The result is a “vote share” that looks
          completely random to everyone else. At first the browser publishes only a sealed fingerprint of its share
          (a commitment). That way nobody can wait to see the outcome before deciding.
        </li>
        <li>
          <b>Reveal.</b> Once everyone has committed, every browser opens its share together with a proof that it was
          made correctly. The shares are designed so that, if everyone used their secret (all <i>yes</i>), they cancel
          out exactly. A single <i>no</i> leaves a random leftover, and you cannot tell whose share caused it.
        </li>
      </ol>
      <p>
        Every browser checks every proof and commitment itself. If anything doesn’t add up (a forged proof, a changed
        commitment, a modified join, inconsistent views), the poll <b>aborts</b> and names the participant whose
        message failed. Cheating can only stop a poll, never produce a wrong result.
      </p>

      <h2>What is protected</h2>
      <ul>
        <li>
          Individual votes stay hidden. A yes share and a no share are indistinguishable, which rests on a standard
          cryptographic assumption (Decisional Diffie–Hellman on secp256k1).
        </li>
        <li>Only the one-bit outcome is revealed, never a count.</li>
        <li>
          One vote per group member. Ballot stuffing is impossible: every share is tied to a member of the locked
          group.
        </li>
        <li>Nobody can see the outcome before their own vote is fixed (commit round).</li>
      </ul>

      <h2>Trust in the organizer</h2>
      <p>
        The person who creates the poll decides who is in the group (they lock the group, and can drop duplicates).
        They <b>cannot</b> learn anyone’s vote. Everyone sees the names in the group, so invented extra participants
        would be noticed.
      </p>

      <h2>Known limits</h2>
      <ul>
        <li>If all the other participants collude, they can work out whether a particular person said no.</li>
        <li>
          With only 2 people, a “not unanimous” result tells each person what the other voted. That is unavoidable for
          any method.
        </li>
        <li>
          Anyone who stops participating blocks the result until the deadline, which then shows “no decision”. That
          reveals which step each person did not finish, but no votes.
        </li>
        <li>Relays can see IP addresses and timing of connections.</li>
        <li>
          Someone with access to your device could read your stored choice while the poll runs. Secrets are erased from
          the device once the poll is finished.
        </li>
        <li>
          Your poll keys live in this browser only. If you switch device or browser, or clear site data, you cannot
          continue that poll.
        </li>
        <li>Names are visible to the whole group. Only votes are secret.</li>
      </ul>

      <h2>Why do I have to open the link again?</h2>
      <p>
        There is no server to do things on your behalf. Your vote share can only be revealed by your own browser, and
        only after everyone has committed. If your page is open it happens automatically. Otherwise it happens the next
        time you open the link.
      </p>
    </article>
  );
}
