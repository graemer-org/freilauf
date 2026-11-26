# Diagnostic log

Freilauf always writes a plain-text diagnostic log. It exists so that when
something goes wrong on real hardware — a pairing that fails "the first time",
a controller button that does nothing, a trainer that stops reacting — the
log can be handed to a developer (or an AI assistant) who can then see what
happened. It is meant to be shared, so it is written with privacy in mind
(see [What is not in the log](#what-is-not-in-the-log)).

## Where it is

| System  | Folder                                                                               |
| ------- | ------------------------------------------------------------------------------------ |
| Windows | `%APPDATA%\Freilauf\logs\` (usually `C:\Users\<you>\AppData\Roaming\Freilauf\logs\`) |
| macOS   | `~/Library/Application Support/Freilauf/logs/`                                       |
| Linux   | `~/.config/Freilauf/logs/` (or `$XDG_CONFIG_HOME/Freilauf/logs/`)                    |

If the app was started with `FREILAUF_USER_DATA=<dir>`, the log is in
`<dir>/logs/`. Development builds (`pnpm dev`) may use a different folder name
(Electron's default); the app tells you the exact path (see below).

Files: `freilauf.log` is the current file. When it reaches 2 MB it is renamed
to `freilauf.1.log` (older ones shift to `.2`, `.3`) and a new one is started;
at most four files (about 8 MB) are kept, the oldest is deleted.

The web version (Docker / browser) keeps the same log lines **in memory** for
the open tab only (lost on reload); warnings and errors also go to the
browser console, and in the console `freilaufDiagnostics()` prints the lines.

## Getting it out

All three are buttons on the **Diagnostics** card in **Settings** (linked at the top of the
start screen):

- **Export log…**: saves one text file that contains
  all log files, oldest first and the current one last, each preceded by a
  `----- freilauf.N.log -----` marker. This is the file to attach to an issue
  or hand to a developer. In the browser it is downloaded as
  `freilauf-log-<date>.txt`.
- **Copy recent log**: copies the last 256 KB to the clipboard (for pasting
  into a chat); a notice confirms how much was copied.
- **Open log folder**: opens the folder above in Explorer / Finder / the file
  manager (in the browser: explains that the log is in memory).

The card also repeats the short "Help decode the controllers" recipe from
[protocols/zwift-ride.md → How to capture](protocols/zwift-ride.md#how-to-capture).
While you press buttons, **Devices → Controllers → Controller buttons** (click the
device line on the start screen) shows
"Last button: <grip> · <button>" and lights up that button's row for a moment,
so you can see at once which button the app decoded (or that nothing arrived).
**Devices → Controllers → Brake and steering levers** shows each lever as a live
bar from −100 to +100 and what the app makes of it (steering or brake).

For developers, the same is available on `window.freilauf.diagnostics`
(`getLogInfo()`, `exportLog()`, `readRecent(maxBytes)`, `openLogFolder()`,
`logFilePath()`, `log(level, source, message, context?)`) and as app-store
actions `app.exportLog()`, `app.copyRecentLog()`, `app.openLogFolder()`.

## Reading it

One event per line:

```
2026-11-22T08:00:00.123Z INFO  ble      trainer "KICKR CORE 5A1F" connecting → connected {"id":"F4:12:9A:33:0C:71","afterMs":812}
└ time (UTC, ms)         │     │        └ message                                    └ optional JSON context
                         │     └ source
                         └ level: DEBUG, INFO, WARN, ERROR
```

Sources:

| Source       | What                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `session`    | the header written at every start                                                                                              |
| `main`       | app start/quit, windows, renderer crashes/hangs, uncaught errors in the main process                                           |
| `renderer`   | the main window: uncaught errors, console warnings/errors, notices shown to the user                                           |
| `overlay`    | the overlay window: show/hide, edit mode, bounds, always-on-top re-assertions, errors                                          |
| `bluetooth`  | the device chooser (devices seen, selected, cancelled, timeouts) and pairing prompts                                           |
| `ble`        | device lifecycle: search, GATT connect, services, subscriptions, FTMS control point, state changes, reconnects, data summaries |
| `controller` | the controller protocol capture (see below)                                                                                    |
| `ride`       | ride start/pause/resume/finish, gear shifts (with source), button → action, trainer commands, workout segments                 |
| `p2p`        | group join/leave, peers connecting/disconnecting, errors                                                                       |
| `settings`   | load problems and every change (as a list of changed settings)                                                                 |
| `log`        | the log itself, e.g. "12 log line(s) were dropped" after a full disk                                                           |

Lines are written by two processes (main and the window) and batched, so
lines from different sources can be a few milliseconds out of order; within a
source they are in order.

### The session header

Every launch starts with:

```
… INFO  session  ===== Freilauf 0.3.0 session 7f3a9c21 started =====
… INFO  session  app {"name":"Freilauf","version":"0.3.0","packaged":true,"simMode":false,"rawBleFrames":false}
… INFO  session  versions {"electron":"45.4.1","chromium":"156.0.8078.100","node":"24.22.3",…}
… INFO  session  os {"platform":"win32","release":"10.0.26100","version":"Windows 11 Pro","arch":"x64",…}
… INFO  session  locale {"app":"de","system":"de-DE","timeZone":"Europe/Berlin",…}
… INFO  session  displays {"count":2,"displays":[{"primary":true,"bounds":{…},"scaleFactor":1.5,…},…]}
```

The session id is random per launch; it tells launches apart in an export.

### A failed pairing

Look for `pair <kind>:` / `reconnect <kind>:` lines and the `ble` lines
between them. A failure ends with a line like

```
… ERROR ble      pair trainer: failed {"ms":20412,"error":{"name":"NetworkError","message":"Connection failed for unknown reason.","stack":"…"}}
… WARN  renderer notice shown: Could not connect the trainer: it may be connected to another app or a phone. … Details are in the log.
```

The lines before it show how far it got: the chooser (`bluetooth` — which
devices were seen and which was selected), `gatt.connect()`, the services
found, each subscription, the FTMS `RequestControl` exchange
(`→ success` / `→ controlNotPermitted`), and the state changes with their
timing. `reconnect attempt N in D ms` / `reconnect attempt N failed` show the
automatic retries after a lost link.

### Controller capture

The handlebar controller protocol is reverse-engineered: the buttons and the
lever message layout are verified, the meaning of the two lever directions is
not yet ([protocols/zwift-ride.md](protocols/zwift-ride.md)), so its capture
is always on: every change of the raw keypad frame (hex, decoded buttons, raw
bitmap, unmapped bits, the signed lever values `paddles`, and `otherPaddles`
if the always-zero locations 2 and 3 ever move), identical frames collapsed
into a count, the first frame of every unknown message type, the handshake
and battery. What the app made of the levers is logged next to it as a
`ride` debug line, `levers → steering S, braking B` with the raw positions
and the assignment, whenever a lever moves by a visible step (at most 20
lines per 10 s); `brake on (keyboard)` / `brake off (keyboard)` record the
brake key.
How to make a useful capture and how to read these lines is described in
[protocols/zwift-ride.md → How to capture](protocols/zwift-ride.md#how-to-capture).
With `FREILAUF_BLE_LOG=1` every raw frame is logged as well, uncollapsed.

### Battery levels

Every change of a device's battery level is logged as
`heartRate "…": battery 64%` (controllers: `battery left 81%, right 12%`)
with the source — `battery-service` (standard Battery Service) or
`controller-protocol` (the controllers' own message, whose raw frame the
controller capture logs with its hex as `battery right 12%`). Reading the
battery never fails a connection: a device without the Battery Service logs
`no battery service` (debug), a failed read or a level that cannot notify
is logged at debug level (`battery-read-failed`, `battery-no-notify`) and
read again later.

### Data summaries

Instead of every packet, each connected device gets a `first data` line and
then every 30 s a summary: packets in the interval and the last power,
cadence and speed (trainer) or heart rate. A connected device that sent
nothing for 30 s is logged as a warning. Trainer commands (simulation
parameters, target power) are logged as `trainer ← …`, at most ten per 10 s
(the rest is counted and reported with the next one).

## What is in the log

- App, Electron, Chromium, Node and OS versions, CPU count, memory size,
  locale and time zone, display sizes, positions and scale factors.
- Device names and Bluetooth ids of the devices you use and of the devices
  the chooser saw nearby while you were pairing (needed to diagnose pairing).
- Battery levels of the connected devices (percent, per controller grip).
- Device protocol details: service and characteristic names, control point
  op codes and results, raw controller frames (hex), error names, messages
  and stack traces.
- Coarse ride information: ride started/paused/finished with duration
  (minutes), distance (km, one decimal), average power, the workout name;
  gear shifts; workout segment changes with their targets; every 30 s the
  last power, cadence and heart rate.
- Which settings changed (the setting's name); the new value only for
  non-personal settings (devices, button mapping, overlay, shifting).
- Messages shown to you (notices), window events, crashes.

## What is not in the log

- **Your name.** The rider name never appears; anywhere it would, it is
  replaced by `[rider]`.
- **Personal settings values**: name, body and bike mass, FTP and the group
  signalling URL are logged only as "changed".
- **Ride data**: no samples, no GPS/positions (Freilauf has none), no start
  times beyond the log line's own timestamp, no ride files.
- **Room codes**: only the first two characters (`AB****`), also inside join
  links; signalling URLs only as `scheme://host:port` (no path, query or
  credentials). Credentials in any URL become `***@`, query strings `?…`.
- **Other riders**: no names, only short peer ids and counts.
- **Your account name in paths**: the home directory is replaced by `~`.

All of this is applied in one place (`redact()` in
`apps/desktop/src/renderer/core/logFormat.ts`, unit-tested) to every line,
in the window before it is sent and again in the main process before it is
written. Still, have a quick look before posting a log publicly: device
names you gave your devices yourself, for example, are kept.

## Robustness

Logging never blocks or breaks the app: lines are queued and written
asynchronously in batches; on quit and on a crash of the main process the
queue is flushed synchronously. If the disk is full or the file is locked,
lines are dropped and counted, and the count is written as soon as writing
works again (`log` source). The window side queues at most 5000 entries.
