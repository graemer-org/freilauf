# Running Freilauf with Docker (web version)

Besides the desktop app, Freilauf can run as a **web app** served from a
container — for example on a Synology NAS — and be used from a browser on the
computer next to the bike.

One container, one port: it serves the web app **and** the group-ride
signalling WebSocket (at `/signal`). There are no accounts and no server-side
data: settings and rides live in each browser.

> **The one thing to know first:** Bluetooth runs in the _browser_, on the
> computer next to the bike, never on the NAS. Browsers only allow Bluetooth
> on **HTTPS** pages (or `http://localhost`), and only **Chrome and Edge**
> (and other Chromium browsers) support it. Opening `http://<nas-ip>:8080`
> works for simulation mode, but **pairing a trainer needs HTTPS** — see
> [Synology](#synology-nas-container-manager--reverse-proxy) below.

## Quick start

```sh
git clone <this repository> freilauf
cd freilauf
docker compose up -d
```

Then open <http://localhost:8080> in Chrome or Edge **on the same computer**
(`localhost` counts as secure, so Bluetooth works). Add `?sim=1` to try it
without any devices: <http://localhost:8080/?sim=1>.

- Change the published port with the left side of the mapping in
  `docker-compose.yml`, e.g. `"8081:8080"`.
- Update: `git pull && docker compose up -d --build`.
- Health: `docker compose ps` shows `healthy`; the endpoint is `/healthz`.
- Logs: `docker compose logs -f`. Set `LOG_LEVEL: debug` in the compose file
  to log every request and group room opening/closing.

The container runs as the unprivileged `node` user with a read-only root
filesystem, all capabilities dropped and `no-new-privileges`. **No volumes are
needed** — there is nothing to back up on the server.

Without Compose:

```sh
docker build -f docker/Dockerfile -t freilauf-web .
docker run -d --name freilauf -p 8080:8080 --read-only --tmpfs /tmp --restart unless-stopped freilauf-web
```

## Synology NAS (Container Manager + reverse proxy)

Written for DSM 7.2 (not yet verified on a real NAS). Menu names may differ slightly between DSM
versions.

### 1. Run the container

1. **Package Center** → install **Container Manager**.
2. Put the repository on the NAS, e.g. in `/volume1/docker/freilauf` (File
   Station upload of a ZIP from GitHub, or `git clone` over SSH).
3. **Container Manager → Project → Create**
   - Project name: `freilauf`
   - Path: `/volume1/docker/freilauf`
   - Source: **Use existing docker-compose.yml**
   - Skip the "Web portal via Web Station" step.
   - **Done.** The first build takes a few minutes (it installs dependencies
     and builds the web app inside the image).
4. If port 8080 is already taken on the NAS, edit the mapping to e.g.
   `"8081:8080"` before building, and use that port below.

`http://<nas-ip>:8080/?sim=1` should now show the app in simulation mode. For
real devices, continue — the browser will block Bluetooth on this address.

### 2. HTTPS with the built-in reverse proxy

Why: Web Bluetooth is only available in a [secure context][secure-context].
For any address other than `localhost`, that means HTTPS with a certificate
the browser trusts. The app shows a notice ("Bluetooth needs HTTPS") when it
is opened over plain HTTP.

1. **A host name and certificate.** Easiest: **Control Panel → External Access
   → DDNS** → add a free `*.synology.me` name, then **Control Panel → Security
   → Certificate → Add → Get a certificate from Let's Encrypt** for e.g.
   `freilauf.yourname.synology.me` (Let's Encrypt needs port 80 reachable from
   the internet while issuing). Your own domain works the same way.
2. **Control Panel → Login Portal → Advanced → Reverse Proxy → Create**
   - Description: `Freilauf`
   - Source: Protocol **HTTPS**, Hostname `freilauf.yourname.synology.me`,
     Port **443** (or e.g. 8443)
   - Destination: Protocol **HTTP**, Hostname `localhost`, Port **8080**
   - Tab **Custom Header → Create → WebSocket.** This adds the
     `Upgrade`/`Connection` headers; **without it group rides fail** (the
     signalling WebSocket at `/signal` cannot connect).
   - Save.
3. **Control Panel → Security → Certificate → Settings**: assign the
   certificate to the `freilauf.yourname.synology.me` reverse-proxy entry.
4. Open `https://freilauf.yourname.synology.me` in Chrome or Edge on the bike
   computer. The Bluetooth notice must be gone; **Devices → Pair** opens the
   browser's own device chooser.

The NAS does not need to be reachable from the internet for solo riding — only
the name must resolve to the NAS on your network and the certificate must be
valid. For group rides with friends elsewhere, they need to reach the same
HTTPS address.

No public name at all? Alternatives, in order of preference:

- Run the container (or the desktop app) on the bike computer itself and use
  `http://localhost:8080`.
- Use a certificate from your own CA and install that CA on the bike computer.
- Per-computer workaround (development only): in Chrome, open
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
  `http://<nas-ip>:8080`, relaunch.

Idle WebSockets: the signalling server pings every 30 s, which keeps the
reverse proxy's default 60 s read timeout from closing the connection.

## What differs from the desktop app

| Topic              | Desktop app                                                                                  | Web / Docker                                                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stats overlay      | Transparent, always-on-top, **click-through** window over any app (video, Zwift-less screen) | **"Pop-out stats"** button: a small always-on-top [Document Picture-in-Picture][dpip] window with the same tiles. It is **not transparent and not click-through**; resize it by dragging its edges. Chrome/Edge 116+ only; the button is hidden elsewhere. The "Show overlay", "Edit overlay position" and hotkey settings have no effect. |
| Device chooser     | In-app list                                                                                  | The browser's own chooser                                                                                                                                                                                                                                                                                                                  |
| Reconnect on start | Automatic for remembered devices                                                             | Browsers only allow pairing after a click. Where the browser offers `getDevices()` (permitted devices), Freilauf waits for the remembered device to advertise and reconnects automatically. Otherwise the device shows as remembered but not connected — click **Retry** (opens the chooser) or **Pair**.                                  |
| Settings           | JSON file in the user data folder                                                            | `localStorage` of this browser, for this address; synced between open tabs                                                                                                                                                                                                                                                                 |
| Rides              | JSON files; "Open folder"                                                                    | IndexedDB of this browser, for this address. **"Export .fit" downloads the file.** Clearing site data deletes rides — export the ones you keep.                                                                                                                                                                                            |
| Browser support    | — (bundled Chromium)                                                                         | Chrome or Edge (desktop, Android). Not Firefox, not Safari, not any browser on iPhone/iPad. Brave: enable `brave://flags/#brave-web-bluetooth-api`.                                                                                                                                                                                        |
| Group rides        | Signalling server set in Settings                                                            | Defaults to the same address, `wss://<host>/signal` (or `ws://` over plain HTTP); can be changed in Settings                                                                                                                                                                                                                               |
| Simulation         | `pnpm dev:sim`                                                                               | Add `?sim=1` to the address                                                                                                                                                                                                                                                                                                                |
| Diagnostic log     | always on, `userData/logs/freilauf.log`; `FREILAUF_BLE_LOG=1` adds every raw frame           | always on, in memory for the tab; _Export log_ downloads it; warnings/errors also in the console; `freilaufDiagnostics()` prints the buffer; `?blelog=1` adds raw frames                                                                                                                                                                   |

Browser storage is per **origin** (scheme + host + port): `http://nas:8080`,
`https://freilauf.example` and `http://localhost:8080` each have their own
settings and rides, and paired devices must be paired again for each.

## Group rides through the same port

The container also is a signalling server: create a group in the **Group**
tab, share the room code, and others join with it — from the web version on
the same address, or from the desktop app with **Settings → Group →
Signalling server URL** set to `wss://<your-host>/signal`.

The server only relays the WebRTC handshake; ride data flows directly between
the riders' browsers (see [p2p.md](p2p.md)). Riders behind restrictive
(symmetric) NATs may not be able to connect to each other — there is no TURN
relay.

## Troubleshooting

**"Bluetooth needs HTTPS"** — the page was opened over `http://` on an address
other than `localhost`. Use the HTTPS reverse-proxy address (above). Check
that the certificate is valid (no warning in the address bar).

**"This browser cannot use Bluetooth"** — Firefox, Safari and all iOS/iPadOS
browsers do not implement Web Bluetooth. Use Chrome or Edge on Windows, macOS,
Linux, ChromeOS or Android. On Linux, Chrome may additionally need
`chrome://flags/#enable-experimental-web-platform-features`.

**"No Bluetooth adapter found"** — turn Bluetooth on in the operating system
and allow the browser to use it (macOS: System Settings → Privacy & Security →
Bluetooth), then reload.

**Pair does nothing / chooser is empty** — the device may still be connected
to another app (Zwift, the manufacturer's app, the desktop Freilauf). Close
it, wake the trainer, and try again.

**Group ride: "connecting" forever or an error** — the WebSocket to `/signal`
is blocked. With a reverse proxy, make sure the **WebSocket** custom headers
are enabled on the entry. Check in the browser's DevTools → Network → WS that
`wss://<host>/signal` connects (101 Switching Protocols). Opening
`https://<host>/signal` in a tab must answer "connect via WebSocket" (HTTP 426)
— if you get the app or a 404 instead, the proxy is not forwarding that path.

**Riders join but do not see each other** — the signalling worked but the
direct WebRTC connection did not (strict firewalls / NAT). Try another
network for one of the riders.

**"Pop-out stats" button missing** — Document Picture-in-Picture needs Chrome
or Edge 116 or newer on desktop.

## For developers

- `pnpm --filter @freilauf/web dev` — Vite dev server; run `pnpm signalling`
  alongside it (Vite proxies `/signal` to `localhost:8787`).
- `pnpm --filter @freilauf/web build && pnpm --filter @freilauf/web start` —
  the production server locally (`PORT`, `HOST`, `STATIC_DIR`, `LOG_LEVEL`).
- `pnpm --filter @freilauf/web test:e2e` — after a build, drives the
  production server in headless Chromium (needs the `playwright` package and
  its Chromium available to Node).
- The web app reuses the desktop renderer unchanged (`App`, `MainApp`,
  `OverlayView`); `apps/web/src/browserApi.ts` implements `FreilaufApi` for
  the browser.

[secure-context]: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
[dpip]: https://developer.chrome.com/docs/web-platform/document-picture-in-picture
