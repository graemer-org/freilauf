# Structured workouts

Code: `packages/workouts` (`@freilauf/workouts`). Pure TypeScript, no dependencies, no DOM/Node
APIs, no timers: everything is driven by the caller passing elapsed time. The ride controller,
the recording, the UI and the P2P layer integrate it; this package only models, validates,
plans and evaluates.

In the app, a workout or an FTP test is chosen on the start screen: the **Workout** and **FTP
test** cards open the library as a picker (import `.zwo` files there; **Done** returns to the
start screen, which names the choice). The running workout is shown in the ride view.

| Module        | Responsibility                                                              |
| ------------- | --------------------------------------------------------------------------- |
| `model.ts`    | `Workout` / `WorkoutStep` types, `WORKOUT_LIMITS`, `validateWorkout`        |
| `timeline.ts` | `buildTimeline`, `targetAt`, `workoutStats`, `powerProfile`, power zones    |
| `runner.ts`   | `WorkoutRunner`: state machine driven by ride time, change flags, controls  |
| `zwo.ts`      | `.zwo` import (`parseZwo`) and export (`workoutToZwo`)                      |
| `xml.ts`      | Internal strict XML reader for untrusted input                              |
| `codec.ts`    | Native share/file format (`encodeWorkout` / `decodeWorkout`)                |
| `library.ts`  | `BUILTIN_WORKOUTS`                                                          |
| `ftpTest.ts`  | FTP test protocols and evaluation (`evaluateTwentyMinuteTest`, ramp test …) |

## Model

All power targets are **fractions of FTP** (`0.75` = 75 % FTP). A workout therefore contains no
watts and can be shared between riders unchanged; watts are computed at ride time as
`round(fraction × FTP × intensity)`.

```ts
interface Workout {
  id;
  name;
  description?;
  author?;
  tags?;
  steps: WorkoutStep[];
}

type WorkoutStep =
  | { kind: 'steady'; durationS; power; cadenceRpm? }
  | { kind: 'ramp'; durationS; powerStart; powerEnd; cadenceRpm? } // warm-up / cool-down
  | {
      kind: 'intervals';
      repeat;
      onDurationS;
      onPower;
      offDurationS;
      offPower;
      onCadenceRpm?;
      offCadenceRpm?;
    }
  | { kind: 'freeRide'; durationS; gradePercent?; expectedPower? }; // no ERG target
// every step: label?: string, cues?: { atS, message }[] (atS relative to the step start;
// for intervals relative to the start of the whole block)
```

- `intervals` expand into `repeat × [on, off]` segments, the last "off" included.
- `freeRide.gradePercent` fixes the simulated gradient (0 = flat road); absent means "whatever the
  ride controller would normally simulate" (route / free ride).
- `freeRide.expectedPower` is only a hint for stats and previews; it is never sent to the trainer.
- Durations are whole seconds.

### Validation and limits

`validateWorkout(unknown)` never throws and returns a **cleaned copy** (unknown properties dropped,
strings sanitised). Everything that enters from outside (files, peers, `.zwo`) goes through it.

| Limit                    | Value                                                   |
| ------------------------ | ------------------------------------------------------- |
| Power target             | 0 – 3.0 (0 – 300 % FTP), finite                         |
| Step / on / off duration | 1 s – 4 h, whole seconds                                |
| Total duration           | ≤ 12 h                                                  |
| Steps                    | 1 – 500                                                 |
| Interval repeat          | 1 – 100                                                 |
| Cadence target           | 20 – 200 rpm                                            |
| Free-ride gradient       | −25 … 25 %                                              |
| Cues                     | ≤ 50 per step, `0 ≤ atS < step duration`, message ≤ 200 |
| `id`                     | `[A-Za-z0-9._-]{1,64}`                                  |
| name / author / label    | 80 / 80 / 40 chars (truncated, name must not be empty)  |
| description              | 2000 chars, line breaks kept                            |
| tags                     | ≤ 16, ≤ 32 chars each, lower-cased, de-duplicated       |

Strings: C0/C1 control characters, zero-width and bidi-override characters are stripped,
whitespace collapsed, lengths capped by code point. Numbers must be finite `number`s (no strings,
no `NaN`/`Infinity`).

## Timeline and queries

