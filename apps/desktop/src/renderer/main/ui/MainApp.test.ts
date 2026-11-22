// Server-side render smoke test of the main window (no DOM needed).
// A .ts file on purpose: the root Vitest config only collects *.test.ts.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState } from '../appStore';
import type { LiveState } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import type { Workout } from '@freilauf/workouts';
import type { WorkoutLive } from '../../../shared/contract';
import { WorkoutLibrary } from '../../core/workoutLibrary';
import type { TabId } from './MainApp';
import { defaultTab, MainApp } from './index';

function baseState(): AppState {
  return {
    ready: true,
    simMode: false,
    settings: structuredClone(DEFAULT_SETTINGS),
    live: null,
    picker: null,
    busy: {},
    rides: [],
    group: { phase: 'idle' },
    notices: [],
    overlayEditMode: false,
    simEffortW: 180,
    workouts: [],
    selectedWorkoutId: null,
    ftpOutcome: null,
    sharedWorkouts: [],
    sharingWorkoutId: null,
    groupCountdownS: null,
  };
}

function liveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    ride: {
      state: 'riding',
      elapsedS: 754,
      distanceM: 5234,
      speedMps: 9.5,
      powerW: 213,
      power3sW: 207,
      wattsPerKg: 2.84,
      cadenceRpm: 90,
      heartRateBpm: 142,
      gear: 12,
      gearCount: 24,
      gradePercent: 1.5,
    },
    devices: {
      trainer: { name: 'Sim trainer', state: 'connected' },
      heartRate: { name: 'Sim HR', state: 'reconnecting' },
      controller: { name: 'Sim controller', state: 'connected' },
    },
    group: null,
    localName: 'Ana',
    ...overrides,
  };
}

/** Just enough of `App` for rendering; actions are never called during SSR. */
function stubApp(state: AppState, extra: Record<string, unknown> = {}): App {
  const noop = (): void => undefined;
  const asyncNoop = async (): Promise<void> => undefined;
  return {
    store: createStore<AppState>(() => state),
    pairDevice: asyncNoop,
    pickDevice: noop,
    cancelPicker: noop,
    forgetDevice: asyncNoop,
    retryDevice: asyncNoop,
    startRide: noop,
    pauseRide: noop,
    finishRide: asyncNoop,
    shift: noop,
    setGradient: noop,
    setSimEffort: noop,
    simulateDrop: noop,
    refreshRides: asyncNoop,
    exportFit: asyncNoop,
    deleteRide: asyncNoop,
    openRidesFolder: noop,
    createGroup: asyncNoop,
    joinGroup: asyncNoop,
    leaveGroup: noop,
    updateSettings: asyncNoop,
    setOverlayEditMode: noop,
    dismissNotice: noop,
    notify: noop,
    selectWorkout: () => true,
    importWorkout: () => ({ ok: false, errors: [] }),
    deleteWorkout: noop,
    exportWorkout: () => null,
    skipWorkoutSegment: noop,
    restartWorkoutSegment: noop,
    setWorkoutIntensity: noop,
    acceptFtpOutcome: asyncNoop,
    dismissFtpOutcome: noop,
    ...extra,
  } as unknown as App;
}

const render = (state: AppState): string =>
  renderToString(createElement(MainApp, { app: stubApp(state) }));

