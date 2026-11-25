# ADR 0005 — Share with my watch: the app as a Bluetooth sensor

Status: accepted · 2026-11-25 · **not yet tried on real hardware**

## Context

Riders want their sports watch to record the indoor ride too (training load, recovery,
the watch's own history). The maintainer's watch, a Suunto Race 2, pairs Bluetooth LE heart-rate
belts, cycling power meters and bike speed/cadence sensors; it has no ANT+. So Freilauf, which
is a Bluetooth _central_ towards trainer, heart-rate strap and controllers, must at the same time
be a Bluetooth _peripheral_: advertise standard sensor services and notify the live values.

Constraints:

- Web Bluetooth (what the renderer uses) is central-only; Electron and Node have no peripheral
  API. Node add-ons for it (bleno and forks) need a native build on the rider's machine, are
  barely maintained, and have no working Windows peripheral backend.
- The maintainer is on **Windows 11**; his adapter reports `IsLowEnergySupported`,
  `IsCentralRoleSupported` and `IsPeripheralRoleSupported` all **True**. He builds with Node,
  Git and pnpm only — no Rust or C++ toolchain.
- macOS and Linux: report "not supported" cleanly unless it is cheap.

## Decision

### 1. A small native helper process, the app produces every byte

`apps/desktop/native/sensor-relay` is a small Rust program (about 700 lines plus tests; `freilauf-sensor-relay.exe`).
The Electron main process spawns it on demand and talks newline-delimited JSON over
stdin/stdout:

| Commands (app → helper)                                                  | Events (helper → app)                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `start {services:[{uuid, characteristics:[{uuid, properties, value}]}]}` | `ready {version, protocol, backend}` — first line, the handshake                                                          |
| `notify {service, characteristic, value}` (value: hex)                   | `adapter {lowEnergySupported, peripheralRoleSupported, centralRoleSupported, radioOn}`                                    |
| `stop`                                                                   | `unsupported {reason}` · `started {services}` · `stopped` · `advertising {service, status}`                               |
| `quit` (or close stdin)                                                  | `subscribers {service, characteristic, centrals}` · `write {service, characteristic, value, central}` · `error {message}` |

`PROTOCOL = 1` in `protocol.rs`; the app (`main/sensorRelayProtocol.ts`) refuses a helper that
reports another version. A unit test reads `protocol.rs` and fails if the version or the
command/event names drift apart.

The helper knows nothing about cycling: it creates the services it is told to, advertises them,
answers reads with the last value, acknowledges writes and forwards them, and notifies/indicates
subscribed clients. All payloads come from `packages/devices/src/relay` (pure TypeScript,
tested): `encode.ts`, `revolutions.ts`, `sensorRelayModel.ts`.

Why a separate process and not a Node add-on: no native module in the app (`npmRebuild: false`
stays true), nothing to compile on the rider's machine, a crash or hang in the Bluetooth stack
cannot take the app down, and the helper can be restarted.

**Windows backend** (`windows_backend.rs`, the `windows` crate): one `GattServiceProvider` per
service (`CreateAsync`, awaited), `GattLocalCharacteristic`s with plain (unencrypted) protection,
`StartAdvertising` with `IsConnectable` and `IsDiscoverable`; `ReadRequested` and
`WriteRequested` answered under a deferral that is completed on every path (reads honour the
offset of a long read, writes with response are acknowledged); `SubscribedClientsChanged` is
reported as the list of subscribed centrals; `NotifyValueAsync` is fire-and-forget with a
completion handler that logs failed deliveries (so a vanished watch never stalls the loop).
Central ids are a hash of the OS device id: Bluetooth addresses never reach the app or the log.
`IsPeripheralRoleSupported` and LE support are checked at start (and again on every `start`
after an "unsupported", in case a dongle was plugged in) and reported. `stop`/`quit`/stdin EOF
stop advertising and release all providers. Nothing on the input path can panic (the release
build has `panic = "abort"`): hex and UUIDs are parsed on bytes, lines are length-capped,
invalid UTF-8 is an error event. Diagnostics go to stderr, which the app copies into its log.

### 2. What is published

| Kind (setting) | Service                            | Characteristics                                                                                                                                                                                                                                 | Default |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `heartRate`    | Heart Rate `0x180D`                | HR Measurement `0x2A37` notify (flags `0x06`, uint8 bpm); Body Sensor Location `0x2A38` read (chest)                                                                                                                                            | on      |
| `power`        | Cycling Power `0x1818`             | CP Measurement `0x2A63` notify (flags `0x0020`, power sint16, crank revs uint16, crank event time uint16 1/1024 s); CP Feature `0x2A65` read (crank revolution data); Sensor Location `0x2A5D` read (rear hub)                                  | on      |
| `speedCadence` | Cycling Speed and Cadence `0x1816` | CSC Measurement `0x2A5B` notify (flags `0x03`, wheel revs uint32 + time, crank revs uint16 + time, 1/1024 s); CSC Feature `0x2A5C` read (wheel + crank); Sensor Location `0x2A5D` read (rear wheel); SC Control Point `0x2A55` write + indicate | on      |
| `trainer`      | Fitness Machine `0x1826`           | FTMS Feature `0x2ACC` read (cadence, total distance, power, heart rate; no target setting); Indoor Bike Data `0x2AD2` notify (speed, cadence, total distance, power, heart rate)                                                                | **off** |

All UUIDs are the Bluetooth SIG 16-bit ones in the base UUID (`0000xxxx-0000-1000-8000-00805f9b34fb`).
Measurements are sent every **250 ms (4 Hz)** per characteristic, from the last `LiveState` the
main window published (it publishes about 4×/s). Heart rate is only sent while the app has a
heart-rate value. SC Control Point "Set Cumulative Value" sets the wheel count and is answered
with the success indication; other op codes get "op code not supported".

**FTMS is off by default** because it says "I am a smart trainer": training apps and some watches
then try to take control of it (our FTMS has no Control Point, so they fail or complain), a
watch that also pairs the power meter may record the same power twice, the Suunto Race 2 does
not pair fitness machines at all, and every extra service is one more advertisement for the
adapter to fit. It is there for receivers that only understand FTMS.

### 3. Deriving the counters

- **Cadence → crank revolutions** (CPS and CSC share one counter): cadence/60 turns per second,
  integrated per update; a new crank event only when a whole turn completes, its time
  interpolated inside the update interval (`RevolutionCounter`). No cadence: count and time are
  held, which a receiver reads as 0 rpm after its timeout.
- **Virtual speed/distance → wheel revolutions**: the ride's cumulative distance divided by a
  fixed circumference of **2.105 m** (700×25C), so the distance the watch computes from the wheel
  count matches the app's. The watch must use the same circumference (or "auto", which it then
  learns as 2.105 m from nothing — see the docs). A distance that drops (new ride) or jumps by
  more than 30 m between updates is a new base: the count never runs backwards.
