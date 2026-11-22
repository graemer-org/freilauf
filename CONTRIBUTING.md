# Contributing to Freilauf

Thanks for helping. Freilauf is small on purpose; please keep it that way.

## Setup

Node.js ≥ 22.18 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev:sim      # app with simulated devices, no hardware needed
pnpm test         # unit tests
pnpm typecheck
pnpm test:e2e     # Electron e2e (needs a display; on Linux CI: xvfb-run -a)
pnpm format       # Prettier
```

## Rules

- **Core packages stay portable.** `packages/*` must not import Electron,
  DOM or Node APIs. Timers, clocks, WebSocket, RTCPeerConnection and BLE are
  injected, so everything runs under Vitest with fake timers. Electron-specific
  code belongs in `apps/desktop`. See
  [ADR 0001](docs/adr/0001-architecture.md).
- **Every device has a simulated counterpart** in `packages/sim` implementing
  the same interface from `packages/devices/src/types.ts`, so the whole app
  can be run and tested without hardware (`pnpm dev:sim`).
- **Parsers need tests with byte fixtures.** Every protocol parser or encoder
  gets unit tests built from concrete byte arrays; prefer real captures
  (`FREILAUF_BLE_LOG=1`) and say where a fixture came from.
- **Protocol knowledge goes in `docs/protocols/`**, with its sources and a
  confidence level for each fact. Mark anything not confirmed on hardware as
  unverified.
- **TypeScript strict**; run `pnpm typecheck` and `pnpm test` before opening
  a pull request.

## Licence hygiene

Freilauf is MIT-licensed. **Do not copy code from GPL-licensed or otherwise
incompatible projects** — not even small snippets or translated ports.
Protocol facts (UUIDs, opcodes, byte layouts) may be learned from public
write-ups, specifications and your own captures, and must then be
re-implemented independently. Cite the source in `docs/protocols/`.

Do not use third-party trademarks in the project name, assets or UI. In
documentation, refer to products only to state compatibility.

By contributing you agree that your contribution is licensed under the
[MIT licence](LICENSE).
