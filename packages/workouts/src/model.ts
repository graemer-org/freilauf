/**
 * The workout model. All power targets are fractions of the rider's FTP (0.75 = 75 % FTP), so a
 * workout is independent of the rider and can be shared as-is; watts are only computed at ride
 * time (see `timeline.ts`).
 */

/** A text cue shown to the rider `atS` seconds after the start of the step it belongs to. */
export interface TextCue {
  atS: number;
  message: string;
}

interface StepBase {
  /** Optional display label overriding the default ("Warm-up", "Steady", "Interval 2/5 · on"). */
  label?: string;
  /** Cues relative to the start of this step (for `intervals`: of the whole block). */
  cues?: TextCue[];
}

/** Constant ERG target. */
export interface SteadyStep extends StepBase {
  kind: 'steady';
  durationS: number;
  power: number;
  cadenceRpm?: number;
}

/** Linear ERG ramp from `powerStart` to `powerEnd`; covers warm-ups and cool-downs. */
export interface RampStep extends StepBase {
  kind: 'ramp';
  durationS: number;
  powerStart: number;
  powerEnd: number;
  cadenceRpm?: number;
}

/** `repeat` × [on, off], expanded into 2 × repeat segments. */
export interface IntervalsStep extends StepBase {
  kind: 'intervals';
  repeat: number;
  onDurationS: number;
  onPower: number;
  offDurationS: number;
  offPower: number;
  onCadenceRpm?: number;
  offCadenceRpm?: number;
}

/**
 * No ERG target: the trainer goes back to simulation mode and the rider paces themself.
 * `gradePercent` fixes the simulated gradient (0 = flat road); absent = whatever the ride
 * controller would normally use (route / free ride).
 */
export interface FreeRideStep extends StepBase {
  kind: 'freeRide';
  durationS: number;
  gradePercent?: number;
  /** Expected effort as FTP fraction. Only used for stats/preview, never sent to the trainer. */
  expectedPower?: number;
}

export type WorkoutStep = SteadyStep | RampStep | IntervalsStep | FreeRideStep;
export type StepKind = WorkoutStep['kind'];

export interface Workout {
  /** Stable identifier, `[A-Za-z0-9._-]{1,64}`. */
  id: string;
  name: string;
  description?: string;
  author?: string;
  tags?: string[];
  steps: WorkoutStep[];
}

/** Limits enforced by `validateWorkout` (and therefore by every import/decode path). */
export const WORKOUT_LIMITS = {
  /** Power targets: 0 – 300 % FTP. */
  maxPower: 3,
  minStepDurationS: 1,
  maxStepDurationS: 4 * 3600,
  maxTotalDurationS: 12 * 3600,
  maxSteps: 500,
  maxRepeat: 100,
  maxCuesPerStep: 50,
  minCadenceRpm: 20,
  maxCadenceRpm: 200,
  minGradePercent: -25,
  maxGradePercent: 25,
  maxIdLength: 64,
  maxNameLength: 80,
  maxDescriptionLength: 2000,
  maxAuthorLength: 80,
  maxTags: 16,
  maxTagLength: 32,
  maxLabelLength: 40,
  maxCueMessageLength: 200,
} as const;

/** Duration of one step in seconds (for intervals: the whole block incl. the last "off"). */
export function stepDurationS(step: WorkoutStep): number {
  switch (step.kind) {
    case 'intervals':
      return step.repeat * (step.onDurationS + step.offDurationS);
    default:
      return step.durationS;
  }
}

/** Total planned duration of a workout in seconds. */
export function totalDurationS(workout: Workout): number {
  let total = 0;
  for (const step of workout.steps) total += stepDurationS(step);
  return total;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export type ValidationResult = { ok: true; workout: Workout } | { ok: false; errors: string[] };

/** C0/C1 controls, zero-width and bidi override characters, BOM. */
const STRIP = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ERRORS = 50;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Cut by code point so no surrogate pair is split.
  return Array.from(s).slice(0, max).join('').trim();
}

/** Single-line text: controls stripped, whitespace collapsed, trimmed, capped. */
export function sanitizeLine(s: string, max: number): string {
  return truncate(
    s
      .replace(/[\t\n\r]+/g, ' ')
      .replace(STRIP, '')
      .replace(/ {2,}/g, ' ')
      .trim(),
    max,
  );
}

