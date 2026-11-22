// Server-side render smoke test of the main window (no DOM needed).
// A .ts file on purpose: the root Vitest config only collects *.test.ts.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState } from '../appStore';
import type { LiveState } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
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
function stubApp(state: AppState): App {
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
