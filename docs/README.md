# Freilauf docs

## For riders

- [getting-started.md](getting-started.md) — build or install, first start, the start screen and
  the ride view, the countdown, power smoothing, pairing devices (controller buttons and levers),
  battery levels, the overlay and its hotkey, simulation mode, where the log is
- [routes.md](routes.md) — riding real routes from GPX files: importing, what happens to noisy
  elevation, starting part-way or jumping by clicking the profile, difficulty, loops and laps,
  sharing limits, surroundings from OpenStreetMap, recording with a map
- [group-rides.md](group-rides.md) — ride with friends: create a ride and send the link (no
  setup), what the public relay servers see, troubleshooting, and the advanced own-server option
- [power-ups.md](power-ups.md) — power-ups: collecting and earning them, what each one does, the
  fairness rule (only the race position changes, never the recording), settings
- [ghost.md](ghost.md) — the ghost rider: race your best time, your last ride, any earlier ride
  of a route or a friend's ride file; the gap chip, splits, jumps and pauses, laps, the summary,
  what is (not) stored
- [rumble.md](rumble.md) — Freilauf Rumble, the battle mode for group rides: feed bags, two item
  slots, water bottle, mud puddle, hornets, rain cape, energy bar, tacks and the flat tyre, mini
  tool, dropped chain, team car, rough sections, protection, compatibility
- [energy.md](energy.md) — calories, fat and carbohydrate: what is shown where, how it is
  computed, how accurate it is
- [watch-relay.md](watch-relay.md) — share with my watch: the app as a Bluetooth power meter,
  heart-rate and speed/cadence sensor for a sports watch (Windows); pairing, limits, test steps
- [docker.md](docker.md) — the browser version with Docker Compose, incl. HTTPS on a Synology
  NAS, and how it differs from the desktop app
- [diagnostics.md](diagnostics.md) — the always-on diagnostic log: where it is, how to export
  it, what it contains and what it leaves out
