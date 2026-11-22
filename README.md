# Freilauf

**Indoor cycling without the world.** Freilauf is a small, local-first desktop
app that connects to your smart trainer, heart-rate strap and handlebar
controllers, does virtual shifting in software, and puts a transparent stats
overlay on top of whatever you are watching. Ride alone, or with a few friends
peer-to-peer. No accounts, no backend, no virtual world.

- **Trainer** over standard Bluetooth FTMS, driven with simulation parameters
- **Virtual shifting** in software for single-cog smart frames
  ([ADR 0002](docs/adr/0002-virtual-shifting.md))
- **Free ride** with a manually set gradient
- **Overlay:** a transparent, always-on-top, click-through stats window over
  any app (for example a fullscreen video); a global hotkey
  (default `Ctrl/Cmd+Shift+O`) toggles edit mode to move and resize it
- **Group rides** for a handful of friends over WebRTC: share a room code,
  connect through a tiny self-hostable signalling server, then ride
  peer-to-peer
- **Local recording** with autosave and `.fit` export

## Status

Early scaffold. Be aware:

- Everything has been developed and tested against **simulated devices**
  only. It has **not yet been tested against a real trainer, heart-rate
  strap or controllers.**
- The handlebar controller protocol is proprietary; our notes are
  **unverified hypotheses** until confirmed with captures
  ([docs/protocols/zwift-ride.md](docs/protocols/zwift-ride.md)). Shifting
  also works from the keyboard, and the button mapping is configurable.
- Virtual-shifting constants (physical gear ratio, trainer mass) still need
  calibration on real hardware.
- Development happens on Linux. **Overlay behaviour (transparency,
  click-through, always-on-top over fullscreen apps) on Windows and macOS is
  unverified.**

## Hardware it targets

- A smart trainer speaking Bluetooth FTMS; the reference target is a Wahoo
  KICKR CORE
- A single-cog smart frame with handlebar controllers; the reference target is
  the Zwift Ride smart frame
- Any standard Bluetooth heart-rate strap (Heart Rate Service)

Freilauf is an independent project and is not affiliated with, endorsed by or
sponsored by Wahoo Fitness, Zwift or any other company mentioned. All product
names and trademarks belong to their respective owners and are used only to
describe compatibility.

## Install

Download the installer for your system from the
[latest GitHub Release](https://github.com/graemer-org/freilauf/releases/latest):

| System                              | File                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Windows 10/11 (x64)                 | `Freilauf-<version>-win-x64-setup.exe` (or the portable `…-win-x64.zip`) |
| macOS 12+ (Apple Silicon and Intel) | `Freilauf-<version>-mac-universal.dmg`                                   |
| Linux (x64)                         | `Freilauf-<version>-linux-x86_64.AppImage` (`chmod +x`, then run it)     |

The builds are **not code-signed yet**, so your system will warn you once:

- **Windows:** SmartScreen says "Windows protected your PC" / unknown
  publisher. Click **More info → Run anyway**. The installer needs no admin
  rights (it installs for the current user only).
- **macOS:** Gatekeeper says the app "cannot be opened" or "is damaged".
  Drag Freilauf to Applications, then **right-click → Open** (on macOS 15+:
  try to open it once, then **System Settings → Privacy & Security → Open
  Anyway**), or run `xattr -dr com.apple.quarantine /Applications/Freilauf.app`.
  Allow Bluetooth access when asked.

`SHA256SUMS.txt` in each release lists the checksums. Details and how
releases are made: [docs/releasing.md](docs/releasing.md).

## Quick start

Requires Node.js ≥ 22.18 and pnpm 10 (`corepack enable` picks up the version
pinned in `package.json`).

```sh
pnpm install
pnpm dev:sim        # desktop app with simulated trainer, HR strap and controller
pnpm dev            # desktop app with real Bluetooth devices
pnpm signalling     # local signalling server for group rides (ws://localhost:8787)
```

| Command           | What it does                                                      |
| ----------------- | ----------------------------------------------------------------- |
| `pnpm dev`        | Start the desktop app in development mode (electron-vite)         |
| `pnpm dev:sim`    | Same, with simulated devices (`FREILAUF_SIM=1`)                   |
| `pnpm build`      | Production build of the desktop app                               |
| `pnpm signalling` | Run the signalling server                                         |
| `pnpm test`       | Unit tests (Vitest) for all packages                              |
| `pnpm test:watch` | Vitest in watch mode                                              |
| `pnpm test:e2e`   | Build the desktop app and run the Electron e2e tests (Playwright) |
| `pnpm typecheck`  | `tsc --noEmit` in every workspace package                         |
| `pnpm format`     | Format with Prettier (`format:check` only checks)                 |

### Environment variables

| Variable             | Used by    | Effect                                                                                                                              |
| -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `FREILAUF_SIM=1`     | desktop    | Use simulated devices instead of Bluetooth (`pnpm dev:sim`)                                                                         |
| `FREILAUF_BLE_LOG=1` | desktop    | Also log every raw controller frame, uncollapsed, to the diagnostic log (always on; see [docs/diagnostics.md](docs/diagnostics.md)) |
| `FREILAUF_USER_DATA` | desktop    | Use this directory for settings and rides instead of the default user-data folder                                                   |
| `PORT`               | signalling | Listen port (default `8787`)                                                                                                        |
| `HOST`               | signalling | Bind address (default all interfaces)                                                                                               |
| `LOG_LEVEL=debug`    | signalling | Verbose logging                                                                                                                     |

## Repository layout

| Path               | Contents                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- |
| `packages/devices` | BLE transport interfaces, protocol parsers and device drivers (FTMS, HR, controllers) |
| `packages/sim`     | Bike physics, virtual gearing, simulated devices                                      |
| `packages/session` | Ride state, recording, `.fit` encoding                                                |
| `packages/p2p`     | Signalling client, WebRTC mesh, group state                                           |
| `apps/desktop`     | Electron app: main window, overlay, Bluetooth chooser, persistence                    |
| `apps/signalling`  | Minimal WebSocket signalling server (self-hostable)                                   |
| `docs`             | Architecture decisions and protocol notes ([index](docs/README.md))                   |

The core packages have no Electron, DOM or Node dependencies and run under
Vitest in Node; see [ADR 0001](docs/adr/0001-architecture.md).

## Documentation

- [Docs index](docs/README.md)
- [ADR 0001 — Package boundaries and the BLE adapter](docs/adr/0001-architecture.md)
- [ADR 0002 — Software virtual shifting](docs/adr/0002-virtual-shifting.md)
- [Controller protocol notes](docs/protocols/zwift-ride.md)
- [Group rides / peer-to-peer](docs/p2p.md)
- [Contributing](CONTRIBUTING.md)

## Roadmap

**Priority 1 — in progress**

- FTMS trainer, heart-rate strap and handlebar controllers, with simulated
  counterparts
- Software virtual shifting, free ride with manual gradient
- Transparent overlay
- Peer-to-peer group rides with room codes
- Local recording and `.fit` export

**Priority 2 — designed for, not built**

- GPX routes driving the gradient, with a 2D map
- Structured workouts, ERG mode and `.zwo` import
- Drafting in group rides, steering
- Strava upload
- Wi-Fi Direct Connect transport (GATT over TCP)

## Licence

[MIT](LICENSE) © 2026 Freilauf contributors
