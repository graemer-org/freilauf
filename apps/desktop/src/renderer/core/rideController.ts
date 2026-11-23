import type {
  Controller,
  ControllerButtonEvent,
  Device,
  DeviceKind,
  HeartRateSensor,
  Trainer,
  Unsubscribe,
} from '@freilauf/devices';
import type { GroupRider } from '@freilauf/p2p';
import type { RecordedRide, RideSnapshot } from '@freilauf/session';
import { RideSession } from '@freilauf/session';
import type { BikeParams, Shifter } from '@freilauf/sim';
import { DEFAULT_BIKE, SoftwareShifter } from '@freilauf/sim';
import type { FtpTestProtocol, Timeline, Workout } from '@freilauf/workouts';
import {
  WorkoutRunner,
  buildTimeline,
  detectRampFailure,
  evaluateRampTest,
  evaluateTwentyMinuteTest,
  ftpTestEffortWindow,
} from '@freilauf/workouts';
import type {
  DeviceStatus,
  FtpTestOutcome,
  LiveState,
  Settings,
  WorkoutLive,
} from '../../shared/contract';
import { combineSteering, leverOutput } from './levers';
import type { LeverOutput } from './levers';
import { RateLimiter } from './logFormat';
import type { ScopedLog } from './logger';
import { NULL_LOG } from './logger';

/** The part of a group ride the controller needs; implemented by @freilauf/p2p's GroupRide. */
export interface GroupLink {
  readonly roomCode: string;
  setLocalState(state: {
    name: string;
    distanceM: number;
    speedMps: number;
    powerW: number;
    cadenceRpm: number;
    heartRateBpm: number | null;
    gear: number;
  }): void;
  getRiders(): GroupRider[];
}

export interface RideControllerOptions {
  settings: Settings;
  now?: () => number;
  /** Called on every tick with the state to show (main window + overlay). */
  onLive: (state: LiveState) => void;
  /** Persists a ride; called every autosave interval while riding and once when finished. */
  saveRide: (ride: RecordedRide, finished: boolean) => Promise<void>;
  onError?: (message: string) => void;
  /** Diagnostic log (source "ride"). */
  log?: ScopedLog;
}

/** Where a gear change came from, for the diagnostic log. */
export type ShiftSource = 'ui' | 'keyboard' | `button:${string}` | (string & {});

const AUTOSAVE_INTERVAL_MS = 30_000;
/** Rides shorter than this are discarded on finish (accidental start). */
const MIN_RIDE_SAMPLES = 10;

type Devices = { trainer: Trainer; heartRate: HeartRateSensor; controller: Controller };

/** A workout chosen for the next (or current) ride. */
interface Plan {
  workout: Workout;
  timeline: Timeline;
  ftpTest: FtpTestProtocol | null;
  /** Created when the ride starts. */
  runner: WorkoutRunner | null;
  /** What the trainer was last told, so we only write on change. */
  applied: { mode: 'erg' | 'free'; targetPowerW: number | null; gradePercent?: number } | null;
  /** Ramp test: the rider could not hold the target any more. */
  endedEarly: boolean;
  lastFailureCheckS: number;
}

export interface FinishedRide {
  ride: RecordedRide;
  /** Present when the ride was an FTP test. */
  ftpTest: FtpTestOutcome | null;
}

const INVALID_REASONS: Record<string, string> = {
  'invalid-window': 'The test effort could not be located in the ride.',
  'window-too-short': 'The test effort was too short.',
  'cut-short': 'The ride ended before the test effort was complete.',
  'too-few-samples': 'Too much of the test effort has no power data.',
  'no-power': 'No power was recorded during the test effort.',
};

/**
 * Wires devices, virtual shifting, the ride session and the group together.
 * No timers and no DOM: the owner calls tick() about four times per second.
 */