- [Reporting a hardware test](../README.md#reporting-a-hardware-test) — what to put in an issue

The rest of this page is technical: decisions, protocols and how features are built.

## Architecture decisions (`adr/`)

| ADR                                              | Topic                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [0001](adr/0001-architecture.md)                 | Package boundaries, device/transport layers, the BLE adapter in Electron              |
| [0002](adr/0002-virtual-shifting.md)             | Software virtual shifting via FTMS simulation parameters                              |
| [0003](adr/0003-signalling-via-public-relays.md) | Group-ride signalling via public relays (Trystero); removal plan for the own server   |
| [0004](adr/0004-routes.md)                       | Routes: elevation smoothing, gradient update policy, difficulty, storage, sharing     |
| [0005](adr/0005-sensor-relay.md)                 | Share with my watch: a native helper as Bluetooth peripheral, services, packaging     |
| [0006](adr/0006-power-ups.md)                    | Power-ups: race offset vs. recorded physics, determinism, battle-mode extension       |
| [0007](adr/0007-card-race.md)                    | Card Race: attacks as events, signed race offset (**superseded** by 0008)             |
| [0008](adr/0008-rumble-items.md)                 | Freilauf Rumble: feed bags, two item slots, items, compatibility with 0007's format   |
| [0009](adr/0009-rumble-road-items.md)            | Rumble road items (energy bar, tacks, mini tool, chain, team car, rough), protocol v3 |
| [0010](adr/0010-ghost-rider.md)                  | Ghost rider: route coordinates, continuous parts, jumps during a race, storage        |
| [0011](adr/0011-osm-scenery.md)                  | Scenery from OpenStreetMap: fetched once on request, route-relative model, licence    |

New decisions get the next number; an accepted ADR is superseded by a new
one rather than rewritten.

## Protocols (`protocols/`)

Notes on device protocols, with sources and a confidence level per fact.
Anything not yet confirmed on real hardware is marked unverified.

- [zwift-ride.md](protocols/zwift-ride.md) — handlebar controllers of the
  Zwift Ride smart frame (proprietary, **partly verified**), including how to
  make a controller capture

## Features (technical)

- [p2p.md](p2p.md) — peer-to-peer group rides: invites and secrets, the relay
  transport (Trystero) and the fallback signalling server + WebRTC mesh, the
  message protocol, shared documents and the synchronised start (for riders: [group-rides.md](group-rides.md))
- [workouts.md](workouts.md) — structured workouts: model, ERG runner,
  `.zwo` import/export, built-in library, FTP tests, workouts fitted to an episode ("hard now")
- [community.md](community.md) — points, totals, friends, challenges and
  leaderboards synced peer-to-peer (core library and its integration under Activity →
  Community)

## Running and shipping

- [releasing.md](releasing.md) — installers, the release workflow, unsigned
  builds
- [website.md](website.md) — the project website (`index.html` in this folder) and how it is
  published with GitHub Pages.

## Development

Requires Node.js ≥ 22.18 and pnpm 10 (`corepack enable` picks up the version
pinned in `package.json`). See also [CONTRIBUTING.md](../CONTRIBUTING.md).

| Command           | What it does                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `pnpm dev`        | Start the desktop app in development mode (electron-vite)            |
| `pnpm dev:sim`    | Same, with simulated devices (`FREILAUF_SIM=1`)                      |
| `pnpm build`      | Production build of the desktop app                                  |
| `pnpm dist`       | Build installers for the current system (electron-builder)           |
| `pnpm signalling` | Run the optional own signalling server on port 8787 (group-rides.md) |
| `pnpm test`       | Unit tests (Vitest) for all packages                                 |
| `pnpm test:watch` | Vitest in watch mode                                                 |
| `pnpm test:e2e`   | Build the desktop app and run the Electron e2e tests (Playwright)    |
| `pnpm typecheck`  | `tsc --noEmit` in every workspace package                            |
| `pnpm format`     | Format with Prettier (`format:check` only checks)                    |

| Variable                       | Used by              | Effect                                                                                                                    |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `FREILAUF_SIM=1`               | desktop              | Use simulated devices instead of Bluetooth (`pnpm dev:sim`)                                                               |
| `FREILAUF_BLE_LOG=1`           | desktop              | Also log every raw controller frame, uncollapsed, to the diagnostic log (always on; see [diagnostics.md](diagnostics.md)) |
| `FREILAUF_USER_DATA`           | desktop              | Use this directory for settings and rides instead of the default user-data folder                                         |
| `FREILAUF_SENSOR_RELAY_HELPER` | desktop (unpackaged) | Use this watch-relay helper (an executable, or a `.mjs` script such as `apps/desktop/e2e/fakeSensorRelay.mjs`)            |
| `PORT`                         | signalling           | Listen port (default `8787`)                                                                                              |
| `HOST`                         | signalling           | Bind address (default all interfaces)                                                                                     |
| `LOG_LEVEL=debug`              | signalling           | Verbose logging                                                                                                           |

| Path                               | Contents                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/devices`                 | BLE transport interfaces, protocol parsers and device drivers (FTMS, HR, controllers)               |
| `packages/sim`                     | Bike physics, virtual gearing, simulated devices                                                    |
| `packages/session`                 | Ride state, recording, `.fit` encoding                                                              |
| `packages/p2p`                     | Relay transport (Trystero), fallback signalling + WebRTC mesh, group state, documents               |
| `packages/workouts`                | Structured workouts, `.zwo` import/export, FTP tests                                                |
| `packages/community`               | Points, totals, contacts, challenges, leaderboards, sync                                            |
| `packages/routes`                  | GPX import/export, route preparation and smoothing, queries, codec, built-in routes                 |
| `apps/desktop`                     | Electron app: main window, overlay, Bluetooth chooser, persistence                                  |
| `apps/desktop/native/sensor-relay` | Rust helper that makes the PC a Bluetooth sensor for a watch (prebuilt `.exe` checked in; ADR 0005) |
| `apps/web`                         | Browser build of the app (served by the Docker image)                                               |
| `apps/signalling`                  | Optional WebSocket signalling server (self-hostable fallback)                                       |
| `docs/index.html`                  | The project website (static, no build step)                                                         |