`buildTimeline(workout)` flattens the steps into contiguous `Segment`s with absolute
`startS`/`endS`, a `kind` (`steady | ramp | intervalOn | intervalOff | freeRide`), a `mode`
(`erg | free`) and a label (`"Warm-up"`, `"Steady"`, `"Interval 3/8 · on"`, `"Free ride"`,
`"Cool-down"`; a step `label` replaces the default, e.g. `"Sprint 2/4 · off"`).

`targetAt(timeline, elapsedS, ftpW, intensity = 1)` returns the `WorkoutTarget` at a point in
workout time: segment, kind, mode, label, `targetPowerW` (whole watts, `null` in free ride),
`targetFraction`, cadence, gradient, segment elapsed/remaining, total remaining, `next`
(label, start watts, duration), the current `cue` (shown for `CUE_DISPLAY_S` = 10 s) and
`finished`. Ramps interpolate linearly. **An exact boundary belongs to the following segment.**
At/after the end: `kind: 'done'`, `mode: 'free'`, `finished: true`.

`workoutStats(workout, ftpW)` (for list/preview, unrounded): duration, ERG vs free-ride seconds,
average power, normalised-power estimate (30 s rolling mean of the planned per-second targets,
4th-power mean, 4th root; plain mean below 30 s), IF = NP/FTP, TSS = h × IF² × 100, kJ and time in
the classic 7 zones (`POWER_ZONES`, upper bounds 55/75/90/105/120/150 % FTP). Free-ride seconds
count as `expectedPower ?? 0.5` for power/TSS/kJ and are reported separately (`freeRideS`), not in
the zones.

`powerProfile(workout, maxPoints)` returns `[tS, fraction | null][]` for the chart: exact segment
corners if they fit, otherwise `maxPoints` time-bucket averages; `null` = free ride.

## Driving the trainer: `WorkoutRunner`

```ts
const runner = new WorkoutRunner(workout, { ftpW: settings.ftpW, startRideS: session.elapsedS });
// once per ride tick (1 Hz or faster):
const u = runner.update(session.elapsedS);
if (u.changes.modeChanged && u.mode === 'free') trainer.setSimulation(simParams(u.gradePercent));
else if (u.changes.gradeChanged) trainer.setSimulation(simParams(u.gradePercent));
if (u.changes.targetPowerChanged) trainer.setTargetPower(u.targetPowerW!);
if (u.changes.cueChanged) ui.toast(u.cue!.message);
if (u.changes.finished) ui.workoutFinished();
```

- **ERG steps** (`mode: 'erg'`): `Trainer.setTargetPower(watts)`. Virtual shifting does not change
  resistance in ERG; the UI should show gear changes as inactive (or map them to `setIntensity`).
- **Free-ride steps** (`mode: 'free'`): back to simulation mode (`setSimulation`, see
  `docs/adr/0002-virtual-shifting.md`) with `gradePercent` if the step fixes one, otherwise the
  gradient the free ride would normally use. Virtual shifting works as usual.
- **Finished**: mode returns to `free` (the rider keeps riding in simulation mode).
- The first `update()` reports every flag, so the initial trainer state is always applied.
- `targetPowerChanged` is only set in ERG mode and only when the rounded watts differ from the
  last update (or ERG was just entered). Ramps are quantised to whole seconds of the segment, so
  there is at most one write per second.
- Time: the runner advances by the positive delta of the ride time. Pause = ride time stops.
  Small backwards jitter is ignored; a backwards jump > 5 s (`REANCHOR_BACKWARD_S`, e.g. a new
  ride clock) re-anchors without rewinding. Forward jumps may cross several segments. Before ride
  time reaches `startRideS` nothing advances.
- Controls (applied on the next `update()`): `skipSegment()`, `back()` (restart the current
  segment; counts as `segmentChanged`; after finishing: the last segment), `setIntensity(0.5–1.5)`
  (scales every ERG target), `setFtp(w)`. Deterministic: the same inputs give the same outputs.

## `.zwo` import / export

`parseZwo(xmlText)` → `{ ok, workout, warnings } | { ok: false, errors, warnings }`. Supported
subset (element and attribute names are case-sensitive):

