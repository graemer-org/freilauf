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
simulated devices and shows a **Simulation** badge. On the **Ride** tab, the **Simulation**
panel sets the simulated rider's effort in watts and can drop a device to see what a lost
connection looks like. Everything else — workouts, history, `.fit` export, group rides — works
as with real devices.

## 3. First start

1. Open **Settings → Rider** and enter your **name** (other riders see it in group rides),
   your **mass**, your **bike's mass** and your **FTP** (workouts are scaled by it; an FTP
   test is in the Workouts tab if you do not know yours).
2. Without a paired trainer the app opens on the **Devices** tab.

## 4. Pair your devices

1. Wake the trainer (pedal a few turns) and make sure it is **not connected to another app**
   — the trainer maker's app, another training app, or a phone. A device can only talk to one
   app at a time.
2. **Devices → Pair** next to _Trainer_. A list of nearby devices appears; choose yours.
3. The same for the heart-rate strap and the controllers.

Paired devices are remembered and reconnect automatically the next time you start the app. If
one does not: wake it, close other apps, and click **Retry** or **Pair** again.

### Controllers: buttons and levers

What works with the handlebar controllers of a Zwift Ride smart frame:

- **All sixteen buttons** are decoded (confirmed on real controllers). What each one does is set
  in **Settings → Shifting → Controller buttons**; the row of the button you press lights up and
  "Last button: …" names it, so you can check every button at a glance.
- **The two analog levers** (one per grip) are decoded. Each lever moves both ways, and each
  way can **steer left**, **steer right**, **brake** or do nothing. Braking slows the virtual
  bike only (speed and distance); the trainer's resistance does not change.

How to check and reassign the levers: open **Settings → Shifting → Brake and steering levers**.
Each grip has a bar from −100 to +100 that follows its lever live, with the dead zone around 0
hatched (rest jitter of ±1–2 % never acts), the raw percentage, and what the app makes of it
("Steering: 40 % right", "Brake: 70 %"). Under the bar you choose what happens **when the bar
moves left (−)** and **when it moves right (+)**.

The default assignment was worked out from a recording of the real controllers and **confirmed
on that hardware**: on the
right lever + steers right and − brakes, on the left lever − steers left and + brakes. If
pulling the brake steers instead (or the other way round), press **Swap brake and steer on this
lever** for that grip, or pick each direction yourself; **Reset to defaults** goes back.

Without levers: hold <kbd>S</kbd> to brake, <kbd>A</kbd> <kbd>D</kbd> to steer. In simulation
mode (`pnpm dev:sim`) the Simulation panel on the Ride tab has a slider per lever.

## 5. Ride

- **Ride** tab: start and pause with the button or <kbd>Space</kbd>; shift with <kbd>↑</kbd>
  <kbd>↓</kbd> (or <kbd>+</kbd> <kbd>−</kbd>); change the gradient with <kbd>[</kbd>
  <kbd>]</kbd>; steer with <kbd>A</kbd> <kbd>D</kbd>; hold <kbd>S</kbd> to brake. **Finish**
  saves the ride.
- **Workouts** tab: pick a workout from the library, import `.zwo` files (button or drop them on
  the window), or run an FTP test. In a workout the trainer holds the target power (ERG mode).
- **History** tab: your rides, each with **Export .fit** for the analysis tool you use.

## 6. The overlay

A transparent, always-on-top window with your numbers sits over whatever is on your screen — a
video, a race stream, any app. Clicks go through it to the window underneath.

- To move or resize it, press the **edit hotkey**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>
  (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> on a Mac), drag it, and press the hotkey again.
- **Settings → Overlay** chooses the tiles, the background opacity, whether group riders are
  shown, and the hotkey; you can also turn the overlay off there.

How it behaves over full-screen video on Windows and macOS has not been confirmed yet.

## 7. Ride with friends

In the **Group** tab, click **Create group ride** and send the invite link; a friend pastes it
into their Group tab and you are connected. Nothing to set up: the apps find each other through
public relay servers and then connect directly (this path is not yet verified on real
networks). [Ride with friends](group-rides.md) explains how it works, what the relays see and
what to do when it does not work.

## When something goes wrong

Freilauf always keeps a diagnostic log that leaves out your name and ride data. **Settings →
Diagnostics** exports it, copies the recent part, or opens its folder;
[where it is and what is in it](diagnostics.md). If you tried Freilauf on real hardware, a
report helps a lot — [here is what to include](../README.md#join-in).
