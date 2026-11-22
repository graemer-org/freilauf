# Freilauf docs

## Architecture decisions (`adr/`)

| ADR                                  | Topic                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| [0001](adr/0001-architecture.md)     | Package boundaries, device/transport layers, the BLE adapter in Electron |
| [0002](adr/0002-virtual-shifting.md) | Software virtual shifting via FTMS simulation parameters                 |

New decisions get the next number; an accepted ADR is superseded by a new
one rather than rewritten.

## Protocols (`protocols/`)

Notes on device protocols, with sources and a confidence level per fact.
Anything not yet confirmed on real hardware is marked unverified.

- [zwift-ride.md](protocols/zwift-ride.md) — handlebar controllers of the
  Zwift Ride smart frame (proprietary, **partly verified**), including how to
  make a controller capture

## Features

- [p2p.md](p2p.md) — peer-to-peer group rides: room codes, the signalling
  server, the WebRTC mesh and its message protocol, shared documents and the
  synchronised start
- [workouts.md](workouts.md) — structured workouts: model, ERG runner,
  `.zwo` import/export, built-in library, FTP tests
- [community.md](community.md) — points, totals, friends, challenges and
  leaderboards synced peer-to-peer (core library; app integration in progress)

## Running and shipping

- [docker.md](docker.md) — the browser version with Docker Compose, incl.
  HTTPS on a Synology NAS, and how it differs from the desktop app
- [releasing.md](releasing.md) — installers, the release workflow, unsigned
  builds
- [website.md](website.md) — the project website in `site/` and how it is
  published to GitHub Pages

## Diagnostics

- [diagnostics.md](diagnostics.md) — the always-on diagnostic log: where it
  is, how to export it, what it contains and what it leaves out

## Development

Requires Node.js ≥ 22.18 and pnpm 10 (`corepack enable` picks up the version
pinned in `package.json`). See also [CONTRIBUTING.md](../CONTRIBUTING.md).

| Command           | What it does                                                      |
| ----------------- | ----------------------------------------------------------------- |
| `pnpm dev`        | Start the desktop app in development mode (electron-vite)         |
| `pnpm dev:sim`    | Same, with simulated devices (`FREILAUF_SIM=1`)                   |
| `pnpm build`      | Production build of the desktop app                               |
| `pnpm dist`       | Build installers for the current system (electron-builder)        |
| `pnpm signalling` | Run the signalling server (`ws://localhost:8787`)                 |
| `pnpm test`       | Unit tests (Vitest) for all packages                              |
| `pnpm test:watch` | Vitest in watch mode                                              |
| `pnpm test:e2e`   | Build the desktop app and run the Electron e2e tests (Playwright) |
| `pnpm typecheck`  | `tsc --noEmit` in every workspace package                         |
| `pnpm format`     | Format with Prettier (`format:check` only checks)                 |

| Variable             | Used by    | Effect                                                                                                                    |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `FREILAUF_SIM=1`     | desktop    | Use simulated devices instead of Bluetooth (`pnpm dev:sim`)                                                               |
| `FREILAUF_BLE_LOG=1` | desktop    | Also log every raw controller frame, uncollapsed, to the diagnostic log (always on; see [diagnostics.md](diagnostics.md)) |
| `FREILAUF_USER_DATA` | desktop    | Use this directory for settings and rides instead of the default user-data folder                                         |
| `PORT`               | signalling | Listen port (default `8787`)                                                                                              |
| `HOST`               | signalling | Bind address (default all interfaces)                                                                                     |
| `LOG_LEVEL=debug`    | signalling | Verbose logging                                                                                                           |

| Path                 | Contents                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- |
| `packages/devices`   | BLE transport interfaces, protocol parsers and device drivers (FTMS, HR, controllers) |
| `packages/sim`       | Bike physics, virtual gearing, simulated devices                                      |
| `packages/session`   | Ride state, recording, `.fit` encoding                                                |
| `packages/p2p`       | Signalling client, WebRTC mesh, group state, shared documents                         |
| `packages/workouts`  | Structured workouts, `.zwo` import/export, FTP tests                                  |
| `packages/community` | Points, totals, contacts, challenges, leaderboards, sync                              |
| `apps/desktop`       | Electron app: main window, overlay, Bluetooth chooser, persistence                    |
| `apps/web`           | Browser build of the app (served by the Docker image)                                 |
| `apps/signalling`    | Minimal WebSocket signalling server (self-hostable)                                   |
| `site`               | The project website (static, no build step)                                           |
