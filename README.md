<p align="center">
  <img src="apps/desktop/build/icon.svg" width="88" height="88" alt="">
</p>

<h1 align="center">Freilauf</h1>

<p align="center">
  <strong>Indoor cycling without the virtual world — your own video, your friends, your data.</strong>
</p>

<p align="center">
  Open source (MIT) · local-first · no account · no telemetry · early and honest about it
</p>

<p align="center">
  <a href="https://graemer-org.github.io/freilauf/">Website</a> ·
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="#get-it">Get it</a> ·
  <a href="#ride-with-friends">Ride with friends</a> ·
  <a href="#join-in">Join in</a> ·
  <a href="docs/README.md">Docs</a>
</p>

Freilauf is a small desktop app for riding a smart trainer at home. It connects to your
trainer, heart-rate strap and handlebar controllers, shifts gears in software, and lays a
transparent stats overlay over whatever is already on your screen.

It starts in seconds and needs no account. Put on a film, a race or a playlist, and ride
over it. Friends join with an invite link and ride with you peer-to-peer. Everything you
ride stays on your machine, as plain files in open formats.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/ride-climb-dark.webp">
    <img src="docs/assets/screenshots/ride-climb-light.webp" width="900" alt="The ride view during an 8 % climb, filling the window: a large power reading on the left, an animated rider on a tilted road with an elevation profile in the middle, cadence, speed, gear 12 of 24, time, distance and heart rate around it, gear and gradient controls at the bottom, and a quiet toolbar with device status, Group and Overlay on top.">
  </picture>
</p>

<p align="center"><sub>Screenshots are taken in simulation mode (note the “Simulation” badge), which runs the whole app without hardware.</sub></p>

## What it does

|                                                                                                                                                                                                                                                                                                                                              |                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/assets/screenshots/overlay-over-video.webp" width="420" alt="The stats overlay: semi-transparent tiles for power, heart rate, cadence, speed, gear, time and distance, plus a small group list, over a colourful background.">                                                                                                | **An overlay over anything.** A transparent, always-on-top, click-through window with the numbers you choose, on top of a fullscreen video or any other app. A hotkey (`Ctrl/Cmd+Shift+O`) toggles edit mode to move and resize it.                                                    |
| <img src="docs/assets/screenshots/workout-erg-dark.webp" width="420" alt="A structured workout in progress: target 91 W, the step name Warm-up, a coloured block chart of the whole workout, and the time left in the step.">                                                                                                                | **Structured workouts in ERG mode.** The trainer holds the target power. Import `.zwo` files, use the built-in library, or measure your FTP with a 20-minute or a ramp test.                                                                                                           |
| <img src="docs/assets/screenshots/ride-route-light.webp" width="420" alt="Riding a route: the road seen from behind the rider, bending to the right and climbing at 5 %, with a map of the winding climb and an elevation profile of the whole route and of the next few hundred metres, coloured by steepness.">                            | **Real routes from GPX.** Import a GPX file or pick a built-in route: its gradient drives the trainer, and the ride scene shows the road from behind the rider, bending and climbing as the route does, with a mini map and the profile of what lies ahead ([routes](docs/routes.md)). |
| <img src="docs/assets/screenshots/group-ride-light.webp" width="420" alt="The ride scene with three riders side by side on a flat road, two of them labelled Cleo and Ben.">                                                                                                                                                                 | **Group rides, peer-to-peer.** Up to eight riders in a room over WebRTC. Share a workout with the group and start it together on a countdown.                                                                                                                                          |
| <img src="docs/assets/screenshots/start-light.webp" width="420" alt="The start screen: ‘What are you riding today?’ with four cards — Free ride, Workout (Sweet spot 3×12 · 1 h 7 min, selected), Route (Rolling loop · 12.0 km, selected) and FTP test — riding alone, the device status at the bottom and one large Start riding button."> | **Choose, then ride.** One start screen: free ride, a workout from your library (drop in `.zwo` files), a GPX route or an FTP test — alone or with friends — and one button to start. After the ride, a short summary; every ride is recorded locally and exports to `.fit`.           |
| <img src="docs/assets/screenshots/community-light.webp" width="420" alt="Activity → Community: this week's 234 points with distance, time, elevation, energy and rides, and a leaderboard of friends ranked by points, with your own row highlighted and older standings dimmed.">                                                           | **Points, leaderboards and challenges — without a server.** Points measure load relative to your own FTP (an hour at FTP is 100). Friends' standings and challenges travel peer-to-peer whenever you ride together, and you choose per friend what they may see.                       |

And underneath:

- **Trainer control over standard Bluetooth FTMS**, heart rate over the standard Heart Rate
  Service, and handlebar controllers of a smart frame with configurable button actions.