export class RideController {
  readonly #now: () => number;
  readonly #options: RideControllerOptions;
  #settings: Settings;
  #session: RideSession;
  #shifter: SoftwareShifter;
  #devices: Partial<Devices> = {};
  #unsubscribe: Partial<Record<DeviceKind, Unsubscribe[]>> = {};
  #group: GroupLink | null = null;
  #gradePercent = 0;
  #lastAutosaveAt = 0;
  #plan: Plan | null = null;
  #steerButtons = new Set<'steerLeft' | 'steerRight'>();
  /** Signed lever positions, −1 … 1 per grip (see levers.ts). */
  #paddles = { left: 0, right: 0 };
  /** Brake from outside the controller (keyboard), 0 … 1. */
  #manualBrake = 0;
  readonly #log: ScopedLog;
  /** Trainer commands are frequent while shifting: summarise beyond a few per 10 s. */
  readonly #commandLimit: RateLimiter;
  /** Lever results for the diagnostic log: a few lines per second at most. */
  readonly #leverLimit: RateLimiter;
  #lastLeverLog = '';
  #lastSegment = '';

  constructor(options: RideControllerOptions) {
    this.#options = options;
    this.#settings = options.settings;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? NULL_LOG;
    this.#commandLimit = new RateLimiter(10, 10_000, this.#now);
    this.#leverLimit = new RateLimiter(20, 10_000, this.#now);
    this.#session = this.#newSession();
    this.#shifter = this.#newShifter();
  }

  /** The seam for native shifting later: everything else only sees Shifter. */
  get shifter(): Shifter {
    return this.#shifter;
  }

  get rideState(): RideSnapshot['state'] {
    return this.#session.state;
  }

