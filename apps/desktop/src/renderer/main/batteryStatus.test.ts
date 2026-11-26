import type { BatteryState } from '@freilauf/devices';
import { describe, expect, it } from 'vitest';
import {
  batteryParts,
  batteryTone,
  describeBattery,
  formatPercent,
  lowBatteries,
  lowBatteryNotice,
  shownBattery,
} from './batteryStatus';

const at = 1_700_000_000_000;
const whole = (percent: number): BatteryState => ({
  percent,
  source: 'battery-service',
  updatedAt: at,
});
const grips = (left: number, right: number): BatteryState => ({
  percent: Math.min(left, right),
  left,
  right,
  source: 'controller-protocol',
  updatedAt: at,
});

describe('batteryTone', () => {
  it('is normal from 20 %, low (orange) below 20 %, critical (red) below 10 %', () => {
    expect(batteryTone(100)).toBe('normal');
    expect(batteryTone(20)).toBe('normal');
    expect(batteryTone(19)).toBe('low');
    expect(batteryTone(10)).toBe('low');
    expect(batteryTone(9)).toBe('critical');
    expect(batteryTone(0)).toBe('critical');
  });
});

describe('battery texts', () => {
  it('formats the level with a no-break space', () => {
    expect(formatPercent(64)).toBe('64\u00a0%');
  });

  it('lists each grip of a controller, or the device as a whole', () => {
    expect(batteryParts(whole(64))).toEqual([{ side: null, percent: 64, tone: 'normal' }]);
    expect(batteryParts(grips(81, 12))).toEqual([
      { side: 'Left', percent: 81, tone: 'normal' },
      { side: 'Right', percent: 12, tone: 'low' },
    ]);
    expect(describeBattery(whole(64))).toBe('battery 64\u00a0%');
    expect(describeBattery(grips(81, 12))).toBe('battery: left 81\u00a0%, right 12\u00a0%');
  });

  it('shows a level only while the device is connected or reconnecting', () => {
    const b = whole(50);
    expect(shownBattery({ state: 'connected', battery: b })).toBe(b);
    expect(shownBattery({ state: 'reconnecting', battery: b })).toBe(b);
    expect(shownBattery({ state: 'disconnected', battery: b })).toBeNull();
    expect(shownBattery({ state: 'connecting', battery: b })).toBeNull();
    expect(shownBattery({ state: 'connected' })).toBeNull(); // no battery service: no icon
    expect(shownBattery(null)).toBeNull();
  });
});

describe('low battery notice at ride start', () => {
  it('is null while every battery is at 15 % or more (or there is none)', () => {
    expect(
      lowBatteryNotice({
        trainer: { state: 'connected' },
        heartRate: { state: 'connected', battery: whole(15) },
        controller: { state: 'connected', battery: grips(81, 40) },
      }),
    ).toBeNull();
    expect(lowBatteryNotice({})).toBeNull();
  });

  it('names every device below 15 %, each controller grip separately', () => {
    const devices = {
      heartRate: { state: 'connected' as const, battery: whole(9) },
      controller: { state: 'connected' as const, battery: grips(81, 12) },
    };
    expect(lowBatteries(devices)).toEqual([
      { kind: 'heartRate', side: null, percent: 9 },
      { kind: 'controller', side: 'right', percent: 12 },
    ]);
    expect(lowBatteryNotice(devices)).toBe(
      'Low battery: heart rate sensor 9\u00a0% and right controller 12\u00a0%. Charge them after this ride — the ride keeps recording if a device drops.',
    );
    expect(lowBatteryNotice({ heartRate: { state: 'connected', battery: whole(14) } })).toMatch(
      /^Low battery: heart rate sensor 14\u00a0%\. Charge it after/,
    );
  });

  it('ignores devices that are not connected', () => {
    expect(
      lowBatteryNotice({ heartRate: { state: 'disconnected', battery: whole(3) } }),
    ).toBeNull();
  });
});
