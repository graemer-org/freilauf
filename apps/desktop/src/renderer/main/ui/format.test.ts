import type { RideSnapshot } from '@freilauf/session';
import { describe, expect, it } from 'vitest';
import { ALL_STATS } from '../../../shared/contract';
import {
  formatDistance,
  formatDuration,
  formatGap,
  formatSpeed,
  MISSING,
  statLabel,
  statUnit,
  statValue,
} from './format';

const ride: RideSnapshot = {
  state: 'riding',
  elapsedS: 3723,
  distanceM: 12346,
  speedMps: 10,
  powerW: 201.6,
  power3sW: 199.4,
  displayPowerW: 201.6,
  avgPowerW: 201.6,
  wattsPerKg: 2.66,
  cadenceRpm: 88.5,
  heartRateBpm: 141,
  gear: 12,
  gearCount: 24,
  gradePercent: 2.5,
};

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(754)).toBe('12:34');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(36000)).toBe('10:00:00');
  });
  it('floors fractions and clamps negatives', () => {
    expect(formatDuration(59.9)).toBe('0:59');
    expect(formatDuration(-3)).toBe('0:00');
  });
  it('handles non-finite input', () => {
    expect(formatDuration(Number.NaN)).toBe(MISSING);
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });
});

describe('formatDistance / formatSpeed', () => {
  it('formats km with two decimals', () => {
    expect(formatDistance(0)).toBe('0.00 km');
    expect(formatDistance(12346)).toBe('12.35 km');
    expect(formatDistance(Number.NaN)).toBe(MISSING);
  });
  it('formats km/h with one decimal', () => {
    expect(formatSpeed(10)).toBe('36.0 km/h');
    expect(formatSpeed(0)).toBe('0.0 km/h');
    expect(formatSpeed(Number.NaN)).toBe(MISSING);
  });
});

describe('formatGap', () => {
  it('uses metres below 1 km and a sign', () => {
    expect(formatGap(120)).toBe('+120 m');
    expect(formatGap(-45.4)).toBe('−45 m');
    expect(formatGap(0)).toBe('0 m');
    expect(formatGap(-0.3)).toBe('0 m');
  });
  it('switches to km', () => {
    expect(formatGap(-1200)).toBe('−1.2 km');
    expect(formatGap(2560)).toBe('+2.6 km');
    expect(formatGap(999.6)).toBe('+1.0 km');
  });
  it('handles non-finite input', () => {
    expect(formatGap(Number.NaN)).toBe(MISSING);
  });
});

describe('stat helpers', () => {
  it('has a label for every stat', () => {
    for (const stat of ALL_STATS) expect(statLabel(stat)).not.toBe('');
  });
  it('has units', () => {
    expect(statUnit('power')).toBe('W');
    expect(statUnit('speed')).toBe('km/h');
    expect(statUnit('gear')).toBe('');
    expect(statUnit('time')).toBe('');
  });
  it('formats values from a snapshot', () => {
    expect(statValue('power', ride)).toBe('202');
    expect(statValue('power3s', ride)).toBe('199');
    expect(statValue('wattsPerKg', ride)).toBe('2.7');
    expect(statValue('cadence', ride)).toBe('89');
    expect(statValue('speed', ride)).toBe('36.0');
    expect(statValue('heartRate', ride)).toBe('141');
    expect(statValue('gear', ride)).toBe('12 / 24');
    expect(statValue('time', ride)).toBe('1:02:03');
    expect(statValue('distance', ride)).toBe('12.35');
    expect(statValue('gradient', ride)).toBe('+2.5');
  });
  it('power shows the smoothed value; avg power the ride average; 3 s power stays', () => {
    const r: RideSnapshot = { ...ride, powerW: 412, displayPowerW: 238.6, avgPowerW: 187.4 };
    expect(statValue('power', r)).toBe('239');
    expect(statValue('avgPower', r)).toBe('187');
    expect(statValue('power3s', r)).toBe('199');
    expect(statLabel('avgPower')).toBe('Avg power');
    expect(statUnit('avgPower')).toBe('W');
    expect(ALL_STATS).toContain('avgPower');
    expect(ALL_STATS).toContain('power3s');
    // Off: the session reports the raw reading as displayPowerW.
    expect(statValue('power', { ...r, displayPowerW: 412 })).toBe('412');
  });
  it('renders missing values as a dash', () => {
    const broken: RideSnapshot = {
      ...ride,
      heartRateBpm: null,
      powerW: Number.NaN,
      displayPowerW: Number.NaN,
      gearCount: 0,
      gradePercent: Number.NaN,
    };
    expect(statValue('heartRate', broken)).toBe(MISSING);
    expect(statValue('power', broken)).toBe(MISSING);
    expect(statValue('gear', broken)).toBe(MISSING);
    expect(statValue('gradient', broken)).toBe(MISSING);
  });
  it('formats negative and zero gradients', () => {
    expect(statValue('gradient', { ...ride, gradePercent: -3 })).toBe('−3.0');
    expect(statValue('gradient', { ...ride, gradePercent: 0 })).toBe('0.0');
    expect(statValue('gradient', { ...ride, gradePercent: -0.01 })).toBe('0.0');
  });
});
