/** Native share/file format: a small versioned JSON envelope around a validated `Workout`. */
import type { Workout } from './model';
import { validateWorkout } from './model';
import { utf8ByteLength } from './zwo';

export const WORKOUT_FORMAT = 'freilauf-workout';
export const WORKOUT_FORMAT_VERSION = 1;
export const WORKOUT_FILE_EXTENSION = '.freilauf-workout.json';
/** Upper bound for an encoded workout (UTF-8 bytes), enforced by `decodeWorkout`. */
export const MAX_ENCODED_WORKOUT_BYTES = 64 * 1024;

export interface WorkoutEnvelope {
  format: typeof WORKOUT_FORMAT;
  version: number;
  workout: Workout;
}

export type DecodeResult = { ok: true; workout: Workout } | { ok: false; errors: string[] };

/**
 * Encodes a workout as compact JSON. The workout is validated (and thereby normalised) first;
 * encoding an invalid workout is a programming error and throws.
 */
export function encodeWorkout(workout: Workout): string {
  const result = validateWorkout(workout);
  if (!result.ok)
    throw new TypeError(`encodeWorkout: invalid workout: ${result.errors.join('; ')}`);
  const envelope: WorkoutEnvelope = {
    format: WORKOUT_FORMAT,
    version: WORKOUT_FORMAT_VERSION,
    workout: result.workout,
  };
  return JSON.stringify(envelope);
}

/**
 * Decodes untrusted text (file or peer). Rejects > 64 KiB, non-JSON, a wrong `format`, and
 * major versions other than 1 (`1.x` minor versions are accepted; unknown fields are dropped).
 * Never throws.
 */
export function decodeWorkout(text: string): DecodeResult {
  if (typeof text !== 'string') return { ok: false, errors: ['Input is not text'] };
  if (text.length > MAX_ENCODED_WORKOUT_BYTES || utf8ByteLength(text) > MAX_ENCODED_WORKOUT_BYTES) {
    return {
      ok: false,
      errors: [`Encoded workout is larger than ${MAX_ENCODED_WORKOUT_BYTES} bytes`],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, errors: ['Not valid JSON'] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['Not a Freilauf workout'] };
  }
  const env = data as Record<string, unknown>;
  if (env['format'] !== WORKOUT_FORMAT) return { ok: false, errors: ['Not a Freilauf workout'] };
  const version = env['version'];
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 0) {
    return { ok: false, errors: ['Missing or invalid format version'] };
  }
  if (Math.floor(version) !== WORKOUT_FORMAT_VERSION) {
    return { ok: false, errors: [`Unsupported workout format version ${version}`] };
  }
  return validateWorkout(env['workout']);
}
