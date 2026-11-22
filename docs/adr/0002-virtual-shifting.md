# ADR 0002 — Software virtual shifting via FTMS simulation parameters

Status: accepted · 2026-11-22

## Context

The target bike has a single physical cog. Gears are virtual: when the rider
shifts, the trainer must make the pedals feel as if the gear ratio changed.
The trainer speaks standard FTMS. FTMS offers three ways to influence
resistance:

| Option | Control Point op | What the trainer does |
| --- | --- | --- |
| A. Simulation parameters | `0x11` grade, Crr, wind coefficient | Runs its own road model on its flywheel speed |
| B. Target resistance level | `0x04` unitless level | Applies a fixed brake setting |
| C. Target power (ERG) | `0x05` watts | Holds power regardless of cadence |

## Decision

Use **A, simulation parameters**, and express the virtual gear by scaling
the road that is sent to the trainer.

With `r = virtual ratio / physical ratio`, the virtual bike travels `r` times
as fast as the trainer's flywheel "bike" at the same cadence. Equal crank
torque requires equal power at the trainer's own speed `v_t = v / r`:

```
F_trainer(v_t) = r · m·g·(grade + Crr)  +  r³ · ½ρCdA · v_t²
```

So we send `grade' ≈ r·grade`, `Crr' = r·Crr` (overflow folded into the
grade) and `Cw' = r³·½ρCdA`. Implemented in `effectiveSimulation()`
(`packages/sim/src/gearing.ts`) and checked against the physics model in its
tests. A shift or a gradient change is one Control Point write.

The on-screen speed and distance are **not** taken from the trainer: they
come from our own physics (`stepBike`) driven by measured power. The gear
only changes how that power feels at the cranks (cadence/torque), exactly as
on a real bike.

## Why not the others

- **B, resistance level** is unitless and trainer-specific (on most trainers
  a fraction of maximum brake force, independent of speed). To feel like a
  gear we would have to learn each trainer's level→force curve and run a
  closed loop from the app at BLE rate (≈ 4 Hz, with latency). The force
  would not rise with speed, so there is no natural "spin-out" feel, and a
  wrong curve makes gears uneven.
- **C, target power** removes the relation between cadence and torque
  altogether; it feels like ERG, lags by a second or more, and collapses
  into the well-known "spiral of death" at low cadence. It stays reserved
  for structured workouts.
- With **A** the fast loop (flywheel speed → brake force, inertia feel) stays
  inside the trainer where it runs at kHz rate, the app only writes on
  events, the units are physical and identical across FTMS trainers, and
  Priority 2 (GPX gradient drives the trainer) is the same code path:
  `Shifter.setGradient()`.

## Consequences and known limits

- **Trainer mass is not settable over FTMS.** The trainer multiplies the
  grade by the weight it assumes. `trainerMassKg` compensates if known; by
  default we assume it equals the configured rider + bike mass. To verify on
  the KICKR CORE.
- **`physicalRatio` must match the bike** (chainring/cog actually mounted).
  It only shifts which virtual gear feels "neutral"; default 2.4, user
  setting. To calibrate on the real frame.
- **Grade clamp.** Trainers cap the simulated grade (KICKR CORE: 16 %).
  Hard gears on steep climbs saturate; we clamp at +25/−15 % before sending
  so behaviour is predictable. Field limits: Crr ≤ 0.0254, Cw ≤ 2.54 kg/m.
- **Shift latency** is one BLE write plus the trainer's ramp (expected
  0.3–1 s). Native shifting is faster.
- The driver coalesces writes, so rapid multi-shifts send only the latest
  state.

## Replacing it with native shifting

Everything outside `packages/sim/src/gearing.ts` depends only on the
`Shifter` interface (`shift`, `setGear`, `setGradient`, `onGear`, `resync`).
A `NativeShifter` that sends the gear ratio and gradient through the
trainer's proprietary service can be dropped in where `SoftwareShifter` is
constructed (`apps/desktop`, ride controller); no caller changes.
