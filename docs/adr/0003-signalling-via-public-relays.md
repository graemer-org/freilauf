# ADR 0003 — Group-ride signalling via public relays (Trystero)

Status: accepted, **not yet verified on real networks** · 2026-11-22

## Context

Group riders connect directly over WebRTC, but to set up a connection two apps must first
exchange a short handshake (SDP offer/answer, ICE candidates). Until now that went through our
own signalling server (`apps/signalling`, also served by the Docker web build at `/signal`),
which one person in the group had to run and make reachable from the internet over HTTPS. The
maintainer tried exactly that and did not get it working; the decision was: "Let's build in
Trystero. Then we don't need our own signalling server at all."

[Trystero](https://github.com/dmotz/trystero) (npm `trystero` 0.27.0, MIT) does the handshake
over existing public infrastructure. Its default strategy, which is the one installed
(`trystero` re-exports `@trystero-p2p/nostr`), uses public **Nostr relays**: WebSocket servers
run by many independent operators that pass small signed events between subscribers.

What we rely on, as read in the installed package (`packages/p2p/node_modules/trystero/`,
`node_modules/.pnpm/@trystero-p2p+core@0.27.0/…/dist/`, `@trystero-p2p+nostr@0.27.0/…/dist/`):

| Topic               | Fact (file)                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                 | `joinRoom({ appId, password, identity, maxUsers, maxReceiveBytes, relayConfig: { urls, redundancy }, rtcConfig, turnConfig }, roomId)` returns a room synchronously (`types.d.mts`, `internal-types.d.mts`).                                                                                              |
| Topic on the relays | `SHA-256(JSON ["Trystero", appId, roomId])` (base64url) as a Nostr `x` tag (`strategy.mjs` `topicFor`, `crypto.mjs` `hashTopic`). The password is **not** part of it.                                                                                                                                     |
| Encryption          | Offers/answers are AES-256-GCM encrypted. With a `password` the key comes from PBKDF2-SHA256 (600 000 iterations, salt from app id + room id) + HKDF; without one it is `SHA-256(app id, room id)` — derivable by anyone who knows the room (`crypto.mjs` `genKey`, `derivePasswordRoomKeys`).            |
| Wrong password      | The other side cannot decrypt: `onError({ code: 'decrypt-failed', peerId, stage })` (`signal-handler.mjs`).                                                                                                                                                                                               |
| Relays              | 30 built-in URLs (`defaultRelayUrls`); by default 5 chosen by a shuffle seeded with the app id. `relayConfig.urls` replaces the list, but **`redundancy` still caps how many are used (default 5)** (`relay-manager.mjs` `getRelays`).                                                                    |
| Relay failure       | When every relay fails its first connection attempt: `onError({ code: 'relay-failed' })` (`strategy.mjs` `reportAllRelaysFailed`). A connection that hangs never fails by itself. `getRelaySockets()` exposes the sockets (`nostr/dist/index.mjs`).                                                       |
| Peers               | `onPeerJoin` / `onPeerLeave` with a `peerId`; `getSelf()` resolves our own `peerId` (async). Messages are only delivered from active peers (`handshake.mjs` `canReceiveFromPeer`). `peer-connect-failed` when no ICE path is found (`signal-handler.mjs`); `room-full` with `maxUsers` (`room.mjs`).      |
| Data channel        | One `createDataChannel('data')` per peer with browser defaults — **reliable and ordered** (`peer.mjs`). Actions ≤ 16 KiB go out as one frame; larger ones are chunked transfers. Sends wait while `bufferedAmount` > 64 KiB (`action-wire.mjs`, `peer-transport.mjs`). Default `maxReceiveBytes` 256 MiB. |
| ICE                 | Default 3 Google STUN servers + Cloudflare STUN; `rtcConfig.iceServers` replaces them, `turnConfig` adds TURN (`peer.mjs`). No TURN is built in.                                                                                                                                                          |
| Identity            | `identity: 'local'` (default) keeps a keypair in IndexedDB; `'none'` uses throwaway keys (`identity.mjs`).                                                                                                                                                                                                |
| Node / SSR safety   | Importing `trystero` in Node 22 works (no browser globals at import); module-level state only (`new Map()`, relay manager). Runtime needs `WebSocket`, WebCrypto, `RTCPeerConnection`.                                                                                                                    |
| Network             | Only `wss://` WebSockets to the relays and WebRTC (STUN/ICE). No `fetch`, no workers, no `eval`, no remote scripts (checked by grep and by the web e2e test).                                                                                                                                             |

## Decision

1. **Public relays are the default and the only path in the normal UI.** `GroupRide` runs on a
   small transport interface (`packages/p2p/src/transport.ts`). The new `RelayTransport`
   (`transports/relay.ts`) implements it on a Trystero room; the old signalling server + mesh
   becomes `SignallingMeshTransport` (`transports/selfHosted.ts`). Rider state, shared
   documents, the synchronised start and the `onPeerJoined` ordering are unchanged above it.
   Trystero is reached through an injected, structurally typed module (`TrysteroModuleLike`),
   loaded with `import('trystero')` on first use — a separate renderer chunk; the Electron main
   and preload bundles never contain it (`build/check-bundle.mjs`).
2. **App id** `freilauf/group-ride/v1`; **room id** = the six-character room code.
3. **Secret.** Every relay ride has a secret: 11 random symbols of the room-code alphabet
   (≈ 54 bits) plus a check symbol over code and secret. It is the Trystero `password`. The
   relays see only the topic hash (from which a 6-character code can be brute-forced — 31⁶ ≈
   887 million) and AES-GCM ciphertext under a key derived from the secret, which they never
   see. Offline guessing is 2⁵⁴ × 600 000 PBKDF2 iterations: out of reach.
   - **Invite format:** `freilauf://join/ABCDEF#GHJKMNPQRSTU` (link) or `ABC-DEF-GHJK-MNPQ-RSTU`
     (18 symbols, to read out). The check symbol catches every single wrong symbol and every swap
     of neighbours locally ("The invite has a typo").
   - **A bare six-character code cannot join a relay ride.** It carries no secret, and a secret
     derived from the code would be no secret at all (the relay can guess the code from the
     topic). The app says so plainly and asks for the whole invite. With the advanced own-server
     option, a bare code still works there, as before.
   - Old links `freilauf://join/ABCDEF?s=<server>` keep working: they go to that server.
4. **Relays.** Eight URLs, pinned in `DEFAULT_RELAY_URLS` instead of Trystero's app-id shuffle,
   so that Freilauf builds with different Trystero versions still meet on the same relays (a
   test asserts they are all in the installed `defaultRelayUrls`): `relay.primal.net`,
   `relay.snort.social`, `nostr-pub.wellorder.net`, `relay.nostr.net`, `relay.ditto.pub`,
   `nostr.data.haus`, `yabu.me`, `relay.nostrhub.fr` — general-purpose relays of different
   operators. We pass `redundancy: 8` so that all of them are used (more than Trystero's 5:
   one shared working relay is enough to meet). The choice could not be tested from here.
   Overridable in Settings → Group (advanced); everyone in a ride needs one relay in common.
5. **"No relay reachable"** is a distinct failure: Trystero's `relay-failed`, or no relay socket
   open after 15 s (covers silently dropped connections). Shown as "No relay server reachable"
   with what to try; `navigator.onLine === false` shows "You appear to be offline" instead.
6. **ICE:** our two public STUN servers (`DEFAULT_ICE_SERVERS`) for both transports; TURN can
   be added through `GroupRideDeps.iceServers` (no UI).
7. **Names:** the signalling join carried them; relays have no such step, so each side sends a
   `fl-hello` action with its name when a peer joins. `onPeerJoined` fires before it arrives
   (name `Rider`); `getPeers()` has `name: ''` until then, and `onChange` fires when it comes.
8. **Peer-join ordering** (no-leak rule of the community sync): the relay transport emits
   `peer-joined` synchronously the first time it hears of a peer — from `onPeerJoin`, or from a
   message if one ever arrived first — before it lets any message from or to that peer through,
   and reports `connecting` → `connected` in the same call.
9. **Messages:** one `fl-msg` action for all data messages (state, `doc-*`), as strings, each
   ≤ 16 KiB (inline frame; we refuse larger ones and gate incoming ones at 16 KiB,
   `maxReceiveBytes` 64 KiB). The pull-based document protocol is kept as it is: on a reliable
   channel its retries simply never fire. Backpressure: at most 64 sends per peer may be queued
   inside Trystero; beyond that `send` returns false and the caller's own resend covers it.
   4 Hz state behind a document: the sharer serves at most 48 KiB in a burst and 24 KiB/s per
   peer (`DOC_SERVE_BUDGET`), in ≤ 1100-byte messages, so a state packet waits behind at most
   ~48 KiB once (≈ 0.4 s at 1 Mbit/s upstream, ≈ 0.04 s at 10 Mbit/s) and ≤ 24 KiB/s after.
10. **The self-hosted path stays**, behind Settings → Group → "Use my own signalling server" (and
    for old `?s=` links), until the maintainer has confirmed the relay path on real networks.
    The desktop and web e2e tests still ride over it, because it is the only end-to-end ride
    possible in CI (public relays are blocked there).

## Consequences

- **Zero setup:** create a ride, send the link, done — for desktop and web alike. A self-hosted
  web instance no longer needs `/signal` for group rides.
- **Third-party dependence:** rides start only if at least one of the relays is up and reachable
  from both riders' networks. We do not run, control or monitor them; they may disappear, rate
  limit or block. Riders already connected keep riding if all relays go away.
- **What the relays see:** the riders' public IP addresses (WebSocket connections), the topic
  hash (hence, with effort, the room code), timing and size of the encrypted handshake, and
  throwaway Nostr public keys. Not: names, the secret, SDP contents (local/public addresses,
  fingerprints), ride data, workouts or community data — those go over the encrypted WebRTC data
  channel. STUN servers (Google, Cloudflare) see each rider's IP, as before.
- **No TURN:** riders behind symmetric NAT / CGNAT on both ends still cannot connect directly
  (`peer-connect-failed` → "could not connect directly" note). Unchanged from before.
- **Bundle:** +37 KB in the main renderer chunk, plus a lazily loaded 506 KB chunk (unminified;
  120 KB gzip) on the desktop; web build: +19 KB and a 217 KB (75 KB gzip) lazy chunk.
- **New runtime dependencies** (all MIT): `trystero`, `@trystero-p2p/core`,
  `@trystero-p2p/nostr`, `@noble/secp256k1` (see `THIRD_PARTY_NOTICES.md`).
- **Untested against real relays.** Unit tests run the whole stack on a fake Trystero; the e2e
  tests cover the UI up to the network and the "no relay reachable" failure. Two riders over the
  real relays have not been seen working yet.

## Removal plan for the self-hosted path

Once the relay path is confirmed, delete as a whole:

- `apps/signalling/` (server, Dockerfile, README) and the `signalling` script in the root
  `package.json`; `@freilauf/signalling` devDependency of `packages/p2p`.
- `packages/p2p/src/transports/selfHosted.ts`, `mesh.ts`, `mesh.test.ts`, `webrtc.ts`,
  `signalling/` (all files), `testing/fakeRtc.ts`, `testing/memorySignalling.ts`,
  `testing/wsTestUtils.ts`; in `testing/harness.ts` the `self-hosted` branch and that entry of
  `TEST_TRANSPORTS`; in `group.ts` the `signallingUrl`/`signalling`/`createWebSocket`/
  `createPeerConnection` deps and the `else` branch in the constructor; in `group.test.ts` the
  "real signalling server" block; the corresponding exports in `index.ts`.
- Desktop: `core/signallingProbe.ts` (+ test); in `core/groupConnection.ts` the
  `signallingUrlKind`/`signallingUrlProblem`/`serverLabel`/`describeProbe` helpers, the
  `self-hosted` targets and the `no-server`/`invalid-server`/`unreachable`/`not-signalling`
  failures; `LOCAL_TEST_SIGNALLING_URL`; in `appStore.ts` `testSignallingServer`, the probe and
  `probeSignalling` option; in `ui/GroupTab.tsx` `OwnServer`, `ServerForm`, `TestResult`,
  `useServerTest`, `ReachNote` and the own-server branches; in `SettingsTab.tsx` the two
  own-server fields; `group.useOwnServer`/`group.signallingUrl` in `shared/contract.ts` and
  `main/settings.ts` (+ `LEGACY_DEFAULT_SIGNALLING_URL`, `migrateSettings` branch).
- Web: `src/signallingUrl.ts` (+ test) and its use in `settingsStore.ts`; the `/signal`
  WebSocket in `src/server/webServer.ts` / `main.ts`; the Vite `/signal` proxy; the
  `ws:` source in the CSPs (keep `wss:`).
- Tests: the own-server test in `apps/desktop/e2e/group.spec.ts` and `groupRide()` in
  `apps/web/e2e/web.e2e.mjs` — replace them with a two-rider ride over a local relay if one can
  be run in CI.
- Docs: the "Advanced: your own signalling server" section of `docs/group-rides.md`, the
  signalling parts of `docs/p2p.md` and `docs/docker.md`.
