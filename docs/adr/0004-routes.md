# ADR 0004 — Routes: preparation, gradient control, difficulty, storage and sharing

Status: accepted · 2026-11-23

## Context

A rider loads a GPX file (an Alpine pass, a home loop) and the route's gradient drives the
trainer by itself. GPX elevation is noisy (GPS altitude, barometric steps, planner DEM
artefacts), point spacing is uneven (1 s recordings 3–10 m apart, planner exports up to
several hundred metres apart), and the trainer is controlled through one FTMS Control Point
write per change (ADR 0002). Routes must also be stored locally and shared in a group ride,
where a rider's documents are capped at 4 documents / 32 KiB (docs/p2p.md).

Implemented in `packages/routes` (pure, no dependencies) and wired in
`apps/desktop/src/renderer/core/rideController.ts`, `core/routeLibrary.ts`,
`core/routeSharing.ts` and the app store.

## Decision

### 1. Preparation (`prepareRoute` / `buildRoute`)

1. **Clean**: drop points < 0.5 m from the previous one (stationary/duplicates). Drop a
   **GPS spike** — a single point the track leaves and immediately returns from — when both
   legs are longer than max(200 m, 10 × the file's median spacing) and the direct line between
   its neighbours is < 25 % of that. Speed-independent, and scaled to the file so a planner's
   sparse turnaround point (an out-and-back with 100 m spacing) is kept.
2. **Distance**: haversine between points (well below 0.5 % error at any scale).
3. **Loop**: end within 50 m of the start and longer than 500 m. The gap is closed with the
   first point, and the elevation difference between end and start (barometric drift) is
   spread linearly over the lap so there is no step at the finish line. An out-and-back whose
   end is its start is therefore ridden as laps.
4. **Step**: 10 m. Routes over 200 km use `ceil(length / 19 999)` m so that `count ≤ 20 000`
   (a 300 km route gets 15 m); the step is then adjusted slightly so that `(count − 1) × step`
   is exactly the route length. Routes must be 100 m … 1000 km.
5. **Positions**: lat/lon interpolated linearly along the distance; x/y from an
   equirectangular projection around the first point (exactly invertible, so the codec can
   store x/y only).
6. **Elevation** (`DEFAULT_SMOOTHING`), deterministic:
   - **Cell means**: each sample takes the exact mean of the piecewise-linear raw profile over
     its ±5 m cell, so dense noisy recordings average out instead of aliasing, and uneven
     points are weighted by the distance they cover.
   - **Median over 50 m** (5 samples): removes spikes up to ~20 m long.
   - **Gaussian, σ = 40 m** (kernel ±120 m), with odd reflection at the ends (a straight
     slope stays straight to the end) and periodic continuation on loops.
   - **Gradient cap ±25 %**, then **rate limit 0.15 percentage points per metre** (1.5 % per
     10 m, applied forward-then-backward and backward-then-forward and averaged, so it is
     symmetric). Height moved by the rate limit is given back by a linear correction; height
     removed by the cap stays removed (except on loops, which must close).
   - **Ascent/descent** with a 1 m dead band, the usual guard against residual ripples.

   What this does (tests in `build.test.ts`): a 5 km 6 % climb recorded with σ = 1.5 m
   elevation noise every 4–9 m plus occasional ±20 m glitches has a raw "ascent" over 750 m
   (2.5× the truth); prepared, the ascent is within 2 % of the true 300 m, the median gradient
   error 0.6 %, the 95th percentile < 1.5 %, the worst sample < 2 % (excluding the first and
   last 100 m, which see noise from one side only). A flat road with σ = 2 m noise stays
   within ±2 % and gains < 5 m. The real fixture (98 km river-valley out-and-back, planner
   export, DEM elevations) keeps its shape: raw 762 m → 713 m ascent, gradients −7.0 … +7.1 %,
   95th percentile 4.2 %. Trade-off: σ = 40 m rounds a 150 m long 12 % ramp to ~11 %; that is
   rideable and closer to what a trainer can follow anyway. σ = 25 m (tried) left 6 % peaks on
   noisy flat recordings.

7. **Headings**: atan2 of the central difference of x/y, unwrapped, Gaussian σ = 10 m;
   curvature is their derivative (1/m, + = bending right), capped at ±0.2 (5 m radius: U-turns
   of out-and-back routes). A quarter circle of radius r yields ≈ 1/r (tested).
8. **Id**: FNV-1a over sample count, step and a subsample of lat/lon/elevation: the same
   content always gets the same id.

### 2. Gradient → trainer (update policy)

Every tick (4 Hz) the controller looks up the position from the distance ridden so far and
sets the **road gradient** for the speed physics and the recording. The **trainer gradient**
(road × difficulty) goes through the existing `Shifter.setGradient` path when it differs from
the last value sent by **≥ 0.15 percentage points and ≥ 1 s** has passed since the last send;
smaller differences are sent after **5 s**, so the trainer ends up exactly on the road. With
10 m samples and σ = 40 m smoothing the gradient changes slowly; on a 6 % climb this is one
write every few seconds, never more than one per second (tested). Gear shifts still send
immediately (ADR 0002), with the current route gradient. On trainer reconnect the shifter
resyncs with it. While a route is loaded, manual gradient controls are ignored
(`LiveState.routeControl.gradientLocked`).

**With a workout**: in ERG segments the trainer holds the power; the route still advances
and is shown, and the shifter's sink drops simulation writes (they would end ERG). In free
segments the route's gradient wins over the workout's `gradePercent`. Leaving ERG resyncs the
trainer with the current route gradient.

**Point-to-point**: past the finish the ride continues on a flat road (`route.finished`); on
a loop the ridden distance wraps (`route.lap`). The route stays selected after the ride.

### 3. Difficulty

`Settings.route.difficulty`, 0 … 100 %, default 100. It scales **only what the trainer makes
the rider feel**; speed, distance and the recorded gradient always use the real road. This
is the standard behaviour of indoor-cycling apps' "trainer difficulty": the virtual ride stays
true to the route (a 10 % climb is as slow as a 10 % climb at the rider's power), the rider
just gets a lower effective resistance and therefore an easier gear choice. Scaling both
would make the route a different (flatter) route, which is what a flat route is for. Descents
are scaled alike (the trainer cannot push anyway; scaling avoids a sudden drop to minimum
resistance at 50 %). The value in effect and the gradient sent are in
`LiveState.routeControl`.

### 4. Storage: localStorage, not files

The codec stores a route at full resolution in ~4.7 characters per 10 m sample
(positions 0.1 m, elevation 0.1 m): a 30 km route ≈ 14 k characters, the 98 km fixture 46 k,
the largest possible route (20 000 samples) ≈ 95 k. localStorage allows ~5 M characters per
origin, shared with the workout library and the community state (realistic 0.1–0.5 M, see
docs/community.md). Routes get their own budget of **2 M characters** (~40 long or ~140
typical routes; at most 100) and one key per route, so an import writes only that route.
That comfortably holds "a handful of long routes", keeps `importRoute` synchronous and needs no
new IPC, main-process files or IndexedDB code. Imports beyond the budget are refused with a
clear message; a failing write (quota) keeps the route in memory with a warning. If routes
ever need more, an additive `FreilaufApi.routes` (files under `userData/routes/`) can replace
the storage behind `RouteLibrary` without touching callers.

### 5. Sharing

Kind `route`, text `encodeRoute(track)`. A rider's documents: workout (≤ ~3 KB typical),
community standing (≥ 1 KiB kept), challenges/relays (make room) — four slots and 32 KiB in
total. The route gets `min(15.5 KiB, 32 KiB − workout − max(1 KiB, standing) − 256 B)`;
`CommunityService.makeRoom(bytes, slots)` now also frees a document slot (challenges, then
relays go first; the standing last), and `shareWorkout` reserves its slot the same way.

`simplifyForSharing` tries steps 10, 15, 20, 25, 30, 40, 50 m (positions quantised to a tenth
of the step) until the route fits: **30 km → 10 m (≈ 9 KB)**, **98 km → 20 m (≈ 15 KB)**,
**150 km → 30 m (≈ 15 KB)**. Beyond a 50 m step short climbs disappear, so a route that does
not fit at 50 m (roughly > 250 km) is **refused with the reason** instead of being sent as mush.
The receiver decodes (and thereby validates) every route; a coarser shared route gets a
derived id (`<id>-30m`) so it never overwrites the full-resolution original.

### 6. Recording

`RideSample` gains optional `lat`/`lon`/`altitudeM`, filled from the route at each 1 Hz sample's
exact distance. The FIT encoder writes `position_lat`/`position_long` (semicircles),
`altitude` and `enhanced_altitude` (scale 5, offset 500) into records, and start/end position,
bounding box (`nec`/`swc`), total ascent/descent and enhanced min/avg/max altitude into lap and
session — through separate message definitions, so rides without positions are byte-identical
to before. Sub-sport stays `virtual_activity`.

## Consequences

- Elevation detail shorter than ~100 m is smoothed away by design.
- The first/last ~100 m of a point-to-point route are less well smoothed (one-sided data).
- Equirectangular x/y distort by ~2 % 100 km from the start (drawing only).
- Everything here is tested with simulated devices only; the update policy's feel on a real
  trainer (KICKR CORE ramps resistance over ~1 s) is still to be confirmed.
