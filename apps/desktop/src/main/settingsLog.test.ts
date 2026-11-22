import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/contract';
import type { Settings } from '../shared/contract';
import { changedPaths, describeSettingsChange, isPersonalPath } from './settingsLog';

const base = (): Settings => structuredClone(DEFAULT_SETTINGS);

describe('settings change log', () => {
  it('lists changed leaf paths; arrays count as one value', () => {
    const a = base();
    const b = base();
    b.shifting.buttons.a = 'shiftUp';
    b.overlay.tiles = [{ stat: 'power', size: 'l' }];
    b.overlay.visible = false;
    expect(changedPaths(a, b)).toEqual(['overlay.tiles', 'overlay.visible', 'shifting.buttons.a']);
  });

  it('never includes values of personal settings', () => {
    const a = base();
    const b = base();
    b.rider.name = 'Ada Lovelace';
    b.rider.massKg = 61;
    b.group.signallingUrl = 'wss://user:pw@example.org/signal';
    b.devices.trainer = { id: 'AA:BB', name: 'KICKR CORE 1234' };
    const change = describeSettingsChange(a, b);
    expect(change.changed).toEqual([
      'devices.trainer',
      'group.signallingUrl',
      'rider.massKg',
      'rider.name',
    ]);
    expect(change.values).toEqual({ 'devices.trainer': { id: 'AA:BB', name: 'KICKR CORE 1234' } });
    expect(JSON.stringify(change)).not.toMatch(/Ada|61|pw@/);
  });

  it('marks removed keys (forgotten devices)', () => {
    const a = base();
    a.devices.heartRate = { id: 'x', name: 'HRM' };
    expect(describeSettingsChange(a, base()).values).toEqual({ 'devices.heartRate': '(removed)' });
  });

  it('knows which paths are personal', () => {
    expect(isPersonalPath('rider')).toBe(true);
    expect(isPersonalPath('rider.ftpW')).toBe(true);
    expect(isPersonalPath('riderless')).toBe(false);
    expect(isPersonalPath('overlay.bounds')).toBe(false);
  });
});
