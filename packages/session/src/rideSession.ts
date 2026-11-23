import type { BikeParams } from '@freilauf/sim';
import { stepBike } from '@freilauf/sim';
import type { RecordedRide, RideSample, RideSnapshot, RoutePositionFix } from './types';

export interface RideSessionOptions {
  bike: BikeParams;
  /** Rider only (for W/kg); the bike's totalMassKg includes the bike. */
  riderMassKg: number;
  /** Clock in Unix epoch ms. Injectable for tests. */
  now?: () => number;
  id?: string;
  name?: string;
}

/** Sensor values older than this are treated as "no signal" (device dropped). */
const SENSOR_TIMEOUT_MS = 3000;
const HEART_RATE_TIMEOUT_MS = 6000;
/** A tick gap longer than this (sleep, debugger) is not counted as riding. */
const MAX_TICK_GAP_MS = 5000;
const POWER_WINDOW_MS = 3000;

interface Timed<T> {
  value: T;
  at: number;
}

/**
 * The state of one ride: takes sensor input, moves the virtual bike, and
 * records one sample per second. Has no timers of its own — the owner calls
 * tick() a few times per second, which keeps it deterministic and testable.
 */
export class RideSession {
  readonly id: string;
  readonly name: string;
  readonly #bike: BikeParams;
  readonly #riderMassKg: number;
  readonly #now: () => number;

  #state: RideSnapshot['state'] = 'idle';
  #startedAt = 0;
  #lastTickAt = 0;
  #elapsedS = 0;
  #distanceM = 0;
  #speedMps = 0;
  #gear = 1;
  #gearCount = 1;
  #gradePercent = 0;
  #power: Timed<number> | null = null;
  #cadence: Timed<number> | null = null;
  #heartRate: Timed<number> | null = null;
  /** 0 … 1; like a sensor value it lapses after SENSOR_TIMEOUT_MS without an update. */
  #brake: Timed<number> | null = null;
  /** (time, watts, seconds) slices for the rolling 3 s average. */
  #powerWindow: { at: number; powerW: number; dtS: number }[] = [];
  /** Accumulators for the sample currently being recorded. */
  #sampleEnergyJ = 0;
  #sampleTimeS = 0;
  #samples: RideSample[] = [];
  #positionAt: ((distanceM: number) => RoutePositionFix | null) | null = null;

  constructor(options: RideSessionOptions) {
    this.#bike = options.bike;
    this.#riderMassKg = options.riderMassKg;
    this.#now = options.now ?? Date.now;
    this.id = options.id ?? `ride-${new Date(this.#now()).toISOString().replace(/[:.]/g, '-')}`;
    this.name = options.name ?? 'Free ride';
  }

  setPower(watts: number): void {
    if (Number.isFinite(watts)) this.#power = { value: Math.max(0, watts), at: this.#now() };
  }

  setCadence(rpm: number): void {
    if (Number.isFinite(rpm)) this.#cadence = { value: Math.max(0, rpm), at: this.#now() };
  }

