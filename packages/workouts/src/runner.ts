import type { Workout } from './model';
import type { Timeline, WorkoutTarget } from './timeline';
import { buildTimeline, clampIntensity, segmentFractionAt, targetAt, toWatts } from './timeline';

/** Ride time going back by more than this re-anchors the runner (see `update`). */
export const REANCHOR_BACKWARD_S = 5;

export interface WorkoutRunnerOptions {
  ftpW: number;
  /** Initial intensity ("bias"), clamped to 0.5–1.5. Default 1. */
  intensity?: number;
  /** Ride time at which the workout starts. Default 0. Earlier ride times do not advance it. */
  startRideS?: number;
}

/** What changed since the previous `update()`; the first update reports everything. */
export interface RunnerChanges {
  /** A segment was entered (incl. restarting the current one with `back()`). */
  segmentChanged: boolean;
  /** `mode` switched erg ↔ free. On `free`: call `setSimulation`. */
  modeChanged: boolean;
  /** In erg mode: the watts to send changed (or erg was just entered). Call `setTargetPower`. */
  targetPowerChanged: boolean;
  /** In free mode: the fixed gradient changed (incl. back to "none") or free mode was entered. */
  gradeChanged: boolean;
  /** A new text cue fired. */
  cueChanged: boolean;
  /** The workout finished with this update (true exactly once per finish). */
  finished: boolean;
}

export interface RunnerUpdate extends WorkoutTarget {
  intensity: number;
  ftpW: number;
  changes: RunnerChanges;
}

/**
 * Deterministic workout state machine driven by the caller's ride time (no timers). Pausing is
 * implicit: if ride time does not advance, neither does the workout. Ride time that goes
 * backwards is ignored (the workout never rewinds unless `back()` is called); forward jumps
 * skip ahead and may cross several segments at once.
 *
 * Ramps are quantised to whole seconds of the segment, so the target watts change at most once
 * per second, and `targetPowerChanged` is only set when the rounded watt value changes.
 */
export class WorkoutRunner {
  readonly workout: Workout;
  readonly timeline: Timeline;
  private position = 0;
  private lastRideS: number;
  /** False until ride time first reaches `startRideS`. */
  private started = false;
  private ftpW: number;
  private intensity: number;
  private segmentEpoch = 0;
  private last: { update: RunnerUpdate; epoch: number } | null = null;

  constructor(workout: Workout, options: WorkoutRunnerOptions) {
    this.workout = workout;
    this.timeline = buildTimeline(workout);
    this.ftpW = options.ftpW;
    this.intensity = clampIntensity(options.intensity ?? 1);
    const start = options.startRideS ?? 0;
    this.lastRideS = Number.isFinite(start) ? start : 0;
  }

  /** Current workout time in seconds. */
  get positionS(): number {
    return this.position;
  }

  get currentIntensity(): number {
    return this.intensity;
  }

  /** The last value returned by `update()`, or `null` before the first call. */
  get state(): RunnerUpdate | null {
    return this.last?.update ?? null;
  }

  /** Advances to the given ride time and returns the target plus change flags. */
  update(rideElapsedS: number): RunnerUpdate {
    if (Number.isFinite(rideElapsedS) && !this.started && rideElapsedS >= this.lastRideS) {
      this.started = true;
    }
    if (Number.isFinite(rideElapsedS) && this.started) {
      const dt = rideElapsedS - this.lastRideS;
      if (dt > 0) {
        this.position = Math.min(this.timeline.totalDurationS, this.position + dt);
        this.lastRideS = rideElapsedS;
      } else if (dt < -REANCHOR_BACKWARD_S) {
        // A big backwards jump (new ride session, clock reset) re-anchors without rewinding.
        // Small backwards jitter is ignored so it is not counted twice.
        this.lastRideS = rideElapsedS;
      }
    }
    const target = this.evaluate();
    const prev = this.last?.update;
    const segmentChanged =
      !prev || prev.segmentIndex !== target.segmentIndex || this.last?.epoch !== this.segmentEpoch;
    const modeChanged = !prev || prev.mode !== target.mode;
    const changes: RunnerChanges = {
      segmentChanged,
      modeChanged,
      targetPowerChanged:
        target.mode === 'erg' && (modeChanged || prev?.targetPowerW !== target.targetPowerW),
      gradeChanged:
        target.mode === 'free' && (modeChanged || prev?.gradePercent !== target.gradePercent),
      cueChanged: target.cue !== undefined && prev?.cue?.index !== target.cue.index,
      finished: target.finished && !prev?.finished,
    };
    const update: RunnerUpdate = { ...target, intensity: this.intensity, ftpW: this.ftpW, changes };
    this.last = { update, epoch: this.segmentEpoch };
    return update;
  }

  /** Jumps to the start of the next segment (or to the end). Applied on the next `update()`. */
  skipSegment(): void {
    const seg = this.currentSegment();
    if (seg) this.position = seg.endS;
  }

  /** Restarts the current segment (after finishing: the last one). Applied on the next `update()`. */
  back(): void {
    const seg = this.currentSegment() ?? this.timeline.segments[this.timeline.segments.length - 1];
    if (!seg) return;
    this.position = seg.startS;
    this.segmentEpoch++;
  }

  /** Scales all targets; clamped to 0.5–1.5. Returns the value in effect. */
  setIntensity(factor: number): number {
    this.intensity = clampIntensity(factor);
    return this.intensity;
  }

  /** Changes the FTP used to compute watts (e.g. the rider edits it mid-ride). */
  setFtp(ftpW: number): void {
    if (Number.isFinite(ftpW) && ftpW > 0) this.ftpW = ftpW;
  }

  private currentSegment() {
    const t = targetAt(this.timeline, this.position, this.ftpW);
    return t.finished ? undefined : this.timeline.segments[t.segmentIndex];
  }

  private evaluate(): WorkoutTarget {
    const target = targetAt(this.timeline, this.position, this.ftpW, this.intensity);
    if (target.kind === 'ramp') {
      const seg = this.timeline.segments[target.segmentIndex];
      if (seg) {
        const fraction = segmentFractionAt(seg, Math.floor(target.segmentElapsedS + 1e-9));
        target.targetPowerW = toWatts(fraction, this.ftpW, this.intensity);
        target.targetFraction = fraction === null ? null : fraction * this.intensity;
      }
    }
    return target;
  }
}
