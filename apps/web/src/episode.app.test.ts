/**
 * "Fit to an episode" through the whole App (the web build's api in simulation mode): choosing
 * remembers the choices, the start screen's "again" path regenerates the workout, and "hard now"
 * during the ride updates the plan the panels draw.
 */
import { totalDurationS } from '@freilauf/workouts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupConnector } from '../../desktop/src/renderer/main/appStore';
import { App } from '../../desktop/src/renderer/main/appStore';
import { createBrowserApi } from './browserApi';
import { MemoryRideRecordStore, RideRepository } from './rideRepository';
import { BrowserSettingsStore, webDefaultSettings } from './settingsStore';

async function setup() {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  };
  const api = createBrowserApi({
    settings: new BrowserSettingsStore({
      storage,
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
  const connector: GroupConnector = {
    create: async () => {
      throw new Error('no group');
    },
    join: async () => {
      throw new Error('no group');
    },
  };
  const app = new App(api, connector, { storage: null });
  await app.init();
  await vi.advanceTimersByTimeAsync(2000);
  return { app, api, stored, state: () => app.store.getState() };
}

describe('App: fit to an episode', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  it('selects a generated workout, remembers the choices and regenerates from them', async () => {
    const { app, api, stored, state } = await setup();
    expect(state().settings?.episode).toEqual({
      lengthMin: 42,
      effort: 'medium',
      pattern: 'spread',
    });
    expect(app.selectEpisode({ lengthMin: 22, effort: 'hard', pattern: 'finale' })).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(state().selectedWorkoutId).toBe('episode-22-hard-finale');
    expect(state().episodePlan?.workout.name).toBe('Episode 22 min · Finale, hard');
    expect(state().settings?.episode).toEqual({ lengthMin: 22, effort: 'hard', pattern: 'finale' });
    expect((await api.settings.get()).episode).toEqual({
      lengthMin: 22,
      effort: 'hard',
      pattern: 'finale',
    });
    expect([...stored.values()].some((v) => v.includes('"episode":{"lengthMin":22'))).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(state().live?.workout).toMatchObject({ totalDurationS: 1320, started: false });

    // Another workout clears it; the episode id selects the remembered choices again.
    expect(app.selectWorkout('builtin-sweet-spot-3x12')).toBe(true);
    expect(state().episodePlan).toBeNull();
    expect(app.selectWorkout('episode-42-medium-spread')).toBe(true);
    expect(state().selectedWorkoutId).toBe('episode-22-hard-finale');
  });

  it('hard now during the ride re-fits the plan the panels draw', async () => {
    const { app, state } = await setup();
    await app.updateSettings({ ride: { countdownS: 0 } });
    app.selectEpisode({ lengthMin: 10, effort: 'medium', pattern: 'spread' });
    app.startRide();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state().live?.workout?.label).toBe('Warm-up');
    expect(app.hardNow('keyboard')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    const plan = state().episodePlan!;
    expect(plan.hardNowCount).toBe(1);
    expect(plan.blocks).toContain('hardNow');
    expect(totalDurationS(plan.workout)).toBe(600);
    expect(state().live?.workout).toMatchObject({ label: 'Hard now', totalDurationS: 600 });
    expect(state().live?.workout?.episode?.notice?.text).toMatch(/^Hard now: 2 min · \d+ W$/);
    // Refused inside the block: the plan stays.
    expect(app.hardNow()).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(state().episodePlan).toBe(plan);
    expect(state().live?.workout?.episode?.notice).toEqual({
      text: 'Already in a hard block.',
      tone: 'warn',
    });
    await app.finishRide();
    expect(state().episodePlan).toBeNull();
    expect(state().selectedWorkoutId).toBeNull();
  });
});