- **Pause**: the ride's distance and speed stop while paused, so the wheel stops (a watch with
  auto-pause on speed pauses too). Power, cadence and heart rate keep flowing as measured, like
  a real power meter that does not know about the app's pause. **No live values** for more than
  3 s (main window gone): power 0, no new turns, no heart rate.
- The counters live as long as the chosen set of kinds does: a restarted helper continues them.

### 4. Lifecycle and status (main process)

`main/sensorRelayController.ts` (pure, unit-tested with a fake helper and fake timers) and
`main/sensorRelay.ts` (spawn, helper path):

- Off → on: spawn → wait ≤ 5 s for `ready` (else kill) → protocol check → `start` → `started`
  → updates. Status: `off` · `starting` · `sharing {devices}` (0 = waiting for a watch;
  `devices` = distinct centrals subscribed to any characteristic) · `unsupported {reason}` ·
  `error {message, retrying}` · `unavailable {reason}` (no helper on this OS/build).
- The helper dies, or `start` fails (radio off): retry after 1, 2, 5, 10, 30, 60 s …; after
  8 consecutive failures it gives up until sharing is switched off and on. `unsupported` and a
  protocol mismatch are final the same way.
- On → off, or app quit: `stop`, `quit`, close stdin; killed after 2 s if still running.
- Everything goes to the diagnostic log under source `relay`: helper path kind, the handshake,
  the adapter's capabilities, advertising status per service, subscription changes, control
  point writes, helper stderr, and once a minute a summary of what is relayed. The computer's
  name is shown in the UI but not logged.