/** Multi-line text: like `sanitizeLine` but keeps (normalised) line breaks. */
export function sanitizeMultiline(s: string, max: number): string {
  return truncate(
    s
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      .replace(STRIP, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    max,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Checker {
  readonly errors: string[] = [];

  error(msg: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(msg);
  }

  /** A finite number in [min, max] (optionally an integer); `undefined` if missing/invalid. */
  num(
    obj: Record<string, unknown>,
    key: string,
    path: string,
    min: number,
    max: number,
    opts: { optional?: boolean; integer?: boolean } = {},
  ): number | undefined {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (!opts.optional) this.error(`${path}.${key}: required`);
      return undefined;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.error(`${path}.${key}: must be a finite number`);
      return undefined;
    }
    if (opts.integer && !Number.isInteger(v)) {
      this.error(`${path}.${key}: must be a whole number`);
      return undefined;
    }
    if (v < min || v > max) {
      this.error(`${path}.${key}: must be between ${min} and ${max} (got ${v})`);
      return undefined;
    }
    return v;
  }

  str(
    obj: Record<string, unknown>,
    key: string,
    path: string,
    max: number,
    opts: { optional?: boolean; multiline?: boolean } = {},
  ): string | undefined {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (!opts.optional) this.error(`${path}.${key}: required`);
      return undefined;
    }
    if (typeof v !== 'string') {
      this.error(`${path}.${key}: must be a string`);
      return undefined;
    }
    // Cheap guard against absurd inputs before regex work.
    const raw = v.length > max * 8 ? v.slice(0, max * 8) : v;
    const clean = opts.multiline ? sanitizeMultiline(raw, max) : sanitizeLine(raw, max);
    if (clean === '') {
      if (!opts.optional) this.error(`${path}.${key}: must not be empty`);
      return undefined;
    }
    return clean;
  }
}

const L = WORKOUT_LIMITS;

function validateCues(
  c: Checker,
  raw: Record<string, unknown>,
  path: string,
  durationS: number | undefined,
): TextCue[] | undefined {
  const v = raw['cues'];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    c.error(`${path}.cues: must be an array`);
    return undefined;
  }
  if (v.length > L.maxCuesPerStep) {
    c.error(`${path}.cues: at most ${L.maxCuesPerStep} cues per step`);
    return undefined;
  }
  const cues: TextCue[] = [];
  v.forEach((item: unknown, i) => {
    const p = `${path}.cues[${i}]`;
    if (!isRecord(item)) {
      c.error(`${p}: must be an object`);
      return;
    }
    const atS = c.num(item, 'atS', p, 0, L.maxTotalDurationS);
    const message = c.str(item, 'message', p, L.maxCueMessageLength);
    if (atS !== undefined && durationS !== undefined && atS >= durationS) {
      c.error(`${p}.atS: must be before the end of the step (${durationS} s)`);
      return;
    }
    if (atS !== undefined && message !== undefined) cues.push({ atS, message });
  });
  cues.sort((a, b) => a.atS - b.atS);
  return cues.length > 0 ? cues : undefined;
}

