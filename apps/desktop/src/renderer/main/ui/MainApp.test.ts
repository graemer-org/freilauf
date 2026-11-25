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
import type { InitialScreen } from './MainApp';
import { MainApp } from './index';
import { GroupTab } from './GroupTab';
import { AppContext } from './hooks';
import { CommunityService } from '../../core/communityService';

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
    community: new CommunityService({ storage: null }).view,
    lastButton: null,
    levers: null,
    routes: [],
    selectedRouteId: null,
    routeTrack: null,
    sharedRoutes: [],
    sharingRouteId: null,
    lastRide: null,
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

function joinedGroup(roomCode: string, joinLink: string): AppState['group'] {
  return {
    phase: 'joined',
    roomCode,
    joinLink,
    inviteCode: roomCode,
    transport: 'relays',
    relay: 'ready',
    role: 'host',
    signallingUrl: '',
    peers: [],
    notes: [],
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

const renderScreen = (state: AppState, screen: InitialScreen): string =>
  renderToString(createElement(MainApp, { app: stubApp(state), initialScreen: screen }));

describe('MainApp (SSR)', () => {
  it('shows a loading state until settings and live state exist', () => {
    const html = render(baseState());
    expect(html).toContain('data-testid="app-loading"');
    expect(html).not.toContain('data-testid="start-screen"');
  });

  it('opens on the start screen: one primary button, the choice, the devices', () => {
    const html = render({
      ...baseState(),
      simMode: true,
      live: liveState({ ride: { ...liveState().ride, state: 'idle' } }),
    });
    for (const id of [
      'panel-start',
      'start-screen',
      'start-riding',
      'start-open-ride',
      'ride-kind-free',
      'ride-kind-workout',
      'ride-kind-ftp',
      'start-summary',
      'with-alone',
      'with-group',
      'start-devices',
      'chip-trainer',
      'chip-heartRate',
      'chip-controller',
      'nav-activity',
      'nav-settings',
      'sim-badge',
      // Untouched rider data: the first-run questions, inline (never a blocking dialog).
      'first-run',
      'first-run-skip',
      'first-run-ftp-unknown',
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('What are you riding today?');
    expect(html).toContain('>Start riding<');
    expect(html).toMatch(/data-testid="ride-kind-free"[^>]*aria-pressed="true"/);
    // No tab bar any more, no ride underneath.
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('data-testid="stat-power"');
    expect(html).not.toContain('role="dialog"');
    // Trainer connected: no warning.
    expect(html).not.toContain('data-testid="start-device-warning"');
  });

  it('does not ask the first-run questions once the rider data was set', () => {
    const state = { ...baseState(), live: liveState() };
    state.settings!.rider.name = 'Ana';
    expect(render(state)).not.toContain('data-testid="first-run"');
  });

  it('renders the ride view in sim mode with live values', () => {
    const html = renderScreen({ ...baseState(), simMode: true, live: liveState() }, 'ride');
    for (const id of [
      'ride-leave',
      'ride-open-devices',
      'ride-open-group',
      'ride-open-overlay',
      'dot-trainer',
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
    // The ride fills the window: no start-screen chrome, and no return bar inside the ride.
    expect(html).not.toContain('data-testid="start-screen"');
    expect(html).not.toContain('data-testid="ride-return-bar"');
  });

  it('shows a persistent way back to a ride in progress on every other screen', () => {
    for (const screen of ['start', 'settings', 'activity', 'devices', 'workouts'] as const) {
      const html = renderScreen({ ...baseState(), simMode: true, live: liveState() }, screen);
      expect(html, screen).toContain('data-testid="ride-return-bar"');
      expect(html, screen).toContain('data-testid="ride-return"');
      expect(html, screen).toContain('Ride in progress');
    }
    const start = renderScreen({ ...baseState(), simMode: true, live: liveState() }, 'start');
    expect(start).toContain('>Return to ride<');
    expect(start).toContain('data-testid="start-locked"');
  });

  it('puts the ride scene and its profile strip at the centre of the ride view', () => {
    const html = renderScreen(
      {
        ...baseState(),
        simMode: true,
        live: liveState({ ride: { ...liveState().ride, gradePercent: 4.5 } }),
      },
      'ride',
    );
    expect(html).toContain('data-testid="ride-scene"');
    expect(html).toContain('data-testid="ride-profile"');
    expect(html).toContain('data-grade="4.5"');
    expect(html).toContain('data-lateral="0.00"');
    expect(html).toMatch(
      /role="img"[^>]*aria-label="Climbing at 4.5 percent, 34 kilometres per hour, cadence 90 rpm."/,
    );
    // Scene sits in the stat grid between power and the other numbers.
    const order = ['stat-power', 'ride-scene', 'stat-cadence', 'stat-distance'].map((id) =>
      html.indexOf(`data-testid="${id}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Keyboard steering is documented next to the other shortcuts.
    expect(html).toMatch(/<kbd>A<\/kbd> <kbd>D<\/kbd> steer/);
  });

  it('warns on the start screen when no trainer is known, but can still start', () => {
    const state = {
      ...baseState(),
      live: liveState({
        ride: { ...liveState().ride, state: 'idle' },
        devices: { trainer: null, heartRate: null, controller: null },
      }),
    };
    const html = render(state);
    expect(html).toContain('data-testid="panel-start"');
    expect(html).toContain('not paired');
    expect(html).toContain('data-testid="start-device-warning"');
    expect(html).toContain('You can still start — power will read 0.');
    expect(html).toContain('data-testid="start-pair-trainer"');
    expect(html).not.toMatch(/data-testid="start-riding"[^>]*disabled/);
  });

  it('renders a joined group with the local rider sorted in', () => {
    const state: AppState = {
      ...baseState(),
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        devices: { trainer: { id: 't1', name: 'Trainer' } },
      },
      group: joinedGroup('QX7-K2M', 'freilauf://join/QX7-K2M'),
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
    const start = renderToString(
      createElement(MainApp, { app: stubApp(state), initialScreen: 'group' }),
    );
    // On the start screen: compact — the invite and who is in the room, no rider table.
    expect(start).toContain('data-testid="start-group"');
    expect(start).toContain('data-testid="group-code"');
    expect(start).toContain('QX7-K2M');
    expect(start).toMatch(
      /data-testid="with-group"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="with-group"/,
    );
    expect(start).not.toContain('data-testid="group-riders"');
    // In the ride view's group panel: the live rider table.
    const html = renderToString(
      createElement(
        AppContext.Provider,
        { value: stubApp(state) },
        createElement(GroupTab, { variant: 'ride', onOpenSettings() {} }),
      ),
    );
    expect(html).toContain('data-testid="group-riders"');
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
    expect(html).toContain('data-testid="group-relay-state" data-state="ready"');
    expect(html).toContain('data-testid="group-link"');
    // Riders are visible, so the room is not shown as empty.
    expect(html).not.toContain('data-testid="group-empty"');
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

const renderTab = (
  state: AppState,
  screen: InitialScreen,
  extra: Record<string, unknown> = {},
): string =>
  renderToString(createElement(MainApp, { app: stubApp(state, extra), initialScreen: screen }));

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
    expect(html).toContain('data-testid="panel-workouts"');
    // A picker inside the start flow: Back leads to the start screen.
    expect(html).toMatch(/data-testid="screen-back"[^>]*>.*Start</);
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

  it('marks the selected workout and offers Done / Clear', () => {
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
      group: joinedGroup('QX7', 'x'),
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
    const grouped = renderTab({ ...state, group: joinedGroup('Q', 'x') }, 'ride', {
      startTogether: () => undefined,
    });
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

  it('shows a pending group countdown, in the same look as the local one', () => {
    const idle = liveState({ ride: { ...liveState().ride, state: 'idle' } });
    const html = renderTab(
      withWorkouts({
        groupCountdownS: 7,
        live: { ...idle, countdown: { kind: 'group', remainingS: 6.4, totalS: 10 } },
      }),
      'ride',
    );
    expect(html).toMatch(/data-testid="ride-countdown" data-kind="group"/);
    expect(html).toMatch(/data-testid="countdown-digit">7</);
    expect(html).toContain('Starting together');
    // No second, local countdown is offered meanwhile: no "Start together", Start cancels.
    expect(html).not.toContain('data-testid="workout-start-together"');
    expect(html).toMatch(/data-testid="ride-start" data-countdown="true">Cancel</);
  });
});

const SUMMARY: NonNullable<AppState['lastRide']> = {
  rideId: 'ride-1',
  durationS: 1834,
  distanceM: 15_420,
  avgPowerW: 212,
  points: 31,
  bests: [{ key: 'p5m', powerW: 288, previousW: 270 }],
  workoutName: 'FTP test · 20 minutes',
  routeName: null,
};

describe('Post-ride summary (SSR)', () => {
  it('shows time, distance, power, points with the week, bests, export and the way on', () => {
    const html = renderTab(withWorkouts({ lastRide: SUMMARY }), 'summary');
    expect(html).toContain('data-testid="summary-screen"');
    expect(html).toMatch(/data-testid="summary-duration".*?>30:34</);
    expect(html).toMatch(/data-testid="summary-distance".*?>15.42<.*?>km</);
    expect(html).toMatch(/data-testid="summary-power".*?>212<.*?>W</);
    expect(html).toMatch(/data-testid="summary-points".*?>\+31</);
    expect(html).toMatch(/data-testid="summary-week-points">0 this week</);
    expect(html).toContain('Best 5 min power');
    expect(html).toContain('288 W');
    expect(html).toContain('was 270 W');
    for (const id of ['summary-export-fit', 'summary-again', 'summary-done']) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).not.toContain('data-testid="ftp-outcome"');
  });

  it('says so when the ride was too short to keep', () => {
    const html = renderTab(
      withWorkouts({
        lastRide: { ...SUMMARY, rideId: null, avgPowerW: null, points: null, bests: [] },
      }),
      'summary',
    );
    expect(html).toContain('data-testid="summary-not-saved"');
    expect(html).not.toContain('data-testid="summary-export-fit"');
  });
});

describe('FTP result in the summary (SSR)', () => {
  it('offers a valid result with previous FTP and the change', () => {
    const html = renderTab(
      withWorkouts({
        lastRide: SUMMARY,
        ftpOutcome: {
          kind: 'twentyMinute',
          valid: true,
          ftpW: 238,
          basisPowerW: 251,
          previousFtpW: 200,
        },
      }),
      'summary',
    );
    expect(html).toContain('data-testid="ftp-outcome"');
    // Part of the summary now, not a modal on top of the ride.
    expect(html).not.toContain('role="dialog"');
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
    const html = renderTab(
      withWorkouts({
        lastRide: SUMMARY,
        ftpOutcome: {
          kind: 'ramp',
          valid: false,
          reason: 'The ramp lasted less than 3 minutes.',
          ftpW: 0,
          basisPowerW: 0,
          previousFtpW: 200,
        },
      }),
      'summary',
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

  it('keeps rarely used options under Advanced and controllers out of Settings', () => {
    const html = renderTab(withWorkouts(), 'settings');
    expect(html).toMatch(/<details[^>]*data-testid="settings-advanced"(?![^>]*open)/);
    const advanced = html.slice(html.indexOf('data-testid="settings-advanced"'));
    expect(advanced).toContain('data-testid="settings-ratio"');
    expect(advanced).toContain('data-testid="settings-trainer-mass"');
    expect(html).toMatch(/<details[^>]*data-testid="settings-group-advanced"/);
    expect(html).toContain('data-testid="settings-relays"');
    expect(html).not.toContain('data-testid="button-mapping"');
    expect(html).not.toContain('data-testid="lever-mapping"');
  });
});

describe('Devices, Activity (SSR)', () => {
  it('has the controllers (buttons, levers, dead zone under Advanced) on the Devices screen', () => {
    const html = renderTab(withWorkouts(), 'devices');
    expect(html).toContain('data-testid="device-trainer"');
    expect(html).toContain('data-testid="devices-controllers"');
    expect(html).toContain('data-testid="button-mapping"');
    expect(html).toContain('data-testid="lever-mapping"');
    expect(html).toMatch(/<details[^>]*data-testid="lever-advanced"/);
    expect(html).toContain('data-testid="lever-deadzone"');
  });

  it('puts the ride history and the community under Activity', () => {
    const rides = renderTab(withWorkouts(), 'activity');
    expect(rides).toContain('data-testid="tab-history"');
    expect(rides).toContain('data-testid="tab-community"');
    expect(rides).toContain('data-testid="panel-history"');
    expect(rides).toContain('data-testid="history-empty"');
    const community = renderTab(withWorkouts(), 'community');
    expect(community).toContain('data-testid="panel-community"');
    expect(community).toMatch(/data-testid="tab-community"[^>]*|aria-selected="true"/);
  });
});

describe('Countdown before the ride starts or resumes (SSR)', () => {
  const idle = liveState({ ride: { ...liveState().ride, state: 'idle', elapsedS: 0 } });

  it('shows big digits, "Get ready" and the ring over the ride view; Start becomes Cancel', () => {
    const html = renderScreen(
      {
        ...baseState(),
        simMode: true,
        live: { ...idle, countdown: { kind: 'start', remainingS: 2.3, totalS: 3 } },
      },
      'ride',
    );
    expect(html).toMatch(/data-testid="ride-countdown" data-kind="start" role="timer"/);
    expect(html).toMatch(/data-testid="countdown-digit">3</);
    expect(html).toContain('Get ready');
    expect(html).toContain('Space or Esc cancels');
    expect(html).toContain('class="cd-ring"');
    // The ring shows what is left: 2.3 of 3 s, i.e. 23.3 % gone.
    expect(html).toContain('stroke-dashoffset:23.3');
    expect(html).toMatch(/data-testid="ride-start" data-countdown="true">Cancel</);
    expect(html).toMatch(/data-testid="ride-state"[^>]*>Get ready</);
    // Nothing recorded yet: the ride is still idle and the time reads zero.
    expect(html).toContain('data-state="idle" data-countdown="true" data-testid="ride-state"');
  });

  it('says it resumes after a pause', () => {
    const paused = liveState({ ride: { ...liveState().ride, state: 'paused' } });
    const html = renderScreen(
      {
        ...baseState(),
        simMode: true,
        live: { ...paused, countdown: { kind: 'resume', remainingS: 4.9, totalS: 5 } },
      },
      'ride',
    );
    expect(html).toMatch(/data-kind="resume"/);
    expect(html).toMatch(/data-testid="countdown-digit">5</);
    expect(html).toContain('The ride resumes at zero');
    expect(html).toContain('data-testid="ride-finish"');
  });

  it('shows no countdown without one, and Start / Resume as usual', () => {
    const html = renderScreen({ ...baseState(), simMode: true, live: idle }, 'ride');
    expect(html).not.toContain('data-testid="ride-countdown"');
    expect(html).toMatch(/data-testid="ride-start">Start</);
  });

  it('offers the countdown length in Settings → Ride (Off, 3, 5, 10 s)', () => {
    const state = { ...baseState(), live: idle };
    state.settings!.ride.countdownS = 5;
    const html = renderScreen(state, 'settings');
    expect(html).toContain('data-testid="settings-ride"');
    for (const v of ['0', '3', '5', '10']) {
      expect(html).toContain(`data-testid="settings-countdown-${v}"`);
    }
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="settings-countdown-5"/);
    expect(html).toMatch(/data-testid="settings-countdown-0">Off</);
  });
});
