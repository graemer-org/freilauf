# Riding real routes (GPX)

Load a GPX file — an Alpine pass, your home loop — and the road's gradient drives the trainer by
itself: it gets harder on the climbs and easier on the descents, while you shift as on a real bike.

> **Status:** tested with simulated devices only (`pnpm dev:sim`). How the gradient changes feel
> on a real trainer has not been confirmed yet — please report what you notice.

## What a GPX file is and where to get one

GPX is the common file format for tracks and routes: a list of points with latitude, longitude
and usually elevation. You can get one by

- exporting a ride you recorded with a bike computer or phone app (most offer "Export GPX"),
- planning a route in any route planner and downloading it as GPX,
- downloading one that someone shared.

Freilauf reads GPX 1.0 and 1.1 tracks (and planned routes without a track). Waypoints, times,
heart rate and other extras in the file are ignored. Files up to 20 MB / 500 000 points.

## Importing

Open the **Routes** tab and import the file. Freilauf shows the length, climbing and the profile.
If the file has several segments they are joined in order (you get a note). A file without any
elevation is accepted as a **flat route** — you are told so.

Four built-in routes are always there: a rolling 12 km loop, a steady 8 km climb at about 6 %, a
short punchy circuit with tight corners, and a flat 20 km out-and-back. They are made up (generated
by the app), not copies of real roads.

## What happens to noisy elevation

Elevation in GPX files is noisy: phone and GPS altitude jumps by metres from point to point, and
barometers drift. Ridden as is, that would make the trainer lurch between −10 % and +15 % on a flat
road. Freilauf therefore:

- removes stray points (GPS spikes, standing still),
- averages the elevation over about 100 m of road and removes short spikes,
- caps gradients at ±25 % and limits how quickly the gradient can change.

The climbing shown is that of the smoothed road. It is usually **lower than what the file's raw
numbers suggest** — on a noisy recording often much lower — and closer to the truth. Very short
steep bits (shorter than about 100 m) are rounded off. Details: [ADR 0004](adr/0004-routes.md).

## Riding it

Select the route and start the ride. While a route is loaded, the route sets the gradient: the
gradient buttons and keys do nothing. The trainer gets a new gradient when the road changes by a
noticeable amount, at most once per second.

- **Loops** (the end is within 50 m of the start) are ridden as laps; an out-and-back that ends
  where it started counts as a loop too.
- **Point-to-point** routes end at the finish; the ride then carries on along a flat road until
  you stop.
- **With a workout**: in ERG steps the trainer holds the target power and the route just moves
  along; in free-ride steps the route's gradient applies.

### Difficulty

**Difficulty** (0–100 %, default 100 %) sets how much of each gradient you feel on the trainer:
at 50 % a 10 % climb feels like 5 %. Your speed on screen, the distance and the recorded ride
still follow the real road — the climb takes as long as it would, you just can ride it in an
easier gear. This is how "trainer difficulty" works in most indoor-cycling apps.

## Sharing in a group ride

You can offer a route to the riders in your group; they can add it to their library with one
click. Group rides only allow small documents (each rider shares at most 32 KB in total, next to
a workout and the friends/challenges data), so longer routes are shared at a coarser resolution:

| Route length | Shared with a point every | Size    |
| ------------ | ------------------------- | ------- |
| up to ~40 km | 10 m (full resolution)    | ≤ 12 KB |
| ~100 km      | 20 m                      | ~15 KB  |
| ~150 km      | 30 m                      | ~15 KB  |
| over ~250 km | not shared                | —       |

Distance, climbing and gradients survive this practically unchanged. A route too long to share at
a usable resolution is refused with a message instead of being sent as a blurred copy; send the
GPX file instead.

## Recording and uploading with a map

A ride along a route records your position and elevation on the route. The `.fit` export carries
GPS positions and altitude, so upload sites show the map, the elevation profile and the climbing.
It is marked as a **virtual ride**. The built-in routes are placed in the open Pacific Ocean so they
never pretend to be somewhere real.

## Where routes are kept

Imported routes are stored in the app's local storage on this computer (desktop app) or in the
browser (browser build), like imported workouts — about 15 KB per 30 km. There is room for about
140 typical or 40 very long routes; delete routes you no longer need if the library is full.
