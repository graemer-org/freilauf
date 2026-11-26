/**
 * Battery levels through the whole App (the web build's api in simulation mode): the simulated
 * devices' levels in the live state, the test hook, and the one notice at ride start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../desktop/src/renderer/main/appStore';
import { createBrowserApi } from './browserApi';
import { MemoryRideRecordStore, RideRepository } from './rideRepository';
import { BrowserSettingsStore, webDefaultSettings } from './settingsStore';

async function setup() {
  const api = createBrowserApi({
    settings: new BrowserSettingsStore({
      storage: null,
      defaults: webDefaultSettings({ protocol: 'http:', host: 'localhost:8080' }),
      log: () => {},
    }),
    rides: new RideRepository(new MemoryRideRecordStore(), () => {}),
    simMode: true,
    bleLogEnabled: false,
    overlayWindow: null,
    diagnosticsLimit: 50,
    sessionHeader: false,
  });
  const app = new App(api, null, { storage: null });
  await app.init();
  await app.updateSettings({ ride: { countdownS: 0 } });
  await vi.advanceTimersByTimeAsync(2000); // simulated devices connect
  const state = () => app.store.getState();
  return { app, state };
}

describe('App: battery levels', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  it('publishes the simulated levels and warns once at ride start below 15 %', async () => {
    const { app, state } = await setup();
    const devices = state().live!.devices;
    expect(devices.trainer?.battery).toBeUndefined();
    expect(devices.heartRate?.battery).toMatchObject({ percent: 64 });
    expect(devices.controller?.battery).toMatchObject({ percent: 12, left: 81, right: 12 });
    expect(state().notices).toEqual([]);

    app.startRide();
    await vi.advanceTimersByTimeAsync(250);
    expect(state().live?.ride.state).toBe('riding');
    const warn = state().notices.filter((n) => n.kind === 'warn');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.message).toMatch(/^Low battery: right controller 12\u00a0%\./);

    // Not repeated during the ride, nor on resume.
    app.setSimBattery('heartRate', 5);
    await vi.advanceTimersByTimeAsync(250);
    expect(state().live?.devices.heartRate?.battery?.percent).toBe(5);
    app.pauseRide();
    await vi.advanceTimersByTimeAsync(250);
    app.startRide();
    await vi.advanceTimersByTimeAsync(250);
    expect(state().notices.filter((n) => n.kind === 'warn')).toHaveLength(1);
    app.dispose();
  });

  it('shows no notice when every level is fine, and the hook removes a battery', async () => {
    const { app, state } = await setup();
    app.setSimBattery('controller', 50, 'right');
    app.setSimBattery('heartRate', null);
    await vi.advanceTimersByTimeAsync(250);
    expect(state().live?.devices.heartRate?.battery).toBeUndefined();
    expect(state().live?.devices.controller?.battery).toMatchObject({ percent: 50 });
    app.startRide();
    await vi.advanceTimersByTimeAsync(250);
    expect(state().live?.ride.state).toBe('riding');
    expect(state().notices.filter((n) => n.kind === 'warn')).toEqual([]);
    app.dispose();
  });
});