function validateStep(c: Checker, raw: unknown, path: string): WorkoutStep | undefined {
  if (!isRecord(raw)) {
    c.error(`${path}: must be an object`);
    return undefined;
  }
  const before = c.errors.length;
  const dur = (key: string) =>
    c.num(raw, key, path, L.minStepDurationS, L.maxStepDurationS, { integer: true });
  const pow = (key: string) => c.num(raw, key, path, 0, L.maxPower);
  const cad = (key: string) =>
    c.num(raw, key, path, L.minCadenceRpm, L.maxCadenceRpm, { optional: true });
  const label = c.str(raw, 'label', path, L.maxLabelLength, { optional: true });

  let step: WorkoutStep | undefined;
  switch (raw['kind']) {
    case 'steady': {
      const durationS = dur('durationS');
      const power = pow('power');
      const cadenceRpm = cad('cadenceRpm');
      if (durationS !== undefined && power !== undefined) {
        step = { kind: 'steady', durationS, power };
        if (cadenceRpm !== undefined) step.cadenceRpm = cadenceRpm;
      }
      break;
    }
    case 'ramp': {
      const durationS = dur('durationS');
      const powerStart = pow('powerStart');
      const powerEnd = pow('powerEnd');
      const cadenceRpm = cad('cadenceRpm');
      if (durationS !== undefined && powerStart !== undefined && powerEnd !== undefined) {
        step = { kind: 'ramp', durationS, powerStart, powerEnd };
        if (cadenceRpm !== undefined) step.cadenceRpm = cadenceRpm;
      }
      break;
    }
    case 'intervals': {
      const repeat = c.num(raw, 'repeat', path, 1, L.maxRepeat, { integer: true });
      const onDurationS = dur('onDurationS');
      const onPower = pow('onPower');
      const offDurationS = dur('offDurationS');
      const offPower = pow('offPower');
      const onCadenceRpm = cad('onCadenceRpm');
      const offCadenceRpm = cad('offCadenceRpm');
      if (
        repeat !== undefined &&
        onDurationS !== undefined &&
        onPower !== undefined &&
        offDurationS !== undefined &&
        offPower !== undefined
      ) {
        step = { kind: 'intervals', repeat, onDurationS, onPower, offDurationS, offPower };
        if (onCadenceRpm !== undefined) step.onCadenceRpm = onCadenceRpm;
        if (offCadenceRpm !== undefined) step.offCadenceRpm = offCadenceRpm;
      }
      break;
    }
    case 'freeRide': {
      const durationS = dur('durationS');
      const gradePercent = c.num(raw, 'gradePercent', path, L.minGradePercent, L.maxGradePercent, {
        optional: true,
      });
      const expectedPower = c.num(raw, 'expectedPower', path, 0, L.maxPower, { optional: true });
      if (durationS !== undefined) {
        step = { kind: 'freeRide', durationS };
        if (gradePercent !== undefined) step.gradePercent = gradePercent;
        if (expectedPower !== undefined) step.expectedPower = expectedPower;
      }
      break;
    }
    default:
      c.error(`${path}.kind: must be one of steady, ramp, intervals, freeRide`);
      return undefined;
  }
  if (!step || c.errors.length > before) return undefined;
  const cues = validateCues(c, raw, path, stepDurationS(step));
  if (c.errors.length > before) return undefined;
  if (label !== undefined) step.label = label;
  if (cues !== undefined) step.cues = cues;
  return step;
}

/**
 * Validates untrusted input (files, peers) and returns a cleaned copy containing only known
 * fields, with strings sanitised (control/bidi characters stripped, lengths capped, trimmed).
 * Unknown properties are dropped silently (forward compatibility). Never throws.
 */
export function validateWorkout(input: unknown): ValidationResult {
  const c = new Checker();
  try {
    if (!isRecord(input)) return { ok: false, errors: ['workout: must be an object'] };
    const id = input['id'];
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      c.error('workout.id: must match [A-Za-z0-9._-]{1,64}');
    }
    const name = c.str(input, 'name', 'workout', L.maxNameLength);
    const description = c.str(input, 'description', 'workout', L.maxDescriptionLength, {
      optional: true,
      multiline: true,
    });
    const author = c.str(input, 'author', 'workout', L.maxAuthorLength, { optional: true });

    let tags: string[] | undefined;
    const rawTags = input['tags'];
    if (rawTags !== undefined && rawTags !== null) {
      if (!Array.isArray(rawTags) || rawTags.length > L.maxTags) {
        c.error(`workout.tags: must be an array of at most ${L.maxTags} strings`);
      } else {
        const set = new Set<string>();
        for (const t of rawTags as unknown[]) {
          if (typeof t !== 'string') {
            c.error('workout.tags: must contain strings only');
            break;
          }
          const clean = sanitizeLine(t.slice(0, 256), L.maxTagLength).toLowerCase();
          if (clean) set.add(clean);
        }
        if (set.size > 0) tags = [...set];
      }
    }

    const steps: WorkoutStep[] = [];
    const rawSteps = input['steps'];
    if (!Array.isArray(rawSteps)) {
      c.error('workout.steps: must be an array');
    } else if (rawSteps.length === 0) {
      c.error('workout.steps: must contain at least one step');
    } else if (rawSteps.length > L.maxSteps) {
      c.error(`workout.steps: at most ${L.maxSteps} steps`);
    } else {
      rawSteps.forEach((raw: unknown, i) => {
        const step = validateStep(c, raw, `steps[${i}]`);
        if (step) steps.push(step);
      });
    }

    if (c.errors.length > 0) return { ok: false, errors: c.errors };
    // `steps` last so encoded files read naturally.
    const workout: Workout = {
      id: id as string,
      name: name as string,
      ...(description !== undefined ? { description } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(tags !== undefined ? { tags } : {}),
      steps,
    };
    if (totalDurationS(workout) > L.maxTotalDurationS) {
      return { ok: false, errors: [`workout: total duration exceeds ${L.maxTotalDurationS} s`] };
    }
    return { ok: true, workout };
  } catch {
    // Getters/proxies on hostile objects; never let them escape.
    return { ok: false, errors: [...c.errors, 'workout: could not be read'] };
  }
}
