# Group rides (peer-to-peer) — technical reference

> This is the technical document: architecture, wire protocol, limits. **To ride with friends or
> to host rides, read the rider guide: [group-rides.md](group-rides.md).**

Freilauf group rides connect up to 8 friends directly over WebRTC data channels. There is no
game server: every rider broadcasts their own state, every client renders the others from what
it receives. Only the introduction — the WebRTC handshake — needs a third party: by default
**public Nostr relays via [Trystero](https://github.com/dmotz/trystero)** (no setup, no
Freilauf server), or, as an advanced fallback, our own self-hostable signalling server. The
decision, what we rely on in Trystero and the removal plan for the fallback are in
[ADR 0003](adr/0003-signalling-via-public-relays.md). **The relay path is not yet verified on
real networks.**

Code: `packages/p2p` (client, runs in the renderer) and `apps/signalling` (fallback server,
Node).

## Architecture

```
   public Nostr relays (run by others)              own signalling server (advanced fallback)
   encrypted handshake on a hashed topic            rooms: code -> peers, relays SDP / ICE
            ▲             ▲                                    ▲            ▲
            │ Trystero    │                                    │ WebSocket  │
      ┌─────┴─────┐ data channel ┌─────┴─────┐  data channel ┌─────┴─────┐
      │  Rider A  │◄────────────►│  Rider B  │◄─────────────►│  Rider C  │
      └─────▲─────┘              └───────────┘               └─────▲─────┘
            └──────────────────────── data channel ────────────────┘
```

A ride uses one of the two; the invite says which (see "Invites").

Layers inside `@freilauf/p2p`:

| Module                     | Responsibility                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `roomCode.ts`              | Room codes, invite secrets, `freilauf://join/…` links, parsing incl. typos                                                            |
| `transport.ts`             | `GroupTransport`: what `GroupRide` needs from the network; `GroupError`                                                               |
| `transports/relay.ts`      | `RelayTransport` (default): a Trystero room; `DEFAULT_RELAY_URLS`, app id                                                             |
| `transports/selfHosted.ts` | `SignallingMeshTransport` (fallback): signalling channel + `PeerMesh`                                                                 |
| `ice.ts`                   | Default STUN servers                                                                                                                  |
| `signalling/channel.ts`    | Fallback: `SignallingChannel` interface (pluggable)                                                                                   |
| `signalling/websocket.ts`  | Fallback: `WebSocketSignalling`, reconnects                                                                                           |
| `signalling/protocol.ts`   | Fallback: client copy of the wire protocol (see "Protocol source of truth")                                                           |
| `webrtc.ts`                | Fallback: structural WebRTC types, default factory                                                                                    |
| `mesh.ts`                  | Fallback: `PeerMesh`, one `RTCPeerConnection` + data channel per peer                                                                 |
| `riderState.ts`            | Validation, ordering, extrapolation, smoothing, gaps                                                                                  |
| `documents.ts`             | Shared documents (e.g. workouts) and synchronised start                                                                               |
| `group.ts`                 | `GroupRide`: the API the app uses                                                                                                     |
| `testing/`                 | Fake Trystero, fake WebRTC, in-memory signalling, fake clock, a harness that runs a test on both transports (`@freilauf/p2p/testing`) |

All host dependencies (Trystero, `WebSocket`, `RTCPeerConnection`, timers, clock) are
injectable; the defaults use the renderer's globals. Trystero is loaded with a dynamic
`import('trystero')` on first use (its own chunk), so nothing evaluates it at import time and
the Electron main bundle never contains it. The package type-checks without DOM or Node libs.

### Using it