describe('MainApp (SSR)', () => {
  it('shows a loading state until settings and live state exist', () => {
    const html = render(baseState());
    expect(html).toContain('data-testid="app-loading"');
    expect(html).not.toContain('data-testid="tab-ride"');
  });

  it('renders the ride tab in sim mode with live values', () => {
    const html = render({ ...baseState(), simMode: true, live: liveState() });
    for (const id of [
      'tab-ride',
      'tab-devices',
      'tab-group',
      'tab-history',
      'tab-settings',
      'panel-ride',
      'stat-power',
      'stat-power3s',
      'stat-wattsPerKg',
      'stat-cadence',
      'stat-speed',
      'stat-heartRate',
      'stat-gear',
      'stat-time',
      'stat-distance',
      'ride-pause',
      'ride-finish',
      'gear-up',
      'gear-down',
      'gradient-up',
      'gradient-down',
      'sim-panel',
      'sim-effort',
      'sim-badge',
      'banner-heartRate',
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('213');
    // Gear shows the current gear large and the count separately.
    expect(html).toMatch(/data-testid="stat-gear".*?>12<\/span><span class="gear-of">\/ 24</);
    expect(html).toContain('12:34');
    expect(html).toContain('reconnecting…');
    expect(html).not.toContain('data-testid="ride-start"');
    expect(html).not.toContain('data-testid="trainer-missing"');
  });

  it('defaults to the Devices tab when no trainer is known', () => {
    const state = {
      ...baseState(),
      live: liveState({ devices: { trainer: null, heartRate: null, controller: null } }),
    };
    expect(defaultTab(state)).toBe('devices');
    const html = render(state);
    expect(html).toContain('data-testid="panel-devices"');
    expect(html).toContain('not paired');
  });

  it('renders a joined group with the local rider sorted in', () => {
    const state: AppState = {
      ...baseState(),
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        devices: { trainer: { id: 't1', name: 'Trainer' } },
      },
      group: { phase: 'joined', roomCode: 'QX7-K2M', joinLink: 'freilauf://join/QX7-K2M' },
      live: liveState({
        group: {
          roomCode: 'QX7-K2M',
          riders: [
            {
              peerId: 'p1',
              name: 'Ben',
              distanceM: 5354,
              speedMps: 9,
              powerW: 250,
              cadenceRpm: 85,
              heartRateBpm: null,
              gear: 14,
              gapM: 120,
              stale: false,
            },
            {
              peerId: 'p2',
              name: 'Cleo',
              distanceM: 3000,
              speedMps: 8,
              powerW: 180,
              cadenceRpm: 80,
              heartRateBpm: 150,
              gear: 10,
              gapM: -1234,
              stale: true,
            },
          ],
        },
      }),
    };
    const html = renderToString(
      createElement(MainApp, { app: stubApp(state), initialTab: 'group' }),
    );
    expect(html).toContain('data-testid="group-code"');
    expect(html).toContain('QX7-K2M');
    const ben = html.indexOf('Ben');
    const ana = html.indexOf('Ana');
    const cleo = html.indexOf('Cleo');
    expect(ben).toBeGreaterThan(-1);
    expect(ben).toBeLessThan(ana);
    expect(ana).toBeLessThan(cleo);
    expect(html).toContain('+120 m');
    expect(html).toContain('−1.2 km');
    expect(html).toContain('rider-local');
    expect(html).toContain('rider-stale');
    expect(html).toContain('ws://localhost:8787');
  });
});

const imported: Workout = {
  id: 'zwo-tempo-1',
  name: 'Tempo pyramid',
  description: 'Up and down through tempo.',
  steps: [
    { kind: 'ramp', durationS: 300, powerStart: 0.5, powerEnd: 0.75 },
    { kind: 'steady', durationS: 600, power: 0.88 },
    { kind: 'freeRide', durationS: 300 },
  ],
};

function withWorkouts(overrides: Partial<AppState> = {}): AppState {
  const library = new WorkoutLibrary(null);
  library.add(imported);
  return {
    ...baseState(),
    simMode: true,
    live: liveState({ ride: { ...liveState().ride, state: 'idle' } }),
    workouts: library.list(),
    ...overrides,
  };
}

const renderTab = (state: AppState, tab: TabId, extra: Record<string, unknown> = {}): string =>
  renderToString(createElement(MainApp, { app: stubApp(state, extra), initialTab: tab }));

/** The HTML of the element that carries `marker` up to the next row (rough, enough for SSR). */
function rowHtml(html: string, id: string): string {
  const start = html.indexOf(`data-workout-id="${id}"`);
  expect(start, id).toBeGreaterThan(-1);
  const next = html.indexOf('data-workout-id="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

function runningWorkout(overrides: Partial<WorkoutLive> = {}): WorkoutLive {
  return {
    id: 'builtin-sweet-spot-3x12',
    name: 'Sweet spot 3×12',
    mode: 'erg',
    label: 'Interval 2/3 · on',
    targetPowerW: 180,
    elapsedS: 1500,
    totalDurationS: 4020,
    segmentElapsedS: 300,
    segmentRemainingS: 420,
    totalRemainingS: 2520,
    next: { label: 'Interval 2/3 · off', targetPowerW: 110, durationS: 240 },
    cue: 'Smooth and steady.',
    intensity: 1,
    finished: false,
    started: true,
    ...overrides,
  };
}

describe('Workouts tab (SSR)', () => {
  it('lists FTP tests, the library and imported workouts with estimates', () => {
    const html = renderTab(withWorkouts(), 'workouts');
    expect(html).toContain('data-testid="tab-workouts"');
    expect(html).toContain('data-testid="panel-workouts"');
    // Tab order: Ride, Workouts, Devices.
    expect(html.indexOf('tab-ride')).toBeLessThan(html.indexOf('tab-workouts'));
    expect(html.indexOf('tab-workouts')).toBeLessThan(html.indexOf('tab-devices'));
    expect(html).toContain('FTP tests');
    expect(html).toContain('Library');
    expect(html).toContain('My workouts');
    expect(html).toContain('Your FTP: <strong>200 W</strong>');
    expect(html).toContain('data-testid="workout-import"');
    expect(html).toContain('accept=".zwo,.json,.xml"');

    // The 20-minute test appears once (it is also in the built-in list).
    expect(html.split('data-workout-id="builtin-ftp-test-20"')).toHaveLength(2);
    const twenty = rowHtml(html, 'builtin-ftp-test-20');
    expect(twenty).toContain('95 % of your 20-minute average power');
    expect(twenty).toMatch(/TSS ≈ \d+/);
    const ramp = rowHtml(html, 'builtin-ftp-test-ramp');
    expect(ramp).toContain('75 % of your best one-minute power');
    expect(ramp).toContain('Open-ended');
    expect(ramp).not.toContain('TSS');
    expect(ramp).not.toContain('IF ≈');

    const sweet = rowHtml(html, 'builtin-sweet-spot-3x12');
    expect(sweet).toContain('1 h 7 min');
    expect(sweet).toMatch(/avg ≈ \d+ W/);
    expect(sweet).toMatch(/NP ≈ \d+ W/);
    expect(sweet).toMatch(/IF ≈ 0\.\d\d/);
    expect(sweet).toContain('role="img"');
    expect(sweet).toContain('aria-label="Power profile of Sweet spot 3×12');
    expect(sweet).toContain('data-testid="workout-select"');

    const mine = html.slice(html.indexOf('data-testid="workouts-mine"'));
    expect(mine).toContain('Tempo pyramid');
    expect(mine).toContain('url(#hatch-'); // free ride drawn hatched
    // No group: nothing about sharing.
    expect(html).not.toContain('Shared by the group');
    expect(html).not.toContain('data-testid="workouts-locked"');
  });

  it('marks the selected workout and offers Go to ride / Clear', () => {
    const html = renderTab(withWorkouts({ selectedWorkoutId: 'builtin-vo2max-5x4' }), 'workouts');
    const row = rowHtml(html, 'builtin-vo2max-5x4');
    expect(row).toContain('data-selected="true"');
    expect(row).toContain('Selected for next ride');
    expect(row).toContain('data-testid="workout-go-ride"');
    expect(row).toContain('data-testid="workout-clear"');
    expect(row).not.toContain('data-testid="workout-select"');
    expect(html.match(/Selected for next ride/g)).toHaveLength(1);
  });

  it('locks selection while a ride is in progress and explains why', () => {
    const state = withWorkouts();
    state.live = liveState(); // riding
    const html = renderTab(state, 'workouts');
    expect(html).toContain('data-testid="workouts-locked"');
    expect(rowHtml(html, 'builtin-openers-30')).toMatch(
      /data-testid="workout-select"[^>]*disabled/,
    );
  });

  it('shows group sharing only when joined and the app can share', () => {
    const shared = withWorkouts({
      group: { phase: 'joined', roomCode: 'QX7', joinLink: 'x' },
      sharedWorkouts: [{ peerId: 'p1', peerName: 'Ben', workout: { ...imported, id: 'shared-1' } }],
    });
    expect(renderTab(shared, 'workouts')).not.toContain('Shared by the group');
    const noop = (): void => undefined;
    const html = renderTab(shared, 'workouts', {
      shareWorkout: noop,
      stopSharingWorkout: noop,
      useSharedWorkout: noop,
    });
    expect(html).toContain('Shared by the group');
    expect(html).toContain('Shared by Ben');
    expect(html).toContain('data-testid="shared-workout-use"');
  });
});

describe('Ride tab with a workout (SSR)', () => {
  const ride = (workout: WorkoutLive, overrides: Partial<AppState> = {}): string =>
    renderTab(withWorkouts({ live: liveState({ workout }), ...overrides }), 'ride');

  it('shows the selected workout before the start', () => {
    const state = withWorkouts({
      selectedWorkoutId: 'builtin-sweet-spot-3x12',
      live: liveState({
        ride: { ...liveState().ride, state: 'idle' },
        workout: runningWorkout({ started: false, mode: 'free', targetPowerW: null }),
      }),
    });
    const html = renderTab(state, 'ride');
    expect(html).toContain('data-testid="workout-banner"');
    expect(html).toContain('Sweet spot 3×12');
    expect(html).toContain('1 h 7 min');
    expect(html).toContain('data-testid="workout-banner-clear"');
    expect(html).not.toContain('data-testid="workout-panel"');
    expect(html).not.toContain('data-testid="workout-start-together"');
    // In a group, with the method available: start together.
    const grouped = renderTab(
      { ...state, group: { phase: 'joined', roomCode: 'Q', joinLink: 'x' } },
      'ride',
      { startTogether: () => undefined },
    );
    expect(grouped).toContain('data-testid="workout-start-together"');
    expect(grouped).toContain('Start together in 10 s');
  });

  it('renders a running ERG step: target, countdown, next, cue and controls', () => {
    const html = ride(runningWorkout());
    expect(html).toContain('data-testid="workout-panel"');
    expect(html).toContain('data-mode="erg"');
    expect(html).toMatch(/data-testid="workout-target-value">180</);
    expect(html).toMatch(/data-testid="workout-remaining">7:00</);
    expect(html).toContain('Workout left 42:00');
    expect(html).toContain('Interval 2/3 · on');
    expect(html).toContain('Next: 4 min @ 110 W');
    expect(html).toMatch(/aria-live="polite" data-testid="workout-cue">Smooth and steady.</);
    for (const id of ['workout-skip', 'workout-back', 'workout-intensity', 'workout-deviation']) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('100 %');
    // 3 s power 207 W vs 180 W target: 15 % over → insistent.
    expect(html).toContain('data-level="alert"');
    expect(html).toContain('27 W over');
    // ERG: gear and gradient stay usable but are explained.
    expect(html).toContain('data-testid="erg-note"');
    expect(html).toContain('data-testid="gear-up"');
    expect(html).toContain('data-testid="workout-progress-chart"');
  });

  it('explains free-ride mode and the 20-minute test effort', () => {
    const free = ride(
      runningWorkout({ mode: 'free', targetPowerW: null, label: 'Free ride', cue: undefined }),
    );
    expect(free).toContain('data-mode="free"');
    expect(free).toContain('trainer is in free-ride mode');
    expect(free).toContain('You set the pace');
    expect(free).not.toContain('data-testid="erg-note"');
    const test = ride(
      runningWorkout({
        id: 'builtin-ftp-test-20',
        name: 'FTP test · 20 minutes',
        ftpTest: 'twentyMinute',
        mode: 'free',
        targetPowerW: null,
        label: 'FTP test · 20 min',
      }),
    );
    expect(test).toContain('All out for 20 minutes — pace yourself');
  });

  it('shows the finished state', () => {
    const html = ride(
      runningWorkout({
        finished: true,
        mode: 'free',
        targetPowerW: null,
        label: 'Workout complete',
        next: undefined,
        cue: undefined,
        segmentRemainingS: 0,
        totalRemainingS: 0,
      }),
    );
    expect(html).toContain('data-mode="finished"');
    expect(html).toMatch(/data-testid="workout-label">Workout complete</);
    expect(html).toContain('Keep riding or finish');
    expect(html).toContain('Workout time');
    expect(html).toMatch(/data-testid="workout-skip"[^>]*disabled/);
  });

  it('shows a pending group countdown', () => {
    const html = renderTab(withWorkouts({ groupCountdownS: 6.4 }), 'ride');
    expect(html).toMatch(/data-testid="group-countdown"[\s\S]*?>7</);
  });
});

describe('FTP result dialog (SSR)', () => {
  it('offers a valid result with previous FTP and the change', () => {
    const html = render(
      withWorkouts({
        ftpOutcome: {
          kind: 'twentyMinute',
          valid: true,
          ftpW: 238,
          basisPowerW: 251,
          previousFtpW: 200,
        },
      }),
    );
    expect(html).toContain('data-testid="ftp-outcome"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('20-minute average');
    expect(html).toContain('251 W');
    expect(html).toContain('238');
    expect(html).toContain('+38 W (+19 %)');
    expect(html).toContain('data-testid="ftp-accept"');
    expect(html).toContain('Save as my FTP');
    expect(html).toContain('data-testid="ftp-dismiss"');
    expect(html).toContain('Not now');
  });

  it('explains an invalid result and only offers Close', () => {
    const html = render(
      withWorkouts({
        ftpOutcome: {
          kind: 'ramp',
          valid: false,
          reason: 'The ramp lasted less than 3 minutes.',
          ftpW: 0,
          basisPowerW: 0,
          previousFtpW: 200,
        },
      }),
    );
    expect(html).toContain('The ramp lasted less than 3 minutes.');
    expect(html).not.toContain('data-testid="ftp-accept"');
    expect(html).toContain('>Close<');
  });
});

describe('Settings (SSR)', () => {
  it('has an FTP field with a link to the tests and readable new overlay stats', () => {
    const html = renderTab(withWorkouts(), 'settings');
    expect(html).toContain('data-testid="settings-ftp"');
    expect(html).toContain('FTP (W)');
    expect(html).toContain('value="200"');
    expect(html).toContain('Measure it with an FTP test');
    expect(html).toContain('>Target power<');
    expect(html).toContain('>Step left<');
  });
});
