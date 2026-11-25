# Share with my watch

Freilauf can pass its live values on to a sports watch over Bluetooth, so the watch records
your indoor ride as well — for its training load, recovery advice and history. The computer
then shows up to the watch like ordinary bike sensors. Freilauf keeps its own recording; the
watch's recording is independent of it.

> **Status:** new and **not yet tried with a real watch.** It works in the app's automated tests
> with a stand-in for the Bluetooth part. If you try it, please report what happened (see
> [Trying it out](#trying-it-out-and-reporting-back)).

**Needs:** the desktop app on **Windows 10 (version 1803 or later) or Windows 11**, and a
Bluetooth adapter that can act as a sensor ("peripheral role"; most built-in adapters of recent
laptops can). On macOS, Linux and in the browser version the switch is disabled and the app says
why.

## What the watch gets

| Shared as                         | Values                                                              | Default |
| --------------------------------- | ------------------------------------------------------------------- | ------- |
| **Heart-rate sensor**             | Heart rate from your strap (only while a strap is connected)        | on      |
| **Power meter**                   | Power from the trainer, and cadence                                 | on      |
| **Bike speed and cadence sensor** | The ride's virtual speed and distance, and cadence                  | on      |
| **Fitness machine (FTMS)**        | Speed, cadence, distance, power and heart rate in one, as a trainer | off     |

The values are updated four times a second. Speed and distance are Freilauf's _virtual_ ones
(what the ride screen shows). The bike sensor counts wheel turns of a **2105 mm** wheel
(700×25C): set the watch's wheel size for this sensor to **2105 mm** — or leave it on automatic
and expect the watch to need a while (or GPS, which it does not have indoors) to learn it. With a
different wheel size the watch's speed and distance are off by the same factor.

When you **pause** the ride in Freilauf, the virtual wheel stops, so a watch with auto-pause
pauses too. Power, cadence and heart rate keep going as measured, just as a real power meter
would.

"Fitness machine" is off by default: it presents the computer as a smart trainer, which most
watches do not use, and some apps would then try to control it. Turn it on only if your watch
or app understands nothing else.

## Switching it on and pairing

1. Open **Devices** (the device line on the start screen) and scroll to **Share with my watch**.
2. Switch on **Share live values with a watch** and choose what to share. Wait for
   _Waiting for a watch_.
3. On the watch, look for new sensors. The computer appears under **its Bluetooth name** — on
   Windows that is the device name shown in Settings → Bluetooth & devices → Devices. It appears
   once per kind: as a heart-rate sensor, a power meter and a bike sensor. Pair the ones you want.
   Once paired, the status says _Connected: 1 device_.
4. Start the watch's indoor cycling exercise and ride in Freilauf.

Pairing is kept: next time, switch sharing on (it stays on until you switch it off) and the
watch finds the computer again.

**Suunto Race 2** (not yet tried with this feature): look for the computer's name in the watch's
sensor settings (on Suunto watches usually Settings → Connectivity → Pair devices), pair the
power meter, heart-rate and bike sensor there, and do it **before starting an indoor cycling
exercise**.

The start screen's device line and the ride toolbar show a small **Watch** badge while sharing
is on: _waiting_, the number of connected watches, or _problem_.

## Limits

- **The name is the computer's.** Windows advertises with the computer's Bluetooth name; Freilauf
  cannot give the sensors their own name.
- **Receiving and sending at once.** The same Bluetooth adapter talks to the trainer, strap and
  controllers and to the watch. Whether it keeps up with both roles depends on the adapter and
  its driver. If values stutter or devices drop, a second (USB) Bluetooth adapter may help.
- **One sensor per type.** Some watches use only one sensor of each kind. If your heart-rate
  strap is also paired with the watch directly, the watch may pick either — pair one or the
  other.
- **Keep Freilauf open.** The watch only gets values while the app runs and sharing is on. With
  no live values for a few seconds, power drops to 0 and the wheel stops.
- **Untested on real hardware**, see above.

## When it does not work

The status line in **Devices → Share with my watch** says what is going on:

- _Not supported on this computer — …_: the adapter cannot act as a sensor, or Bluetooth is not
  available. The reason comes from Windows.
- _Could not start sharing: the Bluetooth radio is off or not available. Trying again…_: turn
  Bluetooth on; Freilauf retries by itself.
- _Waiting for a watch_ but the watch finds nothing: switch sharing off and on, make sure the
  watch is searching for the right sensor type, move the watch closer to the computer.

Everything about it is in the diagnostic log under the source `relay` (Settings → Diagnostics →
Export log; [diagnostics](diagnostics.md)).

## Trying it out and reporting back

1. In the Windows Bluetooth settings, note the computer's device name.
2. Start Freilauf, pair the trainer (and strap) as usual.
3. **Devices → Share with my watch**: switch it on; leave the defaults. Wait for _Waiting for a
   watch_.
4. On the watch, search for sensors. Note under which name and as which types the computer
   appears, and pair the power meter, the heart-rate sensor and the bike sensor (set its wheel
   size to 2105 mm if the watch asks).
5. Start an indoor cycling exercise on the watch and a ride in Freilauf. Ride 5–10 minutes:
   pedal steadily, change effort, stop pedalling for 10 s, pause the Freilauf ride for 30 s and
   resume.
6. Compare: power, cadence and heart rate on the watch against Freilauf; distance at the end.
7. Export the diagnostic log and attach it to an issue together with what you saw. The lines
   that matter start with `relay`: `watch relay helper`, `helper ready`, `Bluetooth adapter`,
   `advertising status`, `subscriptions changed`, `relaying` (once a minute) and any `helper:`
   or `error` lines.

How it is built: [ADR 0005](adr/0005-sensor-relay.md).
