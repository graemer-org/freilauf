# Getting started

From nothing to your first ride: get the app, try it without a bike, pair your devices, use the
overlay, and find the log when something goes wrong. Freilauf is early — please read
[the status](../README.md#status) to know what has been tried on real hardware.

## What you need

- A computer with Bluetooth: Windows, macOS or Linux. (Only Windows 11 has met real hardware
  so far; macOS is untested.)
- A smart trainer that speaks standard Bluetooth FTMS. Optional: a Bluetooth heart-rate strap,
  and the handlebar controllers of a smart frame (buttons and levers decoded; the keyboard always
  works).
- Nothing at all to just look around: simulation mode runs the whole app without hardware.

## 1. Get the app

There are **no published installers yet**, so for now you build it from the source. You need
[Node.js](https://nodejs.org/) 22.18 or newer and [Git](https://git-scm.com/).

```sh
git clone https://github.com/graemer-org/freilauf.git
cd freilauf
corepack enable          # provides the pnpm version the project uses
pnpm install
pnpm dev:sim             # start with a simulated trainer, heart-rate strap and controller
```

Other ways to start it:

| Command        | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| `pnpm dev`     | The app with your real Bluetooth devices                                  |
| `pnpm dev:sim` | The app with simulated devices (simulation mode)                          |
| `pnpm dist`    | Builds an installer for your system into `apps/desktop/release/<version>` |

Installers built this way are not signed, so Windows and macOS warn before opening them;
[releasing.md](releasing.md#unsigned-builds) says what to click.

**In the browser instead:** the web version runs from Docker, for example on a home server.
It needs Chrome or Edge, and HTTPS for Bluetooth; the overlay becomes a small pop-out window.
See [Running Freilauf with Docker](docker.md).

## 2. Try it without a bike

Simulation mode (`pnpm dev:sim`, or `?sim=1` at the end of the web version's address) connects
simulated devices and shows a **Simulation** badge. Press **Start riding** and scroll below the
ride: the **Simulation** panel sets the simulated rider's effort in watts, moves the simulated
levers and can drop a device to see what a lost connection looks like. Everything else —
workouts, routes, history, `.fit` export, group rides — works as with real devices.

## 3. The flow: start screen → ride → summary

Freilauf opens on the **start screen**, which asks one question: _What are you riding today?_

- **What:** **Free ride**, **Workout**, **Route** or **FTP test**. The last choice is already
  selected. Workout and Route open the library as a picker (import, details, the start point on a
  route's profile); **Done** brings you back with the choice named, e.g. "Sweet spot 3×12 · 1 h 7
  min" or "Rolling loop · 12.0 km · starts at km 4.2". A workout and a route can be combined: the
  workout sets the power, the route brings the road and the scenery.
- **With whom:** **Alone** or **Group ride** — create a ride or paste an invite right there
  ([Ride with friends](group-rides.md)).
- **Devices:** one line at the bottom shows trainer, heart rate and controllers; click it for
  pairing. Without a trainer a warning says so — you can still start, power then reads 0.
- **Start riding** starts the ride at once. Someone who changes nothing presses only this.

**The first time only**, the start screen also asks for your **name** (other riders see it in
group rides), your **weight** and your **FTP** (workouts are scaled by it). _I don't know my
FTP_ keeps 200 W and points to the FTP test card. Answer or skip — it is never asked again; the
same values (and the bike's mass) are in **Settings → Rider**.

**After Finish** a short summary shows time, distance, average power, the points of this ride and
of the week, new personal bests, and — after an FTP test — the result with **Save as my FTP**.
**Export .fit**, **Ride again** or **Done** (back to the start screen).

Two quiet places are linked at the top of the start screen: **Activity** (your rides with
`.fit` export, and the [community](community.md): week, leaderboard, challenges, friends) and
**Settings** (rider, overlay, group options, route difficulty, diagnostics, and an _Advanced_
section for rarely needed details).

## 4. Pair your devices

Click the device line at the bottom of the start screen to open **Devices**.

1. Wake the trainer (pedal a few turns) and make sure it is **not connected to another app**
   — the trainer maker's app, another training app, or a phone. A device can only talk to one
   app at a time.
2. **Pair** next to _Trainer_. A list of nearby devices appears; choose yours.
3. The same for the heart-rate strap and the controllers.

Paired devices are remembered and reconnect automatically the next time you start the app. If
one does not: wake it, close other apps, and click **Retry** or **Pair** again.

### Controllers: buttons and levers

What works with the handlebar controllers of a Zwift Ride smart frame:

- **All sixteen buttons** are decoded (confirmed on real controllers). What each one does is set
  in **Devices → Controllers → Controller buttons**; the row of the button you press lights up and
  "Last button: …" names it, so you can check every button at a glance.
- **The two analog levers** (one per grip) are decoded. Each lever moves both ways, and each
  way can **steer left**, **steer right**, **brake** or do nothing. Braking slows the virtual
  bike only (speed and distance); the trainer's resistance does not change.

How to check and reassign the levers: open **Devices → Controllers → Brake and steering levers**.
Each grip has a bar from −100 to +100 that follows its lever live, with the dead zone around 0
hatched (rest jitter of ±1–2 % never acts; its width is under _Advanced_), the raw percentage,
and what the app makes of it
("Steering: 40 % right", "Brake: 70 %"). Under the bar you choose what happens **when the bar
moves left (−)** and **when it moves right (+)**.

The default assignment was worked out from a recording of the real controllers and **confirmed
on that hardware**: on the
right lever + steers right and − brakes, on the left lever − steers left and + brakes. If
pulling the brake steers instead (or the other way round), press **Swap brake and steer on this
lever** for that grip, or pick each direction yourself; **Reset to defaults** goes back.

Without levers: hold <kbd>S</kbd> to brake, <kbd>A</kbd> <kbd>D</kbd> to steer. In simulation
mode (`pnpm dev:sim`) the Simulation panel under the ride has a slider per lever.

### Share with my watch

On Windows, Freilauf can also pass power, cadence, heart rate and the virtual speed and distance
on to a sports watch, which then records the ride too: **Devices → Share with my watch**, switch
it on, and pair the computer on the watch as a power meter, heart-rate sensor and bike sensor
(it appears under the computer's Bluetooth name). New and not yet tried with a real watch;
[Share with my watch](watch-relay.md) has the details, the limits and how to report a test.

## 5. Ride

- **The ride** fills the window: power, the scene, cadence, speed, heart rate, gear, time and
  distance, with the controls at the bottom. Pause and resume with the button or
  <kbd>Space</kbd>; shift with <kbd>↑</kbd> <kbd>↓</kbd> (or <kbd>+</kbd> <kbd>−</kbd>); change
  the gradient with <kbd>[</kbd> <kbd>]</kbd>; steer with <kbd>A</kbd> <kbd>D</kbd>; hold
  <kbd>S</kbd> to brake. **Finish** saves the ride and shows the summary.
- A quiet toolbar on top reaches what you need mid-ride without leaving it: the **device dots**
  (status and reconnect messages), **Group** (riders, invite, start together) and **Overlay**
  (its tiles and opacity). **‹ Start screen** goes back to the start screen while the ride keeps
  recording: a bar on every other screen says _Ride in progress_ and leads back with **Return to
  ride**. A ride is never paused or ended by leaving the view.
- **Workouts** (the Workout and FTP test cards): pick a workout from the library, import `.zwo`
  files (button or drop them on the window), or run an FTP test. In a workout the trainer holds
  the target power (ERG mode).
- **Routes** (the Route card): import a GPX file (from a ride you recorded or a route planner)
  or pick a built-in route, and **Select** it. In the ride the route then sets the gradient, the
  scene shows the road from behind the rider with its bends and hills, and a card shows the map,
  the whole profile and the next few hundred metres. Settings → Routes sets how much of each
  climb the trainer passes on. Tested with simulated devices only so far ([routes](routes.md)).
- **Activity → Rides**: your rides, each with **Export .fit** for the analysis tool you use.

### Power-ups

Every 2–4 km a softly lit gate stands across your lane; ride through it to hold a **power-up**
(Tailwind, Slipstream, Light load or Downhill momentum). Use it with the controller's side
button, <kbd>P</kbd> or a click on its card in the scene's corner. When your power has dropped
for a few minutes, a short effort challenge is sometimes offered — meet it for a power-up, or
ignore it. Power-ups only move your race position among other riders: speed, distance, the
`.fit` file, points and bests always come from your own power. None in ERG steps and FTP tests;
**Settings → Power-ups** switches them (and the challenges) off. Details:
[Power-ups](power-ups.md).

## 6. The overlay

A transparent, always-on-top window with your numbers sits over whatever is on your screen — a
video, a race stream, any app. Clicks go through it to the window underneath.

- To move or resize it, press the **edit hotkey**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>
  (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> on a Mac), drag it, and press the hotkey again.
- **Overlay** in the ride's toolbar (it opens by itself in edit mode, next to the overlay you are
  editing) chooses the tiles, the background opacity and whether group riders are shown; the same
  options and the hotkey are in **Settings → Overlay**, where you can also turn the overlay off.

How it behaves over full-screen video on Windows and macOS has not been confirmed yet.

## 7. Ride with friends

On the start screen choose **Group ride**, click **Create group ride** and send the invite link;
a friend pastes it under **Group ride** on their start screen and you are connected. Nothing to set up: the apps find each other through
public relay servers and then connect directly (this path is not yet verified on real
networks). [Ride with friends](group-rides.md) explains how it works, what the relays see and
what to do when it does not work.

## When something goes wrong

Freilauf always keeps a diagnostic log that leaves out your name and ride data. **Settings →
Diagnostics** exports it, copies the recent part, or opens its folder;
[where it is and what is in it](diagnostics.md). If you tried Freilauf on real hardware, a
report helps a lot — [here is what to include](../README.md#join-in).
