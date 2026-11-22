# Freilauf signalling server

A tiny WebSocket relay that lets Freilauf riders find each other for group rides. It only
introduces peers and forwards their WebRTC handshake (SDP offers/answers and ICE candidates);
ride data itself flows directly between the riders over WebRTC data channels and never touches
this server.

- No persistence, no accounts, no auth. Rooms exist only while someone is in them.
- Rooms are keyed by a short code (`A-Z`, `0-9`, 4–16 chars; the app uses 6-char codes).
- Limits: 8 peers per room, 64 KiB per message, a per-connection rate limit
  (burst 200, 50 msg/s), heartbeat pings every 30 s (dead sockets are dropped).
- `GET /healthz` returns `200 ok` for health checks.

The wire protocol is defined in [`src/protocol.ts`](src/protocol.ts) and documented in
[`docs/p2p.md`](../../docs/p2p.md).

## Run locally

Requires Node.js ≥ 22.18 (runs the TypeScript sources directly via type stripping).

```sh
pnpm signalling                 # from the repo root, listens on :8787
PORT=9000 node src/main.ts      # from this directory
```

Environment variables:

| Variable    | Default | Meaning                             |
| ----------- | ------- | ----------------------------------- |
| `PORT`      | `8787`  | TCP port                            |
| `HOST`      | all     | Interface to bind, e.g. `127.0.0.1` |
| `LOG_LEVEL` | (quiet) | `debug` logs room open/close events |

In the app, point the signalling URL at `ws://localhost:8787`.

## Self-host with Docker

```sh
docker build -t freilauf-signalling apps/signalling
docker run -d --restart unless-stopped --name freilauf-signalling \
  -p 127.0.0.1:8787:8787 freilauf-signalling
```

## TLS (wss://)

The server speaks plain `ws://` only. For anything reachable from the internet, terminate TLS in
a reverse proxy and give your friends the `wss://` URL. The proxy must pass the WebSocket
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

Join links then look like `freilauf://join/ABCDEF?s=wss%3A%2F%2Fsignal.example.org`.

## Security notes

Anyone who knows (or guesses) a room code can join that room, and peer ids are self-assigned,
so a client reconnecting with an existing peer id takes over that slot. This matches Freilauf's
trust model (rides among friends, no anti-cheat). The server never inspects signal payloads.
The rate limit and size limit only protect the server itself; put it behind your proxy's own
connection limits if you expose it publicly.