  /** Attaches (or with null detaches) a device. Does not connect or disconnect it. */
  setDevice<K extends DeviceKind>(kind: K, device: Devices[K] | null): void {
    for (const off of this.#unsubscribe[kind] ?? []) off();
    const subs: Unsubscribe[] = [];
    this.#unsubscribe[kind] = subs;
    if (kind === 'controller') this.#releaseController();
    if (!device) {
      delete this.#devices[kind];
      return;
    }
    (this.#devices as Record<DeviceKind, Device>)[kind] = device;

    if (device.kind === 'trainer') {
      subs.push(
        device.onData((data) => {
          if (data.powerW !== undefined) this.#session.setPower(data.powerW);
          if (data.cadenceRpm !== undefined) this.#session.setCadence(data.cadenceRpm);
        }),
        // A (re)connected trainer knows nothing about the current gear, gradient or target.
        device.onState((state) => {
          if (state === 'connected') this.#resyncTrainer();
        }),
      );
      if (device.state === 'connected') this.#resyncTrainer();
    } else if (device.kind === 'heartRate') {
      subs.push(device.onHeartRate((bpm) => this.#session.setHeartRate(bpm)));
    } else {
      subs.push(
        device.onButton((event) => this.#onButton(event)),
        device.onPaddle(({ side, value }) => {
          // Signed: each lever moves both ways, each direction has its own function.
          this.#paddles[side] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        }),
        // Nothing stays "held" when the controller goes away.
        device.onState((state) => {
          if (state !== 'connected') this.#releaseController();
        }),
      );
    }
  }

  setGroup(group: GroupLink | null): void {
    this.#group = group;
  }

  updateSettings(settings: Settings): void {
    const before = this.#settings;
    this.#settings = settings;
    this.#plan?.runner?.setFtp(settings.rider.ftpW);
    const changed =
      before.rider.massKg !== settings.rider.massKg ||
      before.rider.bikeMassKg !== settings.rider.bikeMassKg ||
      before.shifting.physicalRatio !== settings.shifting.physicalRatio ||
      before.shifting.trainerMassKg !== settings.shifting.trainerMassKg;
    if (changed) {
      this.#shifter = this.#newShifter(this.#shifter.gear);
      this.#shifter.resync();
      // Mass changes apply to the next ride; a running session keeps its physics.
      if (this.#session.state === 'idle') this.#session = this.#newSession();
    }
  }

  /**
   * Chooses the workout for the next ride (null = free ride). Only possible
   * while no ride is in progress. Pass the protocol for FTP tests so the
   * result can be evaluated at the end.
   */
  selectWorkout(workout: Workout | null, ftpTest: FtpTestProtocol | null = null): boolean {
    if (this.#session.state !== 'idle') return false;
    this.#plan = workout
      ? {
          workout,
          timeline: buildTimeline(workout),
          ftpTest,
          runner: null,
          applied: null,
          endedEarly: false,
          lastFailureCheckS: 0,
        }
      : null;
    return true;
  }

  get selectedWorkout(): Workout | null {
    return this.#plan?.workout ?? null;
  }

  skipWorkoutSegment(): void {
    this.#plan?.runner?.skipSegment();
  }

  restartWorkoutSegment(): void {
    this.#plan?.runner?.back();
  }

  /** Scales all workout targets; returns the clamped factor in effect. */
  setWorkoutIntensity(factor: number): number {
    return this.#plan?.runner?.setIntensity(factor) ?? 1;
  }

  shift(delta: number, source: ShiftSource = 'ui'): void {
    const before = this.#shifter.gear;
    this.#shifter.shift(delta);
    const after = this.#shifter.gear;
    this.#log.info(`gear ${before} → ${after} (${source})`, {
      delta,
      source,
      gearCount: this.#shifter.gearCount,
      ...(before === after ? { atLimit: true } : {}),
    });
  }

  /**
   * Brake from outside the controller (the keyboard), 0 … 1. Combined with
   * the levers: the stronger brake wins. Slows the virtual bike only.
   */
  setBrake(fraction: number, source: ShiftSource = 'keyboard'): void {
    const next = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
    if (next === this.#manualBrake) return;
    this.#manualBrake = next;
    this.#log.debug(next > 0 ? `brake on (${source})` : `brake off (${source})`, {
      braking: next,
      source,
    });
  }

  setGradient(gradePercent: number): void {
    this.#gradePercent = Math.max(-15, Math.min(20, gradePercent));
    this.#shifter.setGradient(this.#gradePercent);
    this.#session.setGradient(this.#gradePercent);
  }

  start(): void {
    if (this.#session.state === 'paused') {
      this.#session.resume();
      this.#log.info('ride resumed');
    } else if (this.#session.state === 'idle') {
      this.#log.info('ride started', {
        workout: this.#plan?.workout.name ?? null,
        ftpTest: this.#plan?.ftpTest?.kind ?? null,
        trainer: this.#devices.trainer?.state ?? 'none',
        heartRate: this.#devices.heartRate?.state ?? 'none',
        controller: this.#devices.controller?.state ?? 'none',
      });
      this.#lastSegment = '';
      this.#session = this.#newSession(this.#plan?.workout.name);
      this.#session.start();
      this.#lastAutosaveAt = this.#now();
      if (this.#plan) {
        this.#plan.runner = new WorkoutRunner(this.#plan.workout, {
          ftpW: this.#settings.rider.ftpW,
        });
        this.#plan.applied = null;
        this.#plan.endedEarly = false;
        this.#plan.lastFailureCheckS = 0;
      }
    }
  }

  pause(): void {
    if (this.#session.state === 'riding') this.#log.info('ride paused');
    this.#session.pause();
  }

  /** Ends the ride and saves it. Returns null if it was too short to keep. */
  async finish(): Promise<FinishedRide | null> {
    if (this.#session.state === 'idle') return null;
    const ride = this.#session.finish();
    const plan = this.#plan;
    this.#session = this.#newSession();
    // The workout is done with; the next ride is a free ride unless one is chosen again.
    this.#plan = null;
    this.#shifter.resync(); // leave ERG: back to the simulated road
    const last = ride.samples.at(-1);
    const avg =
      ride.samples.length > 0
        ? Math.round(ride.samples.reduce((a, x) => a + x.powerW, 0) / ride.samples.length)
        : null;
    // Coarse summary only (docs/diagnostics.md): no samples, no timestamps.
    this.#log.info('ride finished', {
      samples: ride.samples.length,
      durationMin: last ? Math.round(last.elapsedS / 6) / 10 : 0,
      distanceKm: last ? Math.round(last.distanceM / 100) / 10 : 0,
      avgPowerW: avg,
      kept: ride.samples.length >= MIN_RIDE_SAMPLES,
      workout: plan?.workout.name ?? null,
    });
    if (ride.samples.length < MIN_RIDE_SAMPLES) return null;
    await this.#options.saveRide(ride, true);
    return { ride, ftpTest: plan?.ftpTest ? this.#evaluateFtpTest(plan.ftpTest, ride) : null };
  }

  /** Advances the ride and publishes the live state. */
  tick(): LiveState {
    this.#session.setGear(this.#shifter.gear, this.#shifter.gearCount);
    this.#session.setGradient(this.#gradePercent);
    const levers = leverOutput(this.#paddles, this.#settings.shifting.levers);
    const steering = combineSteering(levers, this.#buttonSteering());
    const braking = Math.max(levers.braking, this.#manualBrake);
    this.#logLevers(levers, steering, braking);
    this.#session.setBrake(braking);
    const ride = this.#session.tick();
    const now = this.#now();
    const workout = this.#driveWorkout(ride);

    if (ride.state !== 'idle' && now - this.#lastAutosaveAt >= AUTOSAVE_INTERVAL_MS) {
      this.#lastAutosaveAt = now;
      this.#options.saveRide(this.#session.toRecordedRide(), false).catch((err: unknown) => {
        this.#log.error('autosave failed', { error: err });
        this.#options.onError?.(`Autosave failed: ${String(err)}`);
      });
    }

    this.#group?.setLocalState({
      name: this.#settings.rider.name,
      distanceM: ride.distanceM,
      speedMps: ride.speedMps,
      powerW: ride.powerW,
      cadenceRpm: ride.cadenceRpm,
      heartRateBpm: ride.heartRateBpm,
      gear: ride.gear,
    });

    const live: LiveState = {
      ride,
      devices: {
        trainer: status(this.#devices.trainer),
        heartRate: status(this.#devices.heartRate),
        controller: status(this.#devices.controller),
      },
      group: this.#group
        ? { roomCode: this.#group.roomCode, riders: this.#group.getRiders() }
        : null,
      localName: this.#settings.rider.name,
      workout,
      steering,
      braking,
    };
    this.#options.onLive(live);
    return live;
  }

  dispose(): void {
    for (const kind of ['trainer', 'heartRate', 'controller'] as const) this.setDevice(kind, null);
  }

  #onButton(event: ControllerButtonEvent): void {
    const action = this.#settings.shifting.buttons[event.button] ?? 'none';
    // Steering is the only action that lasts as long as the button is held.
    if (action === 'steerLeft' || action === 'steerRight') {
      if (event.pressed) this.#steerButtons.add(action);
      else this.#steerButtons.delete(action);
      return;
    }
    if (!event.pressed) return;
    const source = `button:${event.button}` as const;
    switch (action) {
      case 'shiftUp':
        return this.shift(1, source);
      case 'shiftDown':
        return this.shift(-1, source);
      case 'gradientUp':
        return this.setGradient(this.#gradePercent + 0.5);
      case 'gradientDown':
        return this.setGradient(this.#gradePercent - 0.5);
      case 'startPause':
        if (this.#session.state === 'riding') this.pause();
        else this.start();
        return;
      case 'workoutSkip':
        return this.skipWorkoutSegment();
      case 'workoutBack':
        return this.restartWorkoutSegment();
      case 'intensityUp':
      case 'intensityDown': {
        const current = this.#plan?.runner?.currentIntensity ?? 1;
        this.setWorkoutIntensity(current + (action === 'intensityUp' ? 0.05 : -0.05));
        return;
      }
      case 'none':
        this.#log.info(`button ${event.button} pressed: no action assigned`, {
          button: event.button,
          action: 'unmapped',
        });
    }
  }

  /** −1, 0 or 1 from held steer buttons. */
  #buttonSteering(): number {
    return (
      (this.#steerButtons.has('steerRight') ? 1 : 0) - (this.#steerButtons.has('steerLeft') ? 1 : 0)
    );
  }

  /** Releases held steer buttons and returns both levers to rest (disconnect, detach). */
  #releaseController(): void {
    this.#steerButtons.clear();
    this.#paddles = { left: 0, right: 0 };
  }

  /**
   * Logs what the app made of the levers (debug, source "ride") whenever the
   * result changes by a visible step, so a capture shows the interpretation
   * next to the raw frames. At most 20 lines per 10 s; the rest is counted.
   */
  #logLevers(levers: LeverOutput, steering: number, braking: number): void {
    const step = (v: number): number => Math.round(v * 10) / 10;
    // Keyed on the levers only: steer buttons and the brake key do not add lines.
    const key = `${step(this.#paddles.left)}|${step(this.#paddles.right)}|${levers.steerActive}`;
    if (key === this.#lastLeverLog) return;
    const first = this.#lastLeverLog === '';
    this.#lastLeverLog = key;
    if (first && key === '0|0|false') return; // nothing happened yet
    const d = this.#leverLimit.take('lever');
    if (!d.allowed) return;
    const { left, right } = this.#settings.shifting.levers;
    this.#log.debug(`levers → steering ${step(levers.steering)}, braking ${step(levers.braking)}`, {
      left: round(this.#paddles.left, 2),
      right: round(this.#paddles.right, 2),
      // After combining with steer buttons and the brake key: what the ride uses.
      steering: round(steering, 2),
      braking: round(braking, 2),
      assignment: `left +${left.positive} −${left.negative}, right +${right.positive} −${right.negative}`,
      ...(d.suppressed ? { suppressedBefore: d.suppressed } : {}),
    });
  }

  /** Logs a trainer command; beyond 10 per 10 s only a count is kept and reported with the next one. */
  #logCommand(kind: string, context: Record<string, unknown>): void {
    const d = this.#commandLimit.take(kind);
    if (!d.allowed) return;
    this.#log.debug(
      `trainer ← ${kind}`,
      d.suppressed ? { ...context, suppressedBefore: d.suppressed } : context,
    );
  }

  #bike(): BikeParams {
    const { massKg, bikeMassKg } = this.#settings.rider;
    return { ...DEFAULT_BIKE, totalMassKg: massKg + bikeMassKg };
  }

  #newSession(name?: string): RideSession {
    return new RideSession({
      bike: this.#bike(),
      riderMassKg: this.#settings.rider.massKg,
      now: this.#now,
      name,
    });
  }

  /** True while the trainer is (or should be) holding a workout's target power. */
  get #ergActive(): boolean {
    return this.#plan?.applied?.mode === 'erg';
  }