| Element                        | Attributes / children                                                                      | Maps to                               |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `workout_file` (root)          | `name`, `description`, `author`, `tags/tag[@name]`, `workout`, `sportType`, `durationType` | metadata                              |
| `Warmup`, `Ramp`               | `Duration`, `PowerLow` (start), `PowerHigh` (end), `Cadence`                               | `ramp`                                |
| `Cooldown`                     | same                                                                                       | `ramp`, forced descending (see below) |
| `SteadyState`                  | `Duration`, `Power` (or `PowerLow`+`PowerHigh` → mean, warning), `Cadence`                 | `steady`                              |
| `IntervalsT`                   | `Repeat`, `OnDuration`, `OffDuration`, `OnPower`, `OffPower`, `Cadence`, `CadenceResting`  | `intervals`                           |
| `FreeRide`                     | `Duration`, `FlatRoad` (≠ 0 → `gradePercent: 0`)                                           | `freeRide`                            |
| `textevent` (inside any block) | `timeoffset` (relative to the block), `message`                                            | cue                                   |

- Powers are FTP fractions as in the file. Durations are rounded to whole seconds. `Cadence="0"`
  means "no target". A `Cooldown` with `PowerLow < PowerHigh` (written the other way round by some
  tools) is read as descending, with a warning.
- Unknown elements and attributes are skipped with a (de-duplicated) warning; text events outside
  their block are dropped with a warning. `sportType=run` and `durationType=distance` are
  rejected. The result is run through `validateWorkout`.
- XML: XML declaration, BOM, comments, CDATA, processing instructions, `&amp; &lt; &gt; &quot;
&apos;` and numeric references are supported. **Rejected:** malformed XML (mismatched/unclosed
  tags, duplicate or unquoted attributes, text outside the root), any `<!DOCTYPE …>` or other
  declaration (so no entity declarations and no expansion at all), unknown entities, invalid
  character references, nesting > 32, > 20 000 elements, input > 1 MiB (UTF-8).
- The id is derived from the name plus a hash of the file (`zwo-<slug>-<hash>`), so re-importing
  the same file yields the same id.

`workoutToZwo(workout)` exports for other tools: a rising first ramp becomes `Warmup`, a falling
last ramp `Cooldown`, other ramps `Ramp`. Lossy: step labels, `expectedPower` and free-ride
gradients other than 0 are dropped. `parseZwo(workoutToZwo(w))` reproduces everything else.

## Native format and sharing

```json
{ "format": "freilauf-workout", "version": 1, "workout": { "id": "…", "name": "…", "steps": [ … ] } }
```

- File extension: `WORKOUT_FILE_EXTENSION` = `.freilauf-workout.json`.
- `encodeWorkout(w)` validates first (throws `TypeError` on an invalid workout — a programming
  error) and writes compact JSON.
- `decodeWorkout(text)` never throws; rejects > 64 KiB (`MAX_ENCODED_WORKOUT_BYTES`, UTF-8),
  non-JSON, a wrong `format`, and any major version other than 1 (`1.x` accepted, unknown fields
  dropped), then runs `validateWorkout`.
- Size: a typical 1 h workout encodes to **≈ 0.7 KB** (Sweet spot 3×12: 681 bytes; the largest
  built-in, the 20-min FTP test with many cues, 1.5 KB; the 43-step ramp test 3.2 KB). That fits a
  single data-channel message (16 KiB mesh limit, see `docs/p2p.md`) with room to spare.

## Built-in library

`BUILTIN_WORKOUTS` (all original, validated in tests): Easy endurance 45, Sweet spot 3×12,
Threshold 2×20, VO2max 5×4, 30/30s, Over-unders 3×12, Openers 30 and the 20-minute FTP test.

## FTP tests

Both protocols are ordinary workouts plus metadata (`FtpTestProtocol`: `kind`, `workout`,
`effortStepIndex`, `factor`, `openEnded`); `FTP_TESTS` lists them.

- **20-minute test** (`TWENTY_MINUTE_TEST`): 10 min warm-up ramp, 3 short openers, easy spin, a
  5-min clearing effort at 105 %, recovery, then **20 min all-out as a `freeRide` step** (no ERG:
  the rider paces themself in simulation mode on a constant 1 % gradient using virtual gears),
  cool-down. FTP = 95 % of the 20-min average power.