- **Virtual shifting in software**: 24 gears, expressed through FTMS simulation parameters, so
  a single-cog bike feels like it has a full cassette ([ADR 0002](docs/adr/0002-virtual-shifting.md)).
- **Free ride with gradient**, and an animated ride scene with an elevation profile and
  steering; on a route, a road view from behind the rider instead.
- **Power-ups**: collect one on the road or earn it with a short effort, use it with the side
  button or <kbd>P</kbd>. They move only your race position — the recording, `.fit`, points and
  bests stay your own power ([power-ups](docs/power-ups.md)).
- **An always-on diagnostic log** that leaves out your name and ride data, made to be attached
  to a bug report: Settings → Diagnostics exports it, copies the recent part or opens its folder
  ([diagnostics](docs/diagnostics.md)).
- **Share with my watch** (Windows, new, untested on real watches): the app also acts as a
  Bluetooth power meter, heart-rate and speed/cadence sensor, so a sports watch records the ride
  too ([watch relay](docs/watch-relay.md)).
- **A browser version** you can run with Docker Compose, for example on a home server
  ([docker](docs/docker.md)).

## Status

Freilauf is **early**. There are no published releases yet. Everything above is built and
tested end to end against simulated devices — over 800 unit tests, plus Playwright tests that
drive the desktop app and the browser build — but very little has met real hardware so far.

**First real-hardware test — 22 November 2026, Windows 11, Wahoo KICKR CORE, Zwift Ride smart
frame, a Bluetooth heart-rate strap:**

- Pairing worked for all three kinds of device.
- **All controller buttons are confirmed on hardware** (second and third pass, 22–23 November):
  every one of the sixteen decodes correctly, including Z and the right power button.
- The **brake/steering levers are decoded**: each grip has one lever that moves both ways
  (−100 … +100). Which direction brakes and which steers was worked out from a capture and
  then **confirmed by the tester** with the live lever display (now under Devices → Controllers), where
  the directions can also be swapped or reassigned. Braking slows the virtual bike only. Keyboard
  shifting, steering and braking (<kbd>S</kbd>) work regardless
  ([protocol notes](docs/protocols/zwift-ride.md)).
- How the overlay behaves over fullscreen video on Windows and macOS has **not been confirmed**
  yet.

**Not tried on real hardware at all yet:** ERG workouts on a real trainer, the FTP tests,
steering and braking with the controller levers in a ride, group rides between different machines and networks (so far
only on one machine; the new zero-setup path over public relay servers has **not been verified
on real networks** at all), building the Docker image, and macOS in general.

**Routes** — GPX import, built-in routes, the road view, the route's gradient on the trainer
with an adjustable climb difficulty, sharing routes in a group and recording them in the `.fit`
file ([routes](docs/routes.md)) — are tested with simulated devices only; nobody has ridden a
route on real hardware yet.

**Community features** — points, weekly and monthly totals, friends with per-contact
visibility, challenges and leaderboards that sync peer-to-peer without a server — are in the
app under **Activity → Community** ([design](docs/community.md)). They are tested against simulated
riders only; standings and challenges between real machines have not been tried yet.

## Get it

New here? [Getting started](docs/getting-started.md) walks from the first build to pairing,
the overlay and simulation mode.

**From source (works today).** You need Node.js ≥ 22.18 and pnpm 10 (`corepack enable` picks
up the pinned version).

```sh
git clone https://github.com/graemer-org/freilauf.git
cd freilauf
pnpm install
pnpm dev:sim     # try everything with a simulated trainer, heart-rate strap and controller
pnpm dev         # ride with real Bluetooth devices
pnpm dist        # build an installer for your system (apps/desktop/release/<version>)
```

**Installers.** Windows, macOS and Linux installers are built with electron-builder, but none
have been published yet. When they are, they will be **unsigned**: Windows SmartScreen and
your browser will warn about an unknown publisher, and macOS Gatekeeper will refuse to open the
app until you allow it. [docs/releasing.md](docs/releasing.md) explains what to click.

**In the browser.** `docker compose up -d` serves a web version on port 8080 (group rides work
there without any further setup). Bluetooth in the browser needs Chrome or Edge and HTTPS (or
`localhost`), and the stats overlay becomes a small pop-out window instead of a transparent one.
See [docs/docker.md](docs/docker.md).

## Ride with friends

- **No setup:** on the start screen choose **Group ride**, click **Create group ride** and send
  the **invite link**. Friends paste it there too — no account, no server to run.
- **Direct:** power, speed, heart rate and position go straight from rider to rider over
  encrypted WebRTC. There is no Freilauf server; to find each other, the apps exchange a short
  handshake through **public relay servers operated by others**, encrypted with a secret that
  only the invite carries.