  #resyncTrainer(): void {
    // In ERG the next tick re-sends the target; sending the road would leave ERG.
    if (this.#plan?.applied) this.#plan.applied = null;
    else this.#shifter.resync();
  }

  /** Advances the workout and tells the trainer when the target or mode changed. */
  #driveWorkout(ride: RideSnapshot): WorkoutLive | null {
    const plan = this.#plan;
    if (!plan) return null;
    const base = {
      id: plan.workout.id,
      name: plan.workout.name,
      totalDurationS: plan.timeline.totalDurationS,
      ftpTest: plan.ftpTest?.kind,
    };
    const runner = plan.runner;
    if (!runner) {
      // Selected, ride not started: show what is coming.
      const first = plan.timeline.segments[0];
      return {
        ...base,
        mode: 'free',
        label: first?.label ?? '',
        targetPowerW: null,
        elapsedS: 0,
        segmentElapsedS: 0,
        segmentRemainingS: first ? first.endS - first.startS : 0,
        totalRemainingS: plan.timeline.totalDurationS,
        intensity: 1,
        finished: false,
        started: false,
      };
    }

    const update = runner.update(ride.elapsedS);
    const segmentKey = `${update.label}|${update.mode}`;
    if (segmentKey !== this.#lastSegment) {
      this.#lastSegment = segmentKey;
      this.#log.info(`workout segment: ${update.label}`, {
        mode: update.mode,
        targetPowerW: update.targetPowerW,
        gradePercent: update.gradePercent,
        segmentRemainingS: Math.round(update.segmentRemainingS),
        elapsedS: Math.round(update.elapsedS),
        finished: update.finished,
      });
    }

    if (plan.ftpTest?.openEnded && !plan.endedEarly && ride.state === 'riding') {
      const second = Math.floor(ride.elapsedS);
      if (second > plan.lastFailureCheckS) {
        plan.lastFailureCheckS = second;
        const window = ftpTestEffortWindow(plan.ftpTest);
        plan.endedEarly = detectRampFailure(
          this.#session.toRecordedRide().samples,
          plan.timeline,
          this.#settings.rider.ftpW,
          ride.elapsedS,
          { fromS: window.startS, intensity: update.intensity },
        );
      }
    }

    const finished = update.finished || plan.endedEarly;
    const mode = finished ? 'free' : update.mode;
    const targetPowerW = mode === 'erg' ? update.targetPowerW : null;
    const gradePercent = mode === 'free' && !finished ? update.gradePercent : undefined;

    const applied = plan.applied;
    const trainer = this.#devices.trainer;
    if (ride.state !== 'idle' && trainer?.state === 'connected') {
      if (mode === 'erg' && targetPowerW !== null) {
        if (applied?.mode !== 'erg' || applied.targetPowerW !== targetPowerW) {
          plan.applied = { mode, targetPowerW };
          this.#logCommand('target power', { targetPowerW });
          trainer.setTargetPower(targetPowerW).catch((err: unknown) => {
            this.#log.warn('trainer rejected target power', { targetPowerW, error: err });
            this.#options.onError?.(`Trainer rejected target power: ${String(err)}`);
          });
        }
      } else if (applied?.mode !== 'free' || applied.gradePercent !== gradePercent) {
        plan.applied = { mode: 'free', targetPowerW: null, gradePercent };
        if (gradePercent !== undefined) this.setGradient(gradePercent);
        this.#shifter.resync();
      }
    }

    return {
      ...base,
      mode,
      label: finished ? 'Workout complete' : update.label,
      targetPowerW,
      cadenceRpm: finished ? undefined : update.cadenceRpm,
      elapsedS: update.elapsedS,
      segmentElapsedS: update.segmentElapsedS,
      segmentRemainingS: finished ? 0 : update.segmentRemainingS,
      totalRemainingS: finished ? 0 : update.totalRemainingS,
      next: finished ? undefined : update.next,
      cue: finished ? undefined : update.cue?.message,
      intensity: update.intensity,
      finished,
      started: true,
    };
  }

  #evaluateFtpTest(protocol: FtpTestProtocol, ride: RecordedRide): FtpTestOutcome {
    const window = ftpTestEffortWindow(protocol);
    const previousFtpW = this.#settings.rider.ftpW;
    if (protocol.kind === 'ramp') {
      const r = evaluateRampTest(ride.samples, window.startS);
      return {
        kind: 'ramp',
        valid: r.valid,
        reason: r.reason ? (INVALID_REASONS[r.reason] ?? r.reason) : undefined,
        ftpW: r.ftpW,
        basisPowerW: r.bestOneMinutePowerW,
        previousFtpW,
      };
    }
    const r = evaluateTwentyMinuteTest(ride.samples, window.startS, window.endS);
    return {
      kind: 'twentyMinute',
      valid: r.valid,
      reason: r.reason ? (INVALID_REASONS[r.reason] ?? r.reason) : undefined,
      ftpW: r.ftpW,
      basisPowerW: r.averagePowerW,
      previousFtpW,
    };
  }

  #newShifter(initialGear?: number): SoftwareShifter {
    const shifter = new SoftwareShifter(
      (params) => {
        const trainer = this.#devices.trainer;
        // Without a connected trainer there is nothing to tell; resync() runs on connect.
        if (!trainer || trainer.state !== 'connected') return Promise.resolve();
        // In ERG the trainer holds a power target; simulation parameters would end that.
        if (this.#ergActive) return Promise.resolve();
        this.#logCommand('simulation', {
          gradePercent: round(params.gradePercent, 2),
          crr: round(params.crr, 5),
          windResistanceKgM: round(params.windResistanceKgM, 3),
          windSpeedMps: round(params.windSpeedMps, 2),
          gear: this.#shifter?.gear,
        });
        return trainer.setSimulation(params);
      },
      {
        bike: this.#bike(),
        physicalRatio: this.#settings.shifting.physicalRatio,
        trainerMassKg: this.#settings.shifting.trainerMassKg ?? undefined,
        initialGear,
      },
    );
    shifter.setGradient(this.#gradePercent);
    shifter.onError((err) => {
      this.#log.warn('trainer rejected simulation parameters', { error: err });
      this.#options.onError?.(`Trainer rejected resistance: ${String(err)}`);
    });
    return shifter;
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function status(device: Device | undefined): DeviceStatus | null {
  return device ? { name: device.name, state: device.state } : null;
}