- **Ramp test** (`RAMP_TEST`): 5 min warm-up, then 1-min ERG steps starting at 46 % and rising
  by 6 % per minute up to 298 % (the model's cap). Open-ended: the test ends when the rider can no
  longer hold the target. FTP = 75 % of the best 1-min average power.
  Steps are **relative to the rider's current FTP estimate** (not fixed watts) so the test takes a
  similar time for every rider: a rider whose estimate is right fails around 133 % (FTP = 75 % of
  the best minute), i.e. after ~15 minutes of ramp. With fixed watt increments a weak rider would
  fail after a few minutes and a strong one would ride 40. The estimate does not
  affect the result (only the best minute counts), only how quickly the ramp gets there.
  Run tests with intensity 1.

Evaluation (pure, over 1 Hz `{ elapsedS, powerW, heartRateBpm?, cadenceRpm? }` samples —
`RideSample` fits; gaps and non-finite values are tolerated):

- `bestAveragePower(samples, windowS)` → `{ averagePowerW, startS } | null`. Samples are bucketed
  per second; a window counts if ≥ 90 % of its seconds have data and is averaged over those.
- `evaluateTwentyMinuteTest(samples, effortStartS, effortEndS)` → `{ valid, reason?,
averagePowerW, ftpW, averageHeartRateBpm?, sampleCount }`. Invalid (`reason`) if the window is
  not ~20 min, the effort was cut short (no data in the last 10 s), < 90 % of the seconds have
  data, or the average is < 30 W.
- `evaluateRampTest(samples, rampStartS)` → `{ valid, reason?, bestOneMinutePowerW, ftpW,
maxHeartRateBpm?, rampDurationS }`. Invalid if the ramp lasted < 3 min or no 1-min window
  qualifies.
- `detectRampFailure(samples, timeline, ftpW, nowS, { workoutStartRideS?, fromS?, intensity? })`
  → `true` when every sample of the last 10 s is below 80 % of its ERG target (≥ 8 samples), when
  power or cadence has been 0 for the last 5 s (≥ 4 samples), or when the timeline has run out.
  Pass `fromS` = ramp start so a slow start in the warm-up is not a failure.
- `ftpTestEffortWindow(protocol, workoutStartRideS)` gives the effort window on the ride clock
  (assuming no skip/back during the test).

FTP is rounded to whole watts. The result is **offered** to the rider ("Save 276 W as your new
FTP?" — in the app, on the post-ride summary with **Save as my FTP**); on confirmation the
integrator stores `ftpW` in the settings. This package never stores
anything.

## Integration checklist

**Ride controller**

- [ ] Create a `WorkoutRunner` when the rider starts a workout (`startRideS` = current ride
      time); call `update(rideElapsedS)` on every tick; act only on `changes` (see above).
- [ ] ERG ↔ simulation switching via `modeChanged`; free-ride gradient via `gradeChanged`.
- [ ] Bind skip / back / intensity ± (e.g. 5 % steps) to UI and controller buttons.
- [ ] When `finished`, drop the runner and continue in free ride.
- [ ] FTP tests: on the ramp test call `detectRampFailure(..., { fromS: rampStart })` each tick and
      end the test when it returns true; then run the evaluator and offer the result.

**Recording (`packages/session`)**

- [ ] Add per-sample fields: `targetPowerW: number | null`, `workoutSegmentIndex: number | null`,
      optionally `trainerMode: 'erg' | 'free'` and `intensity`.
- [ ] Store `workoutId`/`workoutName` (or the encoded workout) on the `RecordedRide`; in FIT
      export, laps per segment are a natural fit.

**P2P (`packages/p2p`, not implemented here)** — suggested messages on the data channel:

```jsonc
// host → everyone (once, and to each rider who joins later). < 2 KiB for typical workouts.
{ "type": "workout-share", "shareId": "k3j…", "envelope": { "format": "freilauf-workout", "version": 1, "workout": { … } } }
// host → everyone: synchronised start at a host-chosen group-ride time (or wall clock + offset).
{ "type": "workout-start", "shareId": "k3j…", "startAtGroupS": 1234.0 }
// host → everyone: optional sync controls
{ "type": "workout-control", "shareId": "k3j…", "action": "skip" | "back", "atGroupS": 1500.0 }
{ "type": "workout-stop", "shareId": "k3j…" }
```

- [ ] Receivers decode with `decodeWorkout` (validation is part of it — never trust a peer).
- [ ] Each rider runs their own `WorkoutRunner` with **their own FTP** and intensity; only the
      plan and the start time are shared. Late joiners start the runner and `update()` with the
      current shared time, which jumps them to the right segment.
- [ ] The rider state broadcast could carry `segmentIndex` so others see who is where.