- **Status:** this path is new and **not yet verified on real networks**. If it does not work
  for your group, running your own signalling server is still available as an advanced option.

Up to eight riders in a ride. Share a workout with the group and start it together on a
countdown; each rider's targets follow their own FTP. Connections use public STUN servers and
no TURN relay, so riders behind some networks (symmetric NAT, common on mobile carriers and
some company or university networks) cannot connect.

**[How group rides work](docs/group-rides.md)** — inviting, what the relay servers see, when it
does not work, and the advanced own-server option. Technical details:
[docs/p2p.md](docs/p2p.md), [ADR 0003](docs/adr/0003-signalling-via-public-relays.md).

## Join in

Freilauf is built in the open, and right now the most valuable thing anyone can do is ride it
on real hardware and tell us what happened. You do not need to write code.

**Most wanted right now**

- **Hardware test reports**, with the diagnostic log — especially **controller button
  captures** (the steps are in the [protocol notes](docs/protocols/zwift-ride.md#how-to-capture)),
  and **other trainers**: any trainer that speaks Bluetooth FTMS should work, but only one has
  been tried.
- **Protocol notes**: what you have learned from your own captures, with sources and a
  confidence level, in [`docs/protocols/`](docs/protocols).
- **Workouts**: original `.zwo` workouts you are happy to publish under the MIT licence.
- **Design**: the app's look, the overlay, the ride scene, this README.
- **Translations** — later, once the text settles; say hello if you want to help.

### Reporting a hardware test

Open an issue and include:

- your operating system and version, and whether you used the desktop app or the browser
  version (which browser);
- the devices: trainer, heart-rate strap, controllers, with model and firmware if you know it;
- what you did, what you expected, and what happened — for buttons, the order you pressed them
  in;
- the **diagnostic log**: `freilauf.log` (and any `freilauf.N.log`) from the `logs` folder in
  Freilauf's settings folder — [where to find it](docs/diagnostics.md#where-it-is). It leaves
  out your name, ride data and room codes, but have a quick look before posting
  ([what is in it](docs/diagnostics.md#what-is-in-the-log)).

Code contributions are welcome too; [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the
few rules.

### Principles

- **Local-first.** Rides, settings and workouts live on your machine. No account, no backend,
  no telemetry.
- **Open formats.** `.fit` for rides, `.zwo` for workouts, and documented wire protocols for
  group rides and device notes.
- **Clean-room protocol work.** Device protocols are learned from specifications, public
  write-ups and our own captures, then implemented independently. No code from GPL-licensed
  projects, not even small snippets.
- **MIT**, for everything in this repository.

## Roadmap

Next, roughly in this order of interest — none of it is built yet:

- GPX routes driving the gradient, with a map
- Drafting in group rides
- Strava upload
- A Wi-Fi connection to the trainer (Direct Connect, GATT over TCP)
- Signed installers
- An optional always-on relay peer that keeps friends' leaderboard values available when
  nobody else is online ([design](docs/community.md#an-optional-always-on-relay-peer-not-implemented))

## Architecture

- A pnpm workspace in TypeScript: portable core packages (`devices`, `sim`, `session`, `p2p`,
  `workouts`, `community`) with no Electron, DOM or Node dependencies, tested with Vitest.
- `apps/desktop` is the Electron app (main window, overlay, Bluetooth chooser), `apps/web` the
  browser build, `apps/signalling` the optional self-hosted signalling server for group rides.
- Two device layers: a GATT-shaped transport (Web Bluetooth today) and device drivers on top;
  every device has a simulated counterpart ([ADR 0001](docs/adr/0001-architecture.md)).
- Virtual shifting scales the road sent to the trainer as FTMS simulation parameters
  ([ADR 0002](docs/adr/0002-virtual-shifting.md)).
- Group rides are a WebRTC mesh; peers find each other through public Nostr relays (Trystero,
  [ADR 0003](docs/adr/0003-signalling-via-public-relays.md)) and ride data never touches a
  server (technical: [p2p](docs/p2p.md); for riders: [group-rides](docs/group-rides.md)).

Commands, environment variables and the full documentation index: [docs/README.md](docs/README.md).

## Licence and disclaimer

[MIT](LICENSE) © 2026 Freilauf contributors. Bundled third-party libraries and their licences:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Freilauf is an independent project. It is not affiliated with, endorsed by or sponsored by
Wahoo Fitness, Zwift, Strava or any other company mentioned here. Product names and trademarks
belong to their owners and are used only to describe compatibility.

Indoor training is strenuous. Ride within your limits, and check with a doctor if you are
unsure.
