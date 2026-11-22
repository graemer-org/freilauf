/**
 * Shape checks for IPC payloads coming from renderers. Pure, no Electron.
 * Deliberately structural and cheap: they guard the main process against
 * malformed input, they are not a full schema of the renderer's types.
 */
import type { RecordedRide } from '@freilauf/session';
import type { LiveState } from '../shared/contract';
import { isPlainObject } from './settings';

export { isBounds } from './settings';

const isNum = (v: unknown): v is number => typeof v === 'number';
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isLiveState(v: unknown): v is LiveState {
  if (!isPlainObject(v)) return false;
  const { ride, devices, group, localName } = v;
  if (!isPlainObject(ride) || !isPlainObject(devices) || typeof localName !== 'string')
    return false;
  if (group !== null && !isPlainObject(group)) return false;
  if (typeof ride.state !== 'string') return false;
  for (const key of [
    'elapsedS',
    'distanceM',
    'speedMps',
    'powerW',
    'power3sW',
    'wattsPerKg',
    'cadenceRpm',
    'gear',
    'gearCount',
    'gradePercent',
  ]) {
    if (!isNum(ride[key])) return false;
  }
  return ride.heartRateBpm === null || isNum(ride.heartRateBpm);
}

const SAMPLE_NUMBER_FIELDS = [
  'timestamp',
  'elapsedS',
  'powerW',
  'cadenceRpm',
  'speedMps',
  'distanceM',
  'gradePercent',
  'gear',
] as const;

/** Max samples accepted per ride (1 Hz → ~2.3 days). */
export const MAX_SAMPLES = 200_000;

export function isRecordedRide(v: unknown): v is RecordedRide {
  if (!isPlainObject(v)) return false;
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 200) return false;
  if (typeof v.name !== 'string' || v.name.length > 500) return false;
  if (!isFiniteNum(v.startedAt) || !isNum(v.riderMassKg)) return false;
  if (!Array.isArray(v.samples) || v.samples.length > MAX_SAMPLES) return false;
  for (const s of v.samples as unknown[]) {
    if (!isPlainObject(s)) return false;
    for (const key of SAMPLE_NUMBER_FIELDS) {
      // JSON has no NaN/Infinity: a stored ride may contain null where a
      // number was non-finite. rideSummary/encodeFit tolerate that.
      if (!isNum(s[key]) && s[key] !== null) return false;
    }
    if (s.heartRateBpm !== null && !isNum(s.heartRateBpm)) return false;
  }
  return true;
}

export function isAutoSelect(v: unknown): v is { deviceId: string; timeoutMs: number } | null {
  if (v === null) return true;
  return (
    isPlainObject(v) &&
    typeof v.deviceId === 'string' &&
    v.deviceId.length > 0 &&
    v.deviceId.length <= 200 &&
    isFiniteNum(v.timeoutMs) &&
    v.timeoutMs >= 0
  );
}

export function isShortString(v: unknown, max = 200): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
