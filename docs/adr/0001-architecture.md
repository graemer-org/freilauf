# ADR 0001 — Package boundaries and the BLE adapter

Status: accepted · 2026-11-22

## Decision

- The core lives in four packages without Electron, DOM or Node
  dependencies, consumed as TypeScript source (no build step):
  `devices` (protocols, drivers, transport interfaces), `sim` (physics,
  gearing, simulated devices), `session` (ride state, recording, FIT),
  `p2p` (signalling client, WebRTC mesh, group state). Timers, clocks,
  WebSocket and RTCPeerConnection are injected, so everything runs under
  Vitest in Node.
- Two layers of device abstraction (`packages/devices/src/types.ts`):
  1. **Transport** — `BleTransport` / `BlePeripheral` / `GattConnection`:
     GATT-shaped read/write/subscribe. Implemented with Web Bluetooth in
     the renderer today. A noble backend, or Direct Connect (which tunnels
     GATT operations over TCP), implements the same three interfaces.
  2. **Device** — `Trainer`, `HeartRateSensor`, `Controller`: what the app
     uses. Real drivers sit on a `GattConnection`; simulated devices
     implement the device interfaces directly.
- `apps/desktop` owns everything Electron: windows, the overlay, the
  Bluetooth picker (`select-bluetooth-device`), persistence, global hotkey.
  The ride runs in the main window's renderer (where Web Bluetooth lives)
  and publishes snapshots through the main process to the overlay.

## Consequences

- Web Bluetooth has no silent "connect to known device" in Electron. On
  start the app calls `requestDevice` and the main process answers the
  picker event automatically with the remembered device id once it is seen.
- If the main window's renderer crashes, the ride stops. Accepted for now;
  the session autosaves so a ride is not lost.
