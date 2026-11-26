# ADR 0010 — Ghost rider: route coordinates, continuous parts, jumps and storage

Status: accepted · 2026-11-26

## Context

Riders want to race an earlier ride of the same route — their own best or last ride, any ride
from the history, or a friend's ride file — alone and offline (rider guide:
[ghost.md](../ghost.md)). Constraints: like power-ups and the Rumble
([ADR 0006](0006-power-ups.md), [0008](0008-rumble-items.md)) the ghost must not change the
recording, the `.fit` file, points or the trainer; nothing extra about the rider may be stored;
rides can start part-way and jump along the route ([ADR 0004](0004-routes.md)), routes can be
loops ridden for laps.

## Decision

### 1. Compare in route coordinates, by moving time

A ghost is a **trace**: moving time (s) vs. route position (m from the route's start,
continuing across laps — the ride controller's `offsetM + ridden distance`). The rider is put
into the same coordinates every tick. Two gaps are shown:

- metres: rider position − ghost position at the same moving time;
- seconds: the time the ghost reached the rider's place − the rider's time (both ways positive
  when the rider is ahead), interpolated linearly between trace points.

Moving time (`RideSnapshot.elapsedS`) only advances while riding, so the ghost starts when the
countdown reaches zero and pauses with the rider without any special case.

The race is **anchored** at the rider's start: at ride time 0 the ghost stands where the rider
starts (on a loop at the first place of its ride with the same position modulo the lap). A
ghost whose ride does not cover that place waits and joins when the rider reaches its part.

### 2. Rides with jumps: only the longest continuous part

Across a jump a ride's time says nothing about the road in between, and stitching parts would
let a ghost "teleport". So a stored ride's ghost is its **longest continuous part** (one route
segment, `RideSample.segment`). Only a part that covers the whole route (start to finish on a
point-to-point route, a full lap from the line on a loop) has a **full time** and can be the
"best time". Jumped rides remain selectable and are marked as such. Excluding them entirely was
rejected: a rider who skipped the flat run-in to a climb still wants to race that climb again.

### 3. Jumps during a race keep the time gap

When the rider jumps, the race is re-anchored at the new place with the **seconds gap carried
over**, keeping the lap alignment on a loop. Restarting at zero would erase a hard-earned lead;
freezing the ghost would leave it kilometres away. If the ghost never rode the new place the
chip says "Ghost stopped" and the gap stays as it was; a jump back resumes it.

### 4. Finish

The end of the ghost's ride (the finish of a point-to-point route, or wherever its ride ended
on a loop) decides the race: when the rider crosses it the gap is frozen (interpolated to the
crossing). A ghost that gets there first waits there; its speed is 0, the seconds gap keeps
growing until the rider arrives.

### 5. Storage: the route id on the ride, traces derived when needed

To find the rides of a route and place their samples exactly, a ride along a route now carries
`route: { id, lengthM, loop, offsetsM }` (`RecordedRide.route`; `offsetsM[segment] +
sample.distanceM` is the route position). It is recorded for every route ride, with or without
a ghost, and holds no new personal information (the samples already carry the positions). The
ride history lists, per ride, the route and its ghost summary (`RideListItem.route`: part
covered, full time, continuous), computed when the list is built (desktop: from the ride files;
browser: stored next to the summary). Traces themselves are never stored: they are derived
from the ride when it is chosen and cached in memory (8 at most). An imported file's trace is
kept in memory only. Projecting the samples' GPS positions onto the route instead of storing the
id was rejected: it needs a route to search for every ride in the history and is ambiguous on
out-and-backs, where the metadata is exact and tiny.

### 6. Ride files are matched by GPS

FIT files carry no route id (ours included; the `.fit` export is unchanged). Points are placed
on the nearest place along the route, searched forward from the last one (back 30 m, ahead
300 m + 40 m per second, with places behind or far ahead costing more), so the two legs of an
out-and-back and the laps of a loop stay apart; the starting place of a part is the candidate
the following points follow best. Off the route (60 m) or backwards for 5 points ends a part;
the longest part is used and must follow at least 500 m (80 % of shorter routes). Reasons for
refusal are given in words. The FIT reader is our own (records and timer events only); the
FIT SDK stays a test-only dependency.

### 7. Not shared in group rides (yet)

Sharing a ghost as a group document (`kind: 'ghost'`) is possible with the existing document
mechanism but needs its own encoding, budget split with the route and the workout, and UI;
it is left for later. Riders send the `.fit` file instead.

## Consequences

- `rideController.ghost.test.ts` rides the same ride (with a pause and a jump) with and without
  a ghost and compares the `RecordedRide`, the `.fit` bytes, the community facts and every
  trainer command; the ghost only reads `elapsedS`, `offsetM` and `jumps`.
- Rides recorded before this version have no route id and are not offered (they can be
  exported and imported as files).
- Tests: traces (`packages/session/src/ghost.test.ts`), the FIT reader (`decodeFit.test.ts`),
  matching (`packages/routes/test/match.test.ts`, with the out-and-back fixture), the race
  (`renderer/core/ghost.test.ts`), settings, the App on the browser API
  (`apps/web/src/ghost.app.test.ts`), the UI (`GhostUi.test.ts`) and an e2e spec that rides a
  route twice and races the first ride (`e2e/ghost.spec.ts`).
