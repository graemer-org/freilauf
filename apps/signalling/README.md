# Freilauf signalling server

> **Optional.** Group rides need no server: by default riders find each other through public
> relay servers ([docs/group-rides.md](../../docs/group-rides.md)). This server is the
> advanced fallback behind **Use my own signalling server** (Group tab → Advanced, or Settings
> → Group), kept until the relay path is confirmed on real networks
> ([ADR 0003](../../docs/adr/0003-signalling-via-public-relays.md), which also lists what will
> be removed with it). The rider-facing steps are in
> [Advanced: your own signalling server](../../docs/group-rides.md#advanced-your-own-signalling-server);
> the Docker web version contains this server at `/signal` ([docs/docker.md](../../docs/docker.md)).
> This page is the reference for the server itself.

A tiny WebSocket relay that lets Freilauf riders find each other for group rides. It only
introduces peers and forwards their WebRTC handshake (SDP offers/answers and ICE candidates);
ride data itself flows directly between the riders over WebRTC data channels and never touches
this server.

- No persistence, no accounts, no auth. Rooms exist only while someone is in them.
- Rooms are keyed by a short code (`A-Z`, `0-9`, 4–16 chars; the app uses 6-char codes).
- Limits: 8 peers per room, 64 KiB per message, a per-connection rate limit
  (burst 200, 50 msg/s), heartbeat pings every 30 s (dead sockets are dropped).
- `GET /healthz` returns `200 ok` for health checks; any other plain HTTP request gets
  `426` ("connect via WebSocket").
- WebSocket connections are accepted on any path, so `wss://signal.example.org` and
  `wss://signal.example.org/signal` both work. (The web version's container serves it only at
  `/signal`.)

The wire protocol is defined in [`src/protocol.ts`](src/protocol.ts) and documented in
[`docs/p2p.md`](../../docs/p2p.md).

## Run locally

Requires Node.js ≥ 22.18 (runs the TypeScript sources directly via type stripping).

```sh
pnpm signalling                 # from the repo root, listens on :8787
PORT=9000 node src/main.ts      # from this directory
```

Environment variables:

| Variable    | Default | Meaning                                                      |
| ----------- | ------- | ------------------------------------------------------------ |
| `PORT`      | `8787`  | TCP port                                                     |
| `HOST`      | all     | Interface to bind, e.g. `127.0.0.1`                          |
| `LOG_LEVEL` | (quiet) | `debug` logs room open/close events, including the room code |

To try the own-server path on one computer, choose **Use a server on this computer (for
testing)** under **Advanced** in the app's Group tab (it sets `ws://127.0.0.1:8787` and switches
the option on). Friends elsewhere cannot reach that
address; for them the server must be reachable from the internet over `wss://` (below).

What the server keeps and logs, and what it never sees, is listed under
[Advanced: your own signalling server](../../docs/group-rides.md#advanced-your-own-signalling-server)
in the rider guide.

## Self-host with Docker

Not yet built and run in a real deployment; please report how it went.

```sh
docker build -t freilauf-signalling apps/signalling
docker run -d --restart unless-stopped --name freilauf-signalling \
  -p 127.0.0.1:8787:8787 freilauf-signalling
```

## TLS (wss://)

The server speaks plain `ws://` only. For anything reachable from the internet, terminate TLS in
a reverse proxy and enter the resulting `wss://` address once in the app (**Settings → Group**
with **Use my own signalling server** on, or **Advanced** in the Group tab). Friends do not enter it: it travels inside the invite
link. The proxy must pass the WebSocket
upgrade through and should use a read timeout above the 30 s heartbeat.

Caddy (automatic certificates):

```caddyfile
signal.example.org {
  reverse_proxy 127.0.0.1:8787
}
```

nginx:

```nginx
server {
  listen 443 ssl;
  server_name signal.example.org;
  # ssl_certificate / ssl_certificate_key ...

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
  }
}
```

Invite links then look like `freilauf://join/ABCDEF?s=wss%3A%2F%2Fsignal.example.org`.

Without Docker, the same steps as the `Dockerfile`: Node.js ≥ 22.18, then in this directory
`npm install --omit=dev` and `PORT=8787 node src/main.ts` (keep it running with your system's
service manager).

## Security notes

Anyone who knows (or guesses) a room code can join that room, and peer ids are self-assigned,
so a client reconnecting with an existing peer id takes over that slot. This matches Freilauf's
trust model (rides among friends, no anti-cheat). The server never inspects signal payloads.
The rate limit and size limit only protect the server itself; put it behind your proxy's own
connection limits if you expose it publicly.