  setHeartRate(bpm: number | null): void {
    this.#heartRate =
      bpm !== null && Number.isFinite(bpm) && bpm > 0 ? { value: bpm, at: this.#now() } : null;
  }

  /**
   * Brake, 0 (off) … 1 (full). Slows the virtual bike only (speed and
   * distance); the trainer's resistance is not changed. Must be refreshed
   * like a sensor value: a brake not set again within 3 s no longer acts.
   */
  setBrake(fraction: number): void {
    this.#brake = Number.isFinite(fraction)
      ? { value: Math.max(0, Math.min(1, fraction)), at: this.#now() }
      : null;
  }

  setGear(gear: number, gearCount: number): void {
    this.#gear = gear;
    this.#gearCount = gearCount;
  }

  setGradient(gradePercent: number): void {
    if (Number.isFinite(gradePercent)) this.#gradePercent = gradePercent;
  }

  /**
   * Gives every recorded sample a position: `positionAt(distance)` is asked for the ridden
   * distance at the moment the sample is taken (null = none). Used when riding a route.
   */
  setPositionSource(positionAt: ((distanceM: number) => RoutePositionFix | null) | null): void {
    this.#positionAt = positionAt;
  }

  get state(): RideSnapshot['state'] {
    return this.#state;
  }

  start(): void {
    if (this.#state !== 'idle') return;
    this.#state = 'riding';
    this.#startedAt = this.#now();
    this.#lastTickAt = this.#startedAt;
  }

  pause(): void {
    if (this.#state !== 'riding') return;
    this.tick();
    this.#state = 'paused';
  }

  resume(): void {
    if (this.#state !== 'paused') return;
    this.#state = 'riding';
    this.#lastTickAt = this.#now();
  }

  /** Advances the ride to "now" and returns the live values. Safe to call in any state. */
  tick(): RideSnapshot {
    const now = this.#now();
    const powerW = this.#fresh(this.#power, now, SENSOR_TIMEOUT_MS) ?? 0;

    if (this.#state === 'riding') {
      const gapMs = now - this.#lastTickAt;
      this.#lastTickAt = now;
      if (gapMs > 0 && gapMs <= MAX_TICK_GAP_MS) this.#advance(now, gapMs / 1000, powerW);
    }

    return this.#snapshot(now, powerW);
  }

  /** The ride so far. Can be called while riding, e.g. for periodic autosave. */
  toRecordedRide(): RecordedRide {
    return {
      id: this.id,
      name: this.name,
      startedAt: this.#startedAt || this.#now(),
      riderMassKg: this.#riderMassKg,
      samples: [...this.#samples],
    };
  }

  /** Ends the ride. Further ticks no longer advance it. */
  finish(): RecordedRide {
    if (this.#state === 'riding') this.tick();
    this.#state = 'idle';
    this.#speedMps = 0;
    return this.toRecordedRide();
  }

  #advance(now: number, dtS: number, powerW: number): void {
    const brake = this.#fresh(this.#brake, now, SENSOR_TIMEOUT_MS) ?? 0;
    const step = stepBike(this.#speedMps, powerW, this.#gradePercent, this.#bike, dtS, brake);
    this.#speedMps = step.speedMps;
    this.#distanceM += step.distanceM;

    this.#powerWindow.push({ at: now, powerW, dtS });
    while (this.#powerWindow.length > 0 && this.#powerWindow[0]!.at <= now - POWER_WINDOW_MS) {
      this.#powerWindow.shift();
    }

    // Record one sample per full second of ride time, carrying the mean power of that second.
    let remaining = dtS;
    while (remaining > 0) {
      const untilNextSecond = Math.floor(this.#elapsedS) + 1 - this.#elapsedS;
      const slice = Math.min(remaining, untilNextSecond);
      this.#elapsedS += slice;
      this.#sampleEnergyJ += powerW * slice;
      this.#sampleTimeS += slice;
      remaining -= slice;
      if (slice >= untilNextSecond - 1e-9) {
        this.#elapsedS = Math.round(this.#elapsedS);
        this.#samples.push({
          timestamp: Math.round(now - remaining * 1000),
          elapsedS: this.#elapsedS,
          powerW: Math.round(this.#sampleEnergyJ / this.#sampleTimeS),
          cadenceRpm: Math.round(this.#fresh(this.#cadence, now, SENSOR_TIMEOUT_MS) ?? 0),
          heartRateBpm: this.#fresh(this.#heartRate, now, HEART_RATE_TIMEOUT_MS),
          speedMps: this.#speedMps,
          distanceM: this.#distanceM,
          gradePercent: this.#gradePercent,
          gear: this.#gear,
          ...this.#position(),
        });
        this.#sampleEnergyJ = 0;
        this.#sampleTimeS = 0;
      }
    }
  }

  #position(): Partial<Pick<RideSample, 'lat' | 'lon' | 'altitudeM' | 'segment'>> {
    const fix = this.#positionAt?.(this.#distanceM);
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return {};
    const segment = fix.segment;
    return {
      lat: fix.lat,
      lon: fix.lon,
      ...(Number.isFinite(fix.altitudeM) ? { altitudeM: fix.altitudeM } : {}),
      ...(typeof segment === 'number' && Number.isInteger(segment) && segment > 0
        ? { segment }
        : {}),
    };
  }

  #snapshot(now: number, powerW: number): RideSnapshot {
    let energy = 0;
    let time = 0;
    for (const slice of this.#powerWindow) {
      if (slice.at > now - POWER_WINDOW_MS) {
        energy += slice.powerW * slice.dtS;
        time += slice.dtS;
      }
    }
    const power3sW = this.#state === 'riding' && time > 0 ? energy / time : powerW;
    return {
      state: this.#state,
      elapsedS: this.#elapsedS,
      distanceM: this.#distanceM,
      speedMps: this.#state === 'riding' ? this.#speedMps : 0,
      powerW,
      power3sW,
      wattsPerKg: this.#riderMassKg > 0 ? power3sW / this.#riderMassKg : 0,
      cadenceRpm: this.#fresh(this.#cadence, now, SENSOR_TIMEOUT_MS) ?? 0,
      heartRateBpm: this.#fresh(this.#heartRate, now, HEART_RATE_TIMEOUT_MS),
      gear: this.#gear,
      gearCount: this.#gearCount,
      gradePercent: this.#gradePercent,
    };
  }

  #fresh(reading: Timed<number> | null, now: number, timeoutMs: number): number | null {
    return reading && now - reading.at <= timeoutMs ? reading.value : null;
  }
}
