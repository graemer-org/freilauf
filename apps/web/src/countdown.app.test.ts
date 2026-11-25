/**
 * The countdown before a ride starts or resumes, through the whole App (the web build's api in
 * simulation mode): every start path and the group's "Start together" share one countdown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupConnector, JoinedGroup } from '../../desktop/src/renderer/main/appStore';
import { App } from '../../desktop/src/renderer/main/appStore';
import { createBrowserApi } from './browserApi';
import { MemoryRideRecordStore, RideRepository } from './rideRepository';
import { BrowserSettingsStore, webDefaultSettings } from './settingsStore';

/** A group of one: every method answers with an empty, harmless value. */
function fakeGroup(): JoinedGroup & { announced: number[] } {
  const announced: number[] = [];
  const fixed: Record<string, unknown> = {
    roomCode: 'ABC-DEF',
    joinLink: 'freilauf://join/ABC-DEF#SECRET',
    inviteCode: 'ABC-DEF',
    transport: 'relays',
    announced,
    announceStart: (ms: number) => (announced.push(ms), true),
    getConnectionState: () => 'joined',
    getRules: () => null,
  };
  return new Proxy(fixed, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined; // not a promise
      if (/^on[A-Z]/.test(prop)) return () => () => {};
      if (/^get[A-Z]/.test(prop)) return () => [];
      return () => null;
    },
  }) as unknown as JoinedGroup & { announced: number[] };
}

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
  const group = fakeGroup();
  const connector: GroupConnector = {
    create: async () => group,
    join: async () => group,
  };
  const app = new App(api, connector, { storage: null });
  await app.init();
  await vi.advanceTimersByTimeAsync(2000); // simulated devices connect
  const overlay: unknown[] = [];
  api.live.onState((s) => overlay.push(s.countdown ?? null));
  const state = () => app.store.getState();
  const ride = () => state().live?.ride.state;
  return { app, api, group, state, ride, overlay };
}

describe('App: countdown before the ride starts or resumes', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  it('startRide counts down (default 3 s), then records; pause is immediate; resume counts again', async () => {
    const { app, state, ride, overlay } = await setup();
    expect(state().settings?.ride.countdownS).toBe(3);
    app.startRide();
    expect(state().live?.countdown).toMatchObject({ kind: 'start', totalS: 3 });
    // The overlay gets the same state.
    expect(overlay.at(-1)).toMatchObject({ kind: 'start' });
    await vi.advanceTimersByTimeAsync(2750);
    expect(ride()).toBe('idle');
    await vi.advanceTimersByTimeAsync(250);
    expect(ride()).toBe('riding');
    expect(state().live?.ride.elapsedS).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    app.pauseRide();
    expect(app.store.getState().live?.countdown ?? null).toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    expect(ride()).toBe('paused');
    app.startRide();
    expect(state().live?.countdown?.kind).toBe('resume');
    await vi.advanceTimersByTimeAsync(3000);
    expect(ride()).toBe('riding');
    app.dispose();
  });

  it('Start again or Escape (cancelCountdown) cancels; 0 starts at once', async () => {
    const { app, state, ride } = await setup();
    app.startRide();
    await vi.advanceTimersByTimeAsync(1000);
    app.startRide();
    expect(state().live?.countdown ?? null).toBeNull();
    app.startRide();
    expect(app.cancelCountdown()).toBe(true);
    expect(app.cancelCountdown()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ride()).toBe('idle');

    await app.updateSettings({ ride: { countdownS: 0 } });
    expect(state().settings?.ride.countdownS).toBe(0);
    app.startRide();
    expect(state().live?.countdown ?? null).toBeNull();
    await vi.advanceTimersByTimeAsync(250); // the next tick shows it
    expect(ride()).toBe('riding');
    app.dispose();
  });

  it('Start together: the group countdown shows like the local one and starts at zero, once', async () => {
    const { app, group, state, ride } = await setup();
    await app.createGroup();
    expect(state().group.phase).toBe('joined');
    app.startTogether(10);
    expect(group.announced).toEqual([10_000]);
    expect(state().live?.countdown).toMatchObject({ kind: 'group', totalS: 10 });
    expect(state().groupCountdownS).toBe(10);
    await vi.advanceTimersByTimeAsync(9750);
    expect(ride()).toBe('idle');
    expect(state().groupCountdownS).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    // Started at once: no local countdown on top.
    expect(ride()).toBe('riding');
    expect(state().live?.countdown ?? null).toBeNull();
    expect(state().groupCountdownS).toBeNull();
    app.dispose();
  });

  it('cancelling the group start (or leaving) ends the countdown locally', async () => {
    const { app, state, ride } = await setup();
    await app.createGroup();
    app.startTogether(10);
    app.cancelGroupStart();
    expect(state().live?.countdown ?? null).toBeNull();
    expect(state().groupCountdownS).toBeNull();
    app.startTogether(10);
    app.leaveGroup();
    expect(state().live?.countdown ?? null).toBeNull();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(ride()).toBe('idle');
    app.dispose();
  });

  it('after Finish the store is idle at once (no stale ride or countdown); Ride again counts down', async () => {
    const { app, state, ride } = await setup();
    app.startRide();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ride()).toBe('riding');
    await vi.advanceTimersByTimeAsync(12_000);
    const finished = app.finishRide();
    await vi.advanceTimersByTimeAsync(0);
    await finished;
    expect(state().lastRide).not.toBeNull();
    expect(ride()).toBe('idle');
    expect(state().live?.countdown ?? null).toBeNull();
    // "Ride again" is startRide on the summary: through the same countdown.
    app.startRide();
    expect(state().live?.countdown?.kind).toBe('start');
    expect(ride()).toBe('idle');
    app.dispose();
  });
});
