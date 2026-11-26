# Ghost rider

Race an earlier ride of the same route: your best time, your last ride, any ride you pick from
your history, or a ride file from a friend or another app. The ghost rides along as a
translucent rider, and a chip on the scene tells you how far ahead or behind you are, in metres
and seconds. It works alone and needs no network.

> **Status:** tested with simulated devices only (`pnpm dev:sim`).

## Where the ghost comes from

The ghost needs a **route** (a GPX file or a built-in route): it is compared by where you both
are on the road after the same moving time. On a free ride there is no road to compare on, so
the start screen offers no ghost and says so in one line.

Choose a route on the start screen; a **Ghost** line appears under it:

- **My best time** (the default when there is one): the fastest ride of the whole route — start
  to finish on a point-to-point route, a full lap from the start/finish line on a loop.
- **My last ride**: the most recent ride of this route.
- **Pick an earlier ride**: any ride of this route from your history, newest first. Each one
  shows its time, or which part of the route it covers.
- **Import a ride file…**: a `.fit` file — a friend's ride, or one from another app or bike
  computer. It is placed on the route by its GPS track (see below).
- **No ghost**, or the **Race a ghost** switch (also in Settings → Ride) to turn it off.

What you choose is remembered **per route**: the next time you pick that route the same kind
of ghost is ready (an imported file is not kept; the choice falls back to your best time).
Without any earlier ride of the route the line says so and offers the import.

## The race

- The ghost **starts when the countdown reaches zero**, exactly when your time starts, and it
  **pauses when you pause**: both are compared on moving time.
- If you start part-way along the route, the ghost starts there with you.
- **The chip** (top right of the scene, both views): `+12 m · +2.1 s` in green when you are
  ahead, `−8 m · −1.4 s` in red when you are behind. Metres are the distance between you now;
  seconds are how much earlier or later the ghost was at the place where you are.
- **Splits**: at every lap on a loop, at each quarter of a point-to-point route
  (`Lap 2 · +3.4 s`); the latest shows under the gap for 10 seconds, all of them in the summary.
- **The ghost rider** is drawn translucent at its place, in the road view (when ahead of you —
  the camera looks forward) and in the side view (ahead or behind, like group riders).
- **The overlay** shows a pill: `Ghost  +12 m · +2.1 s`.
- **Laps**: on a loop the comparison counts the whole distance along the route, lap after lap.
- **The ghost finishes first**: it waits at the end of its ride ("Ghost waits at the finish")
  while the gap in seconds keeps growing; when you get there the final gap freezes.
- **You finish first**: the final gap is fixed the moment you cross the end of the ghost's ride.

### Jumping along the route during a ghost race

A jump (clicking the profile or the map, [routes.md](routes.md)) moves you; the ghost keeps the
**time gap** you had and is compared with you at the new place from then on: 2 s ahead before
the jump means 2 s ahead after it. If you jump to a part of the route the ghost never rode, the
chip says **"Ghost stopped: it never rode km 7.2"**; jump back into its ride and it carries on
with the gap you had.

### Rides that jumped, as ghosts

A ride that used jump-to-point (or started part-way) does not cover the route continuously.
Freilauf uses **its longest continuous part** as the ghost: across a jump the ride's time says
nothing about the road in between. Such a ride is never your "best time" (only rides that cover
the whole route in one go are), but you can pick it from the list ("jumped · km 4.0–km 9.3").
When you race it from the start, the ghost **joins** where its part begins ("Ghost joins at
km 4.0").

## The summary

After a ghost race the summary says **"You beat your ghost by 12.4 s"** or **"Your ghost was
3.0 s faster"** (with "as far as you both rode" when one of you did not get to the end), the
splits, and — whenever you rode the whole route — your time for it: **"New best time on this
route: 24:00 (was 24:12)"** or, the first time, "Your first time for the whole route".

## Importing a ride file

`.fit` files only (the format almost every bike computer and app exports). Freilauf reads the
file's records (time, position, distance) and its timer events for moving time, and places each
point on the nearest place along the route, searching forward from the previous one — so the
outbound and return legs of an out-and-back and the laps of a loop are told apart. The
**longest part that follows the route** becomes the ghost.

A file is refused, with the reason, when it

- is not a FIT file or is damaged;
- has no GPS positions (an indoor ride without a route): "it cannot be placed on this route";
- is nowhere near the route ("… 12.3 km away at its closest");
- goes the other way along the route;
- follows the route for less than 500 m in one go.

A file that follows only part of the route is used for that part ("Follows 6.2 of 12.0 km of
the route"). Freilauf's own `.fit` exports carry no route id, so they are matched by position
too (the built-in routes lie in the open ocean, so they match only each other). The imported
ghost is kept in memory for this session only; it is never stored.

## What the ghost never changes

The ghost only **reads** the ride: moving time and the place on the route. The recording, the
`.fit` file, points, personal bests, challenges and every command to the trainer are exactly
the same with and without it (tested like the Rumble integration tests:
`rideController.ghost.test.ts` compares the `RecordedRide`, the `.fit` bytes, the community
facts and all trainer commands of the same ride with and without a ghost).

## Privacy and storage

Nothing is stored for the ghost. Ghost traces are derived from the rides already on this
computer when needed (and kept in memory, a few at a time). To make that possible, a ride
along a route now also records **which route** it followed and where on it each part started
(`route: { id, lengthM, loop, offsetsM }` in the ride file): no new information about you —
the positions were already in the samples — only the name of the road they lie on. Rides
recorded before this version have no route id and are not offered as ghosts (export one as
`.fit` and import it, if you want to race it).

## In the browser

The browser version shares this screen: the import uses the browser's file picker; rides are
in the browser's own storage, as always ([docker.md](docker.md)).

## Not (yet) included

Sharing a ghost with friends in a group ride is not part of this version: a group ride
document would have to carry the trace next to the route and the workout within the 32 KB
budget per rider ([routes.md](routes.md#sharing-in-a-group-ride)). Send the `.fit` file
instead.

## Technical notes

- Trace: moving time vs. route position (metres from the route's start, continuing across laps),
  downsampled to a point every 5 m (coarser for very long rides, at most 20 000 points):
  `packages/session/src/ghost.ts` (`rideGhost`, `rideRouteInfo`, `downsampleTrace`,
  `fullRouteTimeS`).
- FIT reading: `packages/session/src/fit/decodeFit.ts` (records, timer events, compressed
  timestamps, both byte orders, developer fields skipped).
- Matching by GPS: `packages/routes/src/match.ts` (`matchTrackToRoute`; tested with the
  out-and-back fixture `fixtures/isar-ursprung.gpx` and synthetic tracks).
- The race: `apps/desktop/src/renderer/core/ghost.ts` (`GhostRace`: anchoring, interpolation,
  jumps, finish, splits; the choice of source), driven by `RideController.setGhost` and
  published as `LiveState.ghost`.
- The ride history lists each ride's route and what it offers as a ghost
  (`RideListItem.route`), so the start screen needs no ride file to pick the best.
- Decisions: [ADR 0010](adr/0010-ghost-rider.md).