- Settings: `Settings.watchRelay = { enabled: false, share: { heartRate, power, speedCadence:
true, trainer: false } }`, sanitised like every other field. IPC: `watch-relay:status`
  (invoke, main window only, sender-checked) and `watch-relay:status-changed` (main → main
  window); changes go through `settings:update`.

### 5. Platforms

- **Windows 10 1803+ / 11**: supported (the helper).
- **macOS** would need `CBPeripheralManager` in a separate signed helper app with its own
  Bluetooth usage description; **Linux** the BlueZ D-Bus GATT server and advertising API
  (`org.bluez.GattManager1`, `LEAdvertisingManager1`), which depends on the BlueZ version and
  permissions. Neither is cheap; both report "not supported" (`unavailable`) and the switch is
  disabled. The protocol and controller are platform-neutral, so a second backend only has to
  speak the same protocol.
- **Browser build**: a web page cannot be a Bluetooth peripheral; the section says so.

### 6. Packaging: the Windows binary is committed

Options were (a) commit the cross-compiled `.exe` with a reproducible build script and its
checksum, or (b) require a Rust toolchain wherever `pnpm dist` runs. **(a)**, because:

- the binary is small — **374 784 bytes** — and changes rarely;
- the build is **reproducible**: `native/sensor-relay/build-windows.sh` (Linux, rustup target
  `x86_64-pc-windows-gnu` + mingw-w64) remaps paths, drops the PE timestamp and builds
  `--locked`; `build-windows.sh --check` rebuilds in a temporary folder and compares. Two clean
  builds gave the same bytes;
- the maintainer builds on Windows with Node, Git and pnpm only; (b) would add a ~1 GB
  toolchain to every release build.

Files: `prebuilt/win32-x64/freilauf-sensor-relay.exe`, `….exe.sha256`
(`edd41d965590f3fe99f3d4639a60a2ac1f03b86ea0b7151fbf93aad9d45b9ae2`) and `BUILDINFO.txt`
(rustc 1.97.0, GNU ld 2.41.90, GCC 13 mingw-w64). `electron-builder.yml` copies it with
`win.extraResources` to `resources/sensor-relay/`; macOS and Linux builds do not include it and
`pnpm dist` works on every platform without it. `build/check-bundle.mjs` (run by `pnpm dist`)
fails if the binary does not match its SHA-256, and on Windows if it is missing.
`.gitattributes` marks `*.exe` binary. Rebuild after changing the Rust source:
`cd apps/desktop/native/sensor-relay && ./build-windows.sh`, commit the three files. In
development the app prefers a local `cargo build --release` output on Windows
(`target/release/`) over the committed binary; `FREILAUF_SENSOR_RELAY_HELPER` (unpackaged builds
only) points it at another helper, e.g. the tests' fake (`e2e/fakeSensorRelay.mjs`).

The helper's crates are MIT or Apache-2.0 (dual), `memchr` Unlicense/MIT, `zmij` MIT; build-time
proc-macro crates (`unicode-ident` carries Unicode-3.0 data terms) are not in the binary. The
mingw-w64 CRT and libgcc pieces linked statically are under permissive terms (mingw-w64 runtime
licence, GCC Runtime Library Exception). See THIRD_PARTY_NOTICES.md. Nothing is copyleft.

## Consequences

- One more process and one more binary in the Windows build, unsigned like the app (Windows may
  show SmartScreen for the installer, not for the helper).
- Windows advertises with the computer's Bluetooth name; the app cannot choose one. Riders are
  told to look for that name.
- Receiving (trainer, strap, controllers) and sending (watch) share one radio. Whether an
  adapter keeps up with both roles at once is up to the adapter and driver.
- **Unverified** at the time of writing: the WinRT backend has only been compiled
  (cross-compiled from Linux), not run on Windows; no watch has paired with it. The protocol,
  the payloads, the controller, the UI and an Electron e2e test with a fake helper are tested.
  docs/watch-relay.md has the test procedure.