```ts
import { GroupRide, parseInvite } from '@freilauf/p2p';

// Default: public relays. A new code and secret are generated.
const ride = await GroupRide.create('Anna', { relay: {} });
share(ride.joinLink); // freilauf://join/ABCDEF#GHJKMNPQRSTU
ride.inviteCode; // ABC-DEF-GHJK-MNPQ-RSTU (to read out)

// on a friend's machine
const parsed = parseInvite(input); // link, full code, legacy link or bare code; never throws
if (parsed.ok && parsed.invite.secret) {
  const ride = await GroupRide.join(parsed.invite.roomCode, 'Ben', {
    relay: { secret: parsed.invite.secret },
  });
}
// Fallback: an own signalling server (old-style links carry it as ?s=)
await GroupRide.create('Anna', { signallingUrl: 'wss://signal.example.org' });

ride.signallingState; // relays: 'connecting' until a relay answers, then 'joined'
ride.onFailure(({ code }) => …); // e.g. 'no-relay' — the ride has ended
ride.getProblems(); // [{ code: 'secret-mismatch' | 'peer-unreachable' | 'room-full', peerId, at }]
ride.onLog((line) => …); // diagnostic lines (relays open / not open, peers, failures)

ride.setLocalState({ distanceM, speedMps, powerW, cadenceRpm, heartRateBpm, gear }); // any rate
requestAnimationFrame(() => render(ride.getRiders())); // extrapolated to "now"
ride.onChange(() => …); // riders / connections / names / problems / signalling state changed

// shared documents (opaque text, e.g. encodeWorkout(w)) and a synchronised start
const shared = ride.shareDocument('workout', encodeWorkout(w)); // { ok: true, id } | { ok: false, reason }
ride.onDocument((e) => …); // { type: 'available', document } | { type: 'removed', peerId, kind, id, reason }
ride.getSharedDocuments(); // [{ peerId, peerName, kind, id, text, receivedAt }]
if (shared.ok) ride.announceStart('workout', shared.id, 10_000); // everyone else: onStart(…)
ride.onStart(({ kind, id, startsInMs }) => …);
ride.leave();
```

`GroupRide.join` rejects with a `GroupError` whose `code` is e.g. `invalid-room`,
`invalid-secret`, `no-relay` (relays failed while starting), `relay-unavailable` (library did
not load), `room-full` or, on the fallback, `join-timeout` (a `SignallingError`).

## Transports

`GroupRide` talks to a `GroupTransport` (`transport.ts`): `start(room, name)`, `getPeers()`,
`send(peerId, text)` / `broadcast(text)` (small messages, ≤ 16 KiB), `close()`, and the events
`peer-joined` (synchronous, before any message for that peer passes), `peer-left`,
`peer-updated` (name known), `status`, `message`, `state`, `problem`, `failed`, `log`.
Everything above — rider state, documents, start, `onPeerJoined` — is transport-independent;
the GroupRide test suites run on both transports (`TEST_TRANSPORTS` in `testing/harness.ts`).

### Relay transport (default)

- **Room:** `joinRoom({ appId: 'freilauf/group-ride/v1', password: <secret>, identity: 'none',
maxUsers: 8, maxReceiveBytes: 64 KiB, relayConfig: { urls, redundancy: urls.length },
rtcConfig: { iceServers: DEFAULT_ICE_SERVERS } }, <room code>)`. `identity: 'none'`: throwaway
  keys per ride, no IndexedDB, nothing that links one ride to the next.
