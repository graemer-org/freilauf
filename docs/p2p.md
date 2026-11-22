# Group rides (peer-to-peer)

Freilauf group rides connect up to 8 friends directly over WebRTC data channels. There is no
game server: every rider broadcasts their own state, every client renders the others from what
it receives. A tiny, self-hostable signalling server only introduces the peers.

Code: `packages/p2p` (client, runs in the renderer) and `apps/signalling` (server, Node).

## Architecture

```
            ┌──────────────── signalling server (WebSocket, relay only) ────────────────┐
            │  rooms: code -> peers        join / peer list / peer-joined / peer-left    │
            │                              signal {to} -> signal {from}                  │
            └──────▲───────────────────────────▲───────────────────────────▲─────────────┘
                   │ SDP / ICE                  │                           │
             ┌─────┴─────┐  data channel  ┌─────┴─────┐  data channel ┌─────┴─────┐
             │  Rider A  │◄──────────────►│  Rider B  │◄─────────────►│  Rider C  │
             └─────▲─────┘                └───────────┘               └─────▲─────┘
                   └───────────────────────── data channel ─────────────────┘
```

Layers inside `@freilauf/p2p`:

| Module                    | Responsibility                                                          |
| ------------------------- | ----------------------------------------------------------------------- |
| `roomCode.ts`             | 6-char codes, input normalisation, `freilauf://join/…` links            |
| `signalling/channel.ts`   | `SignallingChannel` interface (pluggable)                               |
| `signalling/websocket.ts` | `WebSocketSignalling`: the shipped implementation, reconnects           |
| `signalling/protocol.ts`  | Client copy of the wire protocol (see "Protocol source of truth")       |
| `webrtc.ts`               | Structural WebRTC types, default STUN servers, default factory          |
| `mesh.ts`                 | `PeerMesh`: one `RTCPeerConnection` + data channel per peer             |
| `riderState.ts`           | Validation, ordering, extrapolation, smoothing, gaps                    |
| `group.ts`                | `GroupRide`: the API the app uses                                       |
| `testing/`                | Fake WebRTC, in-memory signalling, fake clock (`@freilauf/p2p/testing`) |

All host dependencies (`WebSocket`, `RTCPeerConnection`, timers, clock) are injectable; the
defaults use the renderer's globals. The package type-checks without DOM or Node libs.

### Using it

```ts
import { GroupRide, parseJoinLink } from '@freilauf/p2p';

const ride = await GroupRide.create('Anna', { signallingUrl: 'wss://signal.example.org' });
share(ride.joinLink); // freilauf://join/ABCDEF?s=wss%3A%2F%2Fsignal.example.org

// on a friend's machine
const link = parseJoinLink(input); // also accepts a bare "abc-def"
const ride = await GroupRide.join(link.roomCode, 'Ben', {
  signallingUrl: link.signallingUrl ?? DEFAULT_URL,
});

ride.setLocalState({ distanceM, speedMps, powerW, cadenceRpm, heartRateBpm, gear }); // any rate
requestAnimationFrame(() => render(ride.getRiders())); // extrapolated to "now"
ride.onChange(() => …); // riders / connections / signalling state changed
ride.leave();
```

`GroupRide.join` rejects with a `SignallingError` whose `code` is e.g. `room-full`,
`invalid-room` or `join-timeout`.

### Mesh negotiation

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

## Wire formats

### Signalling (JSON text frames over WebSocket)

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

### Data channel (`freilauf-state`, JSON text)

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
  },
}
```

~200 bytes × 4 Hz × 7 peers ≈ 6 kB/s upstream per rider.

## Limits

| What                    | Limit                                       |
| ----------------------- | ------------------------------------------- |
| Riders per room         | 8 (server rejects the 9th with `room-full`) |
| Signalling message size | 64 KiB (error); > 128 KiB closes the socket |
| Signalling rate         | burst 200, then 50 messages/s per socket    |
| Heartbeat               | ping every 30 s, dropped if no pong         |
| Name                    | 24 code points                              |
| Data-channel message    | 16 KiB at the mesh, 2 KiB for state         |

A full mesh of 8 means 7 connections per rider; that is fine for a few hundred bytes per
second each but would not scale to large groups (that would need an SFU-like relay).

## NAT traversal caveat

By default only public STUN servers are used:

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
  signallingUrl,
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
deployment use time-limited credentials (coturn's `use-auth-secret` / REST API scheme), which
the signalling server could hand out on `joined` in a future protocol version.

## Self-hosting the signalling server

See [`apps/signalling/README.md`](../apps/signalling/README.md). In short:

```sh
docker build -t freilauf-signalling apps/signalling
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 freilauf-signalling
```

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front and use the resulting
`wss://` URL in the app or in join links (`?s=`). Without Docker: Node ≥ 22.18,
`pnpm install`, `PORT=8787 node apps/signalling/src/main.ts`.

## Trust model

Trust-based, among friends: no anti-cheat, no authentication. Anyone with the room code can
join. Peers can lie about their speed, but they cannot crash or corrupt other clients' UIs —
every incoming packet is validated and bounded.

## Testing

`packages/p2p/src/testing` exports (via `@freilauf/p2p/testing`):

- `FakeRtcNetwork` — in-memory `RTCPeerConnection` pairs (pre-negotiated channels only),
  with `fail(pc)` and `blockConnectivity` to simulate trouble.
- `InMemorySignallingHub` — a `SignallingChannel` implementation with server semantics.
- `FakeClock` — deterministic `now()` + timers, `advance()` / `advanceAsync()`.

The integration tests run three `GroupRide`s through the real signalling server in-process
(`ws`) on top of `FakeRtcNetwork`.
