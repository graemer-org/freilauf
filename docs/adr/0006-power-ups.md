# ADR 0006 — Power-ups: race offset vs. recorded physics, determinism, extension points

Status: accepted · 2026-11-25

## Context

Riders asked for some play in a ride: power-ups collected on the road or earned by effort,
used with the controller's side buttons (rider guide: [power-ups.md](../power-ups.md)). The
maintainer's conditions: effects act on the virtual ride only, never on trainer resistance;
**nothing recorded changes** (speed, distance, the `.fit` file, points, personal bests,
community challenges); no power-ups in ERG steps and FTP tests; group riders on the same route
meet the same pick-ups; a host can switch them off for a group. A battle mode for group rides
will be built on top later, so the core must take more card kinds, effects aimed at another
rider and a hand of several cards without a rewrite.

## Decision

### 1. A pure engine driven by the ride

`apps/desktop/src/renderer/core/powerUps.ts` holds `PowerUpEngine`: no timers, no DOM, no
clock. The ride controller creates one at the start of each ride and calls
`update(tick)` once per tick with the ride time, the recorded distance, the route position,
speed, power (instant and 3 s), gradient, brake, the bike parameters, the FTP, whether power-ups
are blocked now (`'off' | 'erg' | 'ftpTest' | 'group'`) and whether challenges are on.
`update` returns the events of the tick (`picked`, `skipped`, `started`, `ended`, `expired`,
`challenge-*`) and `toLive()` gives a plain, JSON-serialisable `PowerUpLive`
(`shared/powerUps.ts`) for the window, the overlay and later the network.

### 2. Determinism

- Pick-up spots come from a seeded generator (FNV-1a → mulberry32): spacing uniform in
  [2 km, 4 km]. On a route the seed is `route:<base route id>` and the spots are **route
  positions**, so every rider on that route — whatever their start point, after jumps, on every
  lap of a loop — meets the same spots, with the same kind at each spot (`kindFor(seed, index)`).
  In a free ride the seed is the ride id and the spots are ridden distances.
- A spot is collected when the position passes it between two ticks; a move of more than 80 m
  in one tick (a jump along the route) collects nothing. Loops are handled across the finish
  line; no spot lies within half the minimum spacing of it.
- Everything else (effect timing, challenge windows) runs on ride time, which only advances
  while riding, so a paused ride pauses power-ups too.

### 3. Race offset instead of changed physics

Recorded physics stay exactly as they were: `RideSession` and `stepBike` are **unchanged**
(so existing results are byte-identical by construction, not by a no-op default). The engine
integrates a **shadow bike** next to the real one: each tick it steps
`stepBike(shadowSpeed, power, gradient, modifiedBike(bike, modifiers), dt, brake)` with the
active effect's modifiers (factors on CdA, mass and Crr) and adds the difference between the
shadow's distance and the recorded distance of that tick to the **race offset**. Without an
effect the shadow keeps its extra speed and bleeds it off through normal physics; once it is
within 0.01 m/s of the real bike it rejoins it (no drift). The offset never goes below 0.

- The race position is recorded position + race offset. It is used for **placement**: the
  rider broadcasts `raceOffsetM` and others place them by ridden distance (or route position)
  - `raceOffsetM`, and count their own offset the same way (`RemoteRiders.getRiders(…,
localRaceOffsetM)`). The group list and both scenes therefore show race positions.
- The recording, the `.fit` file, community facts (points, bests) and challenges are computed
  from `RecordedRide`, which never sees the engine. Tests prove it: a ride with power-ups used
  and the same ride with power-ups off produce identical `RecordedRide`s, identical `.fit`
  bytes and identical `rideFacts` (`rideController.powerUps.test.ts`), and the engine test
  checks the real bike's distance and speed to the bit.
- The gradient for the shadow is the real bike's (a few tens of metres apart, the difference
  is immaterial), and the scenes draw the rider at the recorded position: what the rider sees of
  the road is what the trainer feels. The gain is shown as "+38 m from power-ups".

Alternative considered: optional modifiers on `stepBike` used for the real bike plus a separate
"physics-only" integration for the recording. Rejected: it inverts the risk (the recording
would become the shadow) and touches the session.

### 4. Where power-ups do not apply

The controller decides `blocked`: `off` (Settings), `ftpTest` (any FTP test), `erg` (an ERG
step is running or applied), `group` (in a group whose host sent `rules.powerUps = false`).
While blocked no spots are reported or collected, nothing can be used, an active effect ends
and no challenge is offered (ERG seconds also disqualify the challenge windows); held cards
stay, an armed effect waits.

### 5. Group rules

A host-level switch is carried in the rider-state broadcast, not in a shared document: an
optional `rules: { powerUps: boolean }` sent only by the host (the rider who created the ride),
validated on receipt (unknown fields dropped). Guests use the rules of the first peer that
sends any; the host uses its own. Old clients ignore the field. `raceOffsetM` is likewise an
optional, validated field (0 … 100 km).

### 6. Activation

Controller action `usePowerUp`, default for both "lever click / side button" buttons
(`powerUpLeft`, `powerUpRight`). Settings from before power-ups (no `powerUps` key) are migrated
once on load: those two buttons get `usePowerUp` where they were unset or `'none'`; a custom
action stays. The keyboard key is **P** (free in the ride view), and the held card is a button.

## Extension points for a battle mode

- **More kinds**: add to `PowerUpKind` / `POWER_UP_INFO` (`shared/powerUps.ts`) and
  `POWER_UP_DEFINITIONS` (engine); the compiler lists every place that must know a kind. A
  definition is `durationS`, optional `armedS` + `fires(ctx)`, `modifiers(ctx)` and `target`.
- **Effects on another rider**: `target` exists for that (only `'self'` so far). A battle mode
  sends the effect over the group and the receiving engine calls `applyEffect(kind, source)`;
  effects combine multiplicatively (`combineModifiers`), `maxEffects` sets how many at once.
  Effects that should slow a rider would be modifiers > 1 — the race offset may then need to go
  negative (today it is clamped at 0, by design, for "power-ups only help").
- **A hand of cards**: `capacity` in `PowerUpConfig`, `hand` in `PowerUpLive`, `activate(index)`.
- **Other sources of cards**: `grant(kind)` (challenges use it).
- **Wire format**: `toLive()` is plain JSON; the rider state already carries `raceOffsetM` and
  `rules` (extend `GroupRules` with battle fields).
- **Tuning**: `powerUpConfig(tuning)` validates overrides (spacing, challenge windows, the kind
  pool); the app reads them only in simulation mode (localStorage
  `freilauf.powerUps.tuning`), which the end-to-end tests use.

## Consequences

- Fair by construction: the recorded ride does not depend on power-ups at all.
- Two riders' race positions are consistent across the group because both sides add offsets the
  same way; a rider's own scene still shows the recorded position (the gain is a number).
- A battle mode can be built on the engine and the broadcast fields without changing the
  recording, the physics package or the session.