- **Relays:** `DEFAULT_RELAY_URLS` (8 relays pinned from Trystero 0.27's list; see the ADR),
  replaceable in Settings → Group (advanced). `redundancy` is set explicitly because Trystero
  otherwise uses only the first 5 of a custom list.
- **State:** `connecting` until a relay socket is open (`getRelaySockets()`, polled every
  250 ms), then `joined`; `reconnecting` if all are lost later (connected peers are unaffected).
  **Failure `no-relay`:** Trystero's `relay-failed` (every relay failed its first attempt), or no
  relay open after 15 s (a hanging connection never fails by itself).
- **Peers:** `onPeerJoin` → record created, `peer-joined` emitted (name unknown), our `fl-hello`
  `{ "v": 1, "name": … }` sent to that peer, then `status: connected` (which makes `GroupRide`
  send its state and document list). A message from a peer we have not announced yet would
  announce it first — Trystero does not deliver messages before `onPeerJoin`, but the ordering
  rule must not depend on that. `onPeerLeave` → `peer-left`.
- **Messages:** one action `fl-msg`, strings only, the same JSON messages as on the mesh
  channel. ≤ 16 KiB each, sent as one inline frame; larger outgoing messages are refused,
  incoming ones are rejected by an `onReceive` gate. At most 64 sends per peer may be queued in
  Trystero (it waits while the channel's `bufferedAmount` is above 64 KiB); further sends return
  false.
- **Problems:** `decrypt-failed` → `secret-mismatch`, `peer-connect-failed` →
  `peer-unreachable`, `room-full` → fatal if we have no peer yet, otherwise a problem.

**Reliability.** Trystero's data channel is reliable and ordered (browser defaults), unlike the
mesh's unreliable, unordered one. The document protocol is pull-based with retries and works
unchanged: on a reliable channel the retries just never fire. The cost is head-of-line
blocking: a 4 Hz state packet queues behind document chunks already sent. The sharer serves at
most 48 KiB in a burst and 24 KiB/s per peer in ≤ 1100-byte messages, so a state packet waits at
most behind ~48 KiB once (≈ 0.4 s at 1 Mbit/s, ≈ 0.04 s at 10 Mbit/s) and behind ≤ 24 KiB/s
afterwards — and only while a document is being fetched.

### Invites

| Form                           | Example                                  | Transport                                |
| ------------------------------ | ---------------------------------------- | ---------------------------------------- |
| Relay invite link              | `freilauf://join/ABCDEF#GHJKMNPQRSTU`    | relays, secret after `#`                 |
| Full invite code (to read out) | `ABC-DEF-GHJK-MNPQ-RSTU`                 | relays (18 symbols; also in a link path) |
| Old-style link                 | `freilauf://join/ABCDEF?s=wss%3A%2F%2F…` | that signalling server                   |
| Bare room code                 | `ABC-DEF`                                | own server only (no secret)              |

The secret is 11 random symbols of the room-code alphabet (≈ 54 bits) plus a check symbol
`Σ (i+1)·value(sᵢ) mod 31` over code and secret: it catches every single wrong symbol and every
swap of neighbours, so `parseInvite` reports `typo` instead of opening another room. The relays
see `SHA-256(["Trystero", appId, code])` — enough to guess the 6-character code — but the
handshake key is PBKDF2(secret, 600 000 iterations), so they cannot read or join without the
secret. A bare code therefore cannot join a relay ride; the app asks for the whole invite.

### Self-hosted transport (advanced fallback)

The signalling server and `PeerMesh`, described below, unchanged.

### Mesh negotiation (fallback transport)

- **Offerer rule (no glare):** for each pair, the peer with the lexicographically smaller peer
  id creates the connection and sends the offer; the other only answers.
- **One data channel**, pre-negotiated on both sides (`negotiated: true, id: 0`),
  `ordered: false, maxRetransmits: 0` — state packets are fire-and-forget; a lost packet is
  superseded 250 ms later anyway.
- **Trickle ICE:** candidates are sent as they are gathered. Local candidates wait until our
  offer/answer has been sent; remote candidates that arrive before the remote description are
  queued. All signalling work per peer runs through one promise queue, so ordering holds.
- **Generations:** every connection attempt by the offerer bumps `gen`; signals from older
  generations are ignored.
- **Failure handling — tear down and re-offer:** a connection counts as failed when ICE reports
  `failed`, stays `disconnected` for 8 s, the data channel closes, or the channel is not open
  within 20 s. It is closed; the offerer starts a fresh connection after 1 s, 2 s, 4 s, …
  (max 30 s) for as long as the peer is in the room. If the answering side notices first, it
  sends a `restart` signal. ICE restarts on the existing connection are deliberately not used
  (simpler, and the fresh connection gets fresh candidates anyway).
- **Membership** follows the signalling server: `peer-left` (or absence from the peer list
  after a signalling reconnect) closes the connection and removes the rider.
- **Status per peer:** `connecting` | `connected` (channel open) | `disconnected` | `failed`,
  via `ride.getPeers()` / `mesh.getPeers()` and the `status` event.

### Remote state handling

- Every rider broadcasts its state at **4 Hz** (and once immediately when a channel opens).
  The local distance is extrapolated between `setLocalState` calls (capped at 2 s).
- Incoming packets are **validated defensively**: JSON ≤ 2 KiB, exact message shape, all numbers
  finite and in sane ranges (distance 0–10 000 km, speed 0–50 m/s, power 0–4000 W, cadence
  0–300 rpm, heart rate null or 0–300, gear 0–100), names stripped of control/bidi characters
  and cut to 24 code points. Anything else is dropped silently.
- **Ordering** uses only the sender's `sentAt`, compared against that same sender's previous
  value: older or equal packets are dropped. A jump backwards by more than 5 s is treated as a
  clock reset on the sender and accepted. Clocks are never compared across peers.
- **Extrapolation** uses the local receive time: `distance + speed × (now − receivedAt)`,
  capped at 2 s, so a silent rider stops after 2 s instead of riding away.
- **Smoothing:** when a packet disagrees with what we were displaying, the difference is kept as
  an offset that decays exponentially (τ = 600 ms) — riders glide instead of jumping. Errors
  above 100 m snap.
- **Stale:** no packet for 3 s → `stale: true`. Riders are removed when the peer leaves.
- `getRiders(now)` returns the remote riders sorted leader-first, with `gapM` = their displayed
  distance minus the local rider's (extrapolated) distance. The local rider is not included.
  When both riders send the same `route.id`, `gapM` is measured along the route instead
  (`sameRoute: true`; the shorter way round on a loop), so riders at the same place on the road
  are side by side whatever distance each has ridden (docs/routes.md, "Choosing where to start, and jumping"). The local
  route's length and kind are passed to `setLocalState` as `routeShape` (not broadcast).

## Wire formats

### Signalling (fallback transport; JSON text frames over WebSocket)

Client → server:

```jsonc
{ "type": "join", "room": "ABCDEF", "peerId": "k3j…", "name": "Anna" }
{ "type": "signal", "to": "<peerId>", "data": <any JSON> }
{ "type": "leave" }
```

Server → client:

```jsonc
{ "type": "joined", "room": "ABCDEF", "peerId": "k3j…", "peers": [{ "peerId": "…", "name": "Ben" }] }
{ "type": "peer-joined", "peer": { "peerId": "…", "name": "Cleo" } }
{ "type": "peer-left", "peerId": "…" }
{ "type": "signal", "from": "<peerId>", "data": <any JSON> }
{ "type": "error", "code": "room-full", "message": "Room ABCDEF is full (max 8 riders)." }
```

Error codes: `invalid-message`, `invalid-room`, `invalid-peer-id`, `invalid-name`, `room-full`,
`already-joined`, `not-joined`, `unknown-peer`, `message-too-large`, `rate-limited`. The client
treats `invalid-room`, `invalid-peer-id`, `invalid-name`, `room-full` and `already-joined` as
fatal (no reconnect). Close code `4000` means "replaced": another connection joined with the
same peer id (that is how a reconnecting client takes over its own slot silently).

Validation: room `^[A-Z0-9]{4,16}$`, peer id `^[A-Za-z0-9_-]{4,64}$` (clients use 16 random
`[a-z0-9]`), name 1–24 code points.

The `data` of a `signal` is opaque to the server. `PeerMesh` sends:

```jsonc
{ "kind": "offer",     "gen": 3, "sdp": "v=0…" }
{ "kind": "answer",    "gen": 3, "sdp": "v=0…" }
{ "kind": "candidate", "gen": 3, "candidate": { "candidate": "candidate:…", "sdpMid": "0", "sdpMLineIndex": 0, "usernameFragment": "…" } }
{ "kind": "restart",   "gen": 3 }
```

#### Protocol source of truth

`apps/signalling/src/protocol.ts` defines the protocol. The client keeps a structurally
identical copy in `packages/p2p/src/signalling/protocol.ts` (the client runs in a browser, the
server under Node; neither depends on the other at runtime).
`packages/p2p/src/signalling/protocol.test.ts` imports the server's file (via the
`@freilauf/signalling/protocol` export, a devDependency) and asserts type equality at compile
time plus identical constants at runtime; the integration tests round-trip against the real
server. Change both files together.

### Data messages (JSON text)

The same messages travel on the mesh's `freilauf-state` channel (fallback) and in the relay
transport's `fl-msg` action (default). The relay transport additionally sends one `fl-hello`
action per peer, `{ "v": 1, "name": "Anna" }`, which never reaches `GroupRide`.

```jsonc
{
  "v": 1,
  "type": "state",
  "state": {
    "name": "Anna",
    "sentAt": 1763820000000, // sender's clock, epoch ms; only used for ordering
    "distanceM": 12034.5,
    "speedMps": 9.8,
    "powerW": 215,
    "cadenceRpm": 88,
    "heartRateBpm": 141, // or null
    "gear": 11,
    "route": { "id": "a1b2c3d4", "m": 42312.5 }, // optional: route id and position on it (m)
  },
}
```

~200 bytes × 4 Hz × 7 peers ≈ 6 kB/s upstream per rider.

Every message on the channel is a JSON object with `"v"` and `"type"`. Receivers dispatch on
`type` and **silently ignore unknown types and versions** — that is the forward-compatibility
rule. The `state` decoder rejects every `doc-*` message (wrong `type`), the document decoder
rejects `state`, so old clients that only know `state` interoperate with new ones (they simply
never see documents), and new clients do not send any `doc-*` traffic until something is shared.

### Shared-document messages (`doc-*`)

Short keys keep chunks small. `k` = kind, `id` = content hash, `n` = UTF-8 bytes of the text,
`c` = chunk count.

```jsonc
// sharer → everyone: what I share right now. On every change, then once per second
// (only once the rider has shared anything in this session). An empty list = withdrawn.
{ "v": 1, "type": "doc-list", "sid": "q8x0…", "rev": 3,
  "docs": [{ "k": "workout", "id": "9c1e04a3b7f2d815", "n": 2483, "c": 3 }] }
// receiver → sharer: send me (the listed / all) chunks. `m` omitted = all chunks.
{ "v": 1, "type": "doc-req", "k": "workout", "id": "9c1e04a3b7f2d815", "m": [0, 2] }
// sharer → receiver: one piece of the text (pieces concatenate to the document).
{ "v": 1, "type": "doc-chunk", "k": "workout", "id": "9c1e04a3b7f2d815", "n": 2483, "c": 3, "i": 0, "d": "{\"format\":…" }
// announcer → everyone: announcement `a` — document `id` starts `in` ms after this was sent.
{ "v": 1, "type": "doc-start", "a": "m2k9…", "k": "workout", "id": "9c1e04a3b7f2d815", "in": 9750 }
```

Field rules (anything else drops the message): `k` matches `^[a-z0-9][a-z0-9-]{0,31}$`; `id` is
16 lower-case hex digits; `sid`/`a` match `^[a-z0-9]{4,16}$`; `rev` ≥ 1; `1 ≤ n ≤ 16384`;
`1 ≤ c ≤ min(128, n)`; `0 ≤ i < c`; `d` a non-empty string; `m` 1–128 integers in `0..127`;
`0 ≤ in ≤ 600000`; at most 16 list entries, no duplicate kinds. Extra fields are ignored.

## Shared documents

A small, generic mechanism that works on the unreliable mesh channel (and therefore unchanged on
the relay transport's reliable one) — no second channel. The
app decides what a document means; `@freilauf/p2p` treats the text as opaque. Workouts are
shared as `kind: 'workout'` with `encodeWorkout(w)` as text and must be decoded (and thereby
validated) with `decodeWorkout` on receipt (see `docs/workouts.md`).

**API** (on `GroupRide`):

```ts
shareDocument(kind: string, text: string): ShareResult; // { ok: true; id } | { ok: false; reason }
unshareDocument(kind: string): boolean;
getLocalDocuments(): LocalDocument[];   // { kind, id, text }
getSharedDocuments(): SharedDocument[]; // { peerId, peerName, kind, id, text, receivedAt }
onDocument(listener: (e: DocumentEvent) => void): Unsubscribe;
//   { type: 'available'; document: SharedDocument }
//   { type: 'removed'; peerId; kind; id; reason: 'withdrawn' | 'replaced' | 'peer-left' }
announceStart(kind: string, id: string, inMs: number): StartResult; // { ok: true; announceId; startsAt } | { ok: false; reason }
onStart(listener: (s: StartAnnouncement) => void): Unsubscribe;
//   { announceId, peerId, peerName, kind, id, startsInMs, startsAt } (local clock)
getStartAnnouncements(): StartAnnouncement[]; // refined estimates, kept until 10 s after the start
onPeerJoined(listener: (peer: { peerId; name }) => void): Unsubscribe; // synchronous, see below
```

Share rejections: `invalid-kind`, `invalid-text`, `empty`, `too-large`, `too-many-documents`,
`too-many-bytes`, `too-many-chunks`, `closed`. A rejected call changes nothing and sends
nothing. Re-sharing identical text is a no-op; different text replaces the document of that
kind. Receivers only ever expose complete, hash-verified documents; when a sharer replaces a
document, the old one is removed at once (`reason: 'replaced'`) and the new one becomes
`available` when it has arrived.

### Peer-join ordering

`onPeerJoined` fires **synchronously** from the event in which the transport first learns of a
peer, before any message can be exchanged with it through the ride. Fallback mesh: signalling
`peers` / `peer-joined`, or a first signal from an unknown member — before that peer's data
channel can exist, because opening it needs further signalling round-trips. Relay transport:
`onPeerJoin`, or a first message from an unannounced peer — the transport emits `peer-joined`
before it lets any message from or to that peer through (see "Relay transport"). Since a
sharer only ever answers `doc-req` for its **current** id of a kind (stale ids are ignored, and
chunks are sent only to the requesting peer, never broadcast), a document replaced or withdrawn
inside the listener can never reach the newcomer: the first `doc-list` it gets is the one sent
when its channel opens, listing the replaced documents. Apps that publish per-audience content
(the community sync, see `docs/community.md`) narrow what they share in this listener.
`groupPeerJoin.test.ts` checks this on both transports — for both offer directions with delays,
duplicates, loss and reordering (fallback), with delays and with the newcomer's messages arriving
before the host's `onPeerJoin` (relays), and while another peer is still fetching the old
version; a control case shows the newcomer does get the old document without the reshare. The
community no-leak tests (`communitySync.integration.test.ts`) also run on both. (`onChange` also fires synchronously
for the same event, via the `connecting` status, but `onPeerJoined` is the documented contract.)

### Delivery algorithm

1. **Content id.** `id` is a 64-bit non-cryptographic hash (cyrb53-style, two 32-bit lanes over
   the UTF-16 code units, `contentHash()`): integrity against corruption and mismatched pieces,
   not against tampering (peers are trusted).
2. **Announce.** A sharer broadcasts `doc-list` immediately on every change and then once per
   second (not with every 4 Hz state packet), and sends it directly to any peer whose channel
   (re)opens — so late joiners and reconnecting peers learn about documents automatically.
   `sid` (random per `GroupRide`) + `rev` (incremented per change) order lists: a list with the
   same `sid` and a `rev` not newer than the last one is a duplicate or arrived out of order.
3. **Diff.** A receiver compares the list with what it holds for that peer: documents no longer
   listed (or listed with another id) are removed and `onDocument` fires; every new id becomes a
   transfer (within the per-peer caps, in list order).
4. **Request with backoff.** For each transfer the receiver sends `doc-req` (all chunks, later
   only the missing indices), and repeats it after 300 ms, doubling to at most 1.2 s. A received
   chunk resets the backoff (the next request goes out 300 ms after the last chunk, i.e. when the
   burst is over). A repeated `doc-list` that still lists a missing id also triggers a request
   (at most one per 300 ms), so a long backoff never stalls delivery while the sharer is alive.
   At most 16 transfers (over all peers) send requests at once; the rest wait for a slot.
5. **Serve, rate-limited.** The sharer answers a request for its _current_ id of that kind with
   the requested chunks (stale ids are ignored — the next list corrects the requester), limited
   per requesting peer by a token bucket (burst 48 KiB, refill 24 KiB/s). Chunks over budget are
   skipped; the requester asks again for what is missing.
6. **Assemble and verify.** Chunks are accepted only for an expected transfer with matching
   `k`/`id`/`n`/`c`; duplicates are ignored. When all `c` pieces are there, the text must have
   exactly `n` UTF-8 bytes and hash to `id`; otherwise the pieces are discarded and the transfer
   starts over. On success the document is stored and `available` fires.
7. **Leave.** When the sharer leaves the room (`peer-left`), all its documents (and pending
   transfers and start announcements) are dropped and `removed` fires with `reason: 'peer-left'`.
   A merely disconnected peer keeps its documents; pending requests resume when its channel
   reopens.

**Chunking.** Chunks are cut at code-point boundaries so that every `doc-chunk` message is at
most `documentMessageMaxBytes` UTF-8 bytes (default **1100**, minimum 200; JSON escaping is
accounted for). The default deliberately fits one SCTP packet rather than the 16 KiB mesh limit:
with `maxRetransmits: 0` a message spread over several packets is lost if any of them is, so a
single 16 KiB message would almost never survive heavy loss, while 1 KiB chunks are recovered
individually. A typical workout (0.7–3 kB) is 1–4 chunks; a 16 KiB document ≈ 17 chunks, worst
case (heavily escaped text) up to the cap of 128 chunks, beyond which sharing fails with
`too-many-chunks`.

Bandwidth: a list is ~120 bytes/s per sharer and peer; a transfer is the document once plus
lost chunks and ~80-byte requests.

### Synchronised start

`announceStart(kind, id, inMs)` does not rely on synchronised clocks. It broadcasts `doc-start`
with the **remaining** delay at send time, and re-sends it every 250 ms (up to 8 times, only
while the start is still ahead) with the updated remaining delay; a peer whose channel opens
during the countdown gets it directly. The receiver estimates the start as
`receivedAt + in` on its own clock, de-duplicates by (`peerId`, `a`), fires `onStart` **once**
(with `startsInMs = in` of the first copy) and afterwards only refines the estimate: since
transit delay can only make an estimate late, the earliest estimate is kept; estimates more than
2 s away from the first one are ignored as inconsistent. `getStartAnnouncements()` returns the
refined values. With one lost packet the next copy arrives 250 ms later carrying a correct
remaining delay, so the error is the one-way latency of the copy used, not the loss. The
announcer's own `onStart` listeners are not called (use the returned `startsAt`). The id does
not have to be one of the announcer's own documents. There is no "cancel" message yet.

### Defensive handling

- Every incoming message is size-checked (≤ 16 KiB, as the mesh), parsed in `try`, and
  validated field by field (see the field rules above); handlers run in `try` and never throw.
- Per remote rider at most **4 kinds** and **32 KiB** of documents are kept (further list entries
  are not fetched); at most **128 chunks** per document, **16** concurrent transfers in total,
  **8** remembered start announcements per peer (older ones dropped, all forgotten 10 s after
  their start).
- Unsolicited, duplicate or inconsistent chunks, lists with duplicate kinds, requests for unknown
  documents and out-of-order lists are ignored. The same caps apply to what the local rider may
  share (4 kinds, 16 KiB each, 32 KiB in total).

## Limits

| What                    | Limit                                              |
| ----------------------- | -------------------------------------------------- |
| Riders per room         | 8 (`room-full` for the 9th, both transports)       |
| Signalling message size | 64 KiB (error); > 128 KiB closes the socket        |
| Signalling rate         | burst 200, then 50 messages/s per socket           |
| Heartbeat               | ping every 30 s, dropped if no pong                |
| Name                    | 24 code points                                     |
| Data-channel message    | 16 KiB (mesh and relay transport), 2 KiB for state |
| Relay connect timeout   | 15 s, then `no-relay`                              |
| Shared document         | 16 KiB UTF-8, kind `[a-z0-9-]`, ≤ 32 chars         |
| Documents per rider     | 4 kinds, 32 KiB in total                           |
| Document chunks         | ≤ 1100 bytes each (default), ≤ 128 per doc         |
| Concurrent transfers    | 16 (all peers)                                     |
| Serving rate per peer   | 48 KiB burst, then 24 KiB/s                        |
| Start delay             | 0 – 10 min                                         |

A full mesh of 8 means 7 connections per rider; that is fine for a few hundred bytes per
second each but would not scale to large groups (that would need an SFU-like relay).

## NAT traversal caveat

On both transports, by default only public STUN servers are used:

- `stun:stun.l.google.com:19302`
- `stun:stun.cloudflare.com:3478`

STUN lets peers discover their public address, which works for most home routers. It does
**not** work when both sides — or one side, depending on the other's NAT — are behind a
**symmetric NAT** (common on mobile carriers / CGNAT and some corporate or university
networks). Those pairs stay `connecting` and then cycle through `failed` retries.

The fix is a TURN relay. Freilauf does not ship one, but any standard TURN server (e.g.
[coturn](https://github.com/coturn/coturn)) can be configured through `iceServers`:

```ts
await GroupRide.join(code, name, {
  relay: { secret }, // or signallingUrl
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'],
      username: 'freilauf',
      credential: '…',
    },
  ],
});
```

TURN relays all traffic of affected pairs through that server (still end-to-end encrypted by
DTLS). Static credentials embedded in a client are visible to every user; for a public
deployment use time-limited credentials (coturn's `use-auth-secret` / REST API scheme). There
is no UI for it; on the relay transport the servers go into Trystero's `rtcConfig`.

## Self-hosting the signalling server (fallback)

Only needed with "Use my own signalling server" (Settings → Group, advanced). See [`apps/signalling/README.md`](../apps/signalling/README.md). In short:

```sh
docker build -t freilauf-signalling apps/signalling
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 freilauf-signalling
```

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front and use the resulting
`wss://` URL in the app or in join links (`?s=`). Without Docker: Node ≥ 22.18,
`pnpm install`, `PORT=8787 node apps/signalling/src/main.ts`.

## Trust model

Trust-based, among friends: no anti-cheat, no authentication. Anyone with the whole invite
(relays) or the room code (own server) can join. Peers can lie about their speed, but they cannot crash or corrupt other clients' UIs —
every incoming packet is validated and bounded.

## Testing

`packages/p2p/src/testing` exports (via `@freilauf/p2p/testing`):

- `FakeTrysteroNetwork` — in-memory stand-in for Trystero's `joinRoom` (`moduleFor(peerId)`):
  rooms by app id + room id, `decrypt-failed` for different passwords, reliable ordered links
  with `conditions.maxDelayMs`, `joinSkewMs` (messages before `onPeerJoin`), `relaysReachable`
  / `relaysFailFast` / `restoreRelays()`, `blockDirect` (`peer-connect-failed`), `room-full`.
- `createTestNetwork(kind, { clock, seed })` and `TEST_TRANSPORTS` — run a GroupRide test on
  `self-hosted` and `relays` alike (`create`, `join`, `setConditions`, `sentMessages`, `inject`).

- `FakeRtcNetwork` — in-memory `RTCPeerConnection` pairs (pre-negotiated channels only),
  with `fail(pc)` and `blockConnectivity` to simulate trouble, and `conditions`
  (`{ lossRate, duplicateRate, maxDelayMs }`, seeded PRNG via `new FakeRtcNetwork({ seed,
timers })`; delays need the fake clock's timers and reorder messages) for data-channel loss,
  duplication and reordering. `dropped` counts lost messages.
- `InMemorySignallingHub` — a `SignallingChannel` implementation with server semantics.
- `FakeClock` — deterministic `now()` + timers, `advance()` / `advanceAsync()`.

`relayTransport.test.ts` covers the relay transport itself (config, names, ordering, relay
failure fast and by timeout, reconnecting, wrong secret, no direct path, full room, limits) and
checks that the pinned relays are in the installed Trystero's list. Nothing here talks to real
relays. The integration tests run three `GroupRide`s through the real signalling server in-process
(`ws`) on top of `FakeRtcNetwork`. `groupDocuments.test.ts` covers shared documents and the
synchronised start, including 40 % loss with reordering and duplicates over several fixed seeds
(across 300 seeds, four riders converged in median ≈ 5 s, worst 16 s simulated time; the test
allows 20 s).
