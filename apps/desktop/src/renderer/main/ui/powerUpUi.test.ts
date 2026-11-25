// Server-side render tests of the power-up UI: the held card, the active effect, the
// challenge card, the summary line, the settings group and the overlay pills.
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState } from '../appStore';
import { DEFAULT_SETTINGS, type LiveState } from '../../../shared/contract';
import type { PowerUpLive } from '../../../shared/powerUps';
import { CommunityService } from '../../core/communityService';
import { OverlayView } from '../../overlay/ui/OverlayView';
import { powerUpPills } from '../../overlay/ui/logic';
import { AppContext } from './hooks';
import { PowerUpDockView, cueText, heldNote } from './PowerUpHud';
import { GroupPowerUps, PowerUpSettings } from './PowerUpSettings';
import { SummaryScreen } from './SummaryScreen';

function pu(over: Partial<PowerUpLive> = {}): PowerUpLive {
  return {
    blocked: null,
    held: null,
    hand: [],
    capacity: 1,
    canActivate: false,
    effect: null,
    challenge: null,
    upcoming: [],
    raceOffsetM: 0,
    picked: 0,
    used: 0,
    event: null,
    ...over,
  };
}

const noop = (): void => undefined;
const dock = (p: PowerUpLive, riding = true, cue: string | null = null): string =>
  renderToString(
    createElement(PowerUpDockView, { pu: p, riding, cue, onUse: noop, onDismiss: noop }),
  );

describe('power-up dock (SSR)', () => {
  it('shows the held card with its icon and the activation hint', () => {
    const html = dock(pu({ held: 'tailwind', hand: ['tailwind'], canActivate: true }));
    expect(html).toContain('data-testid="powerup-card"');
    expect(html).toContain('data-kind="tailwind"');
    expect(html).toContain('Tailwind');
    expect(html).toContain('Press the side button or P');
    expect(html).toMatch(/class="pu-icon"[^>]*data-kind="tailwind"/);
    expect(html).toContain('aria-disabled="false"');
  });

  it('says why a held power-up waits (ERG, FTP test, group, paused)', () => {
    const held = { held: 'slipstream' as const, hand: ['slipstream' as const] };
    expect(dock(pu({ ...held, blocked: 'erg' }))).toContain('not in ERG steps');
    expect(dock(pu({ ...held, blocked: 'erg' }))).toContain('aria-disabled="true"');
    expect(heldNote(pu({ ...held, blocked: 'ftpTest' }), true)).toContain('FTP tests');
    expect(heldNote(pu({ ...held, blocked: 'group' }), true)).toContain('group ride');
    expect(heldNote(pu({ ...held, canActivate: false }), false)).toContain('Resume');
    expect(heldNote(pu({ ...held, canActivate: true }), true)).toBeNull();
  });

  it('shows the active effect with a countdown ring', () => {
    const html = dock(
      pu({ effect: { kind: 'lightLoad', phase: 'active', remainingS: 12.2, durationS: 25 } }),
    );
    expect(html).toContain('data-testid="powerup-effect"');
    expect(html).toContain('data-phase="active"');
    expect(html).toContain('Light load');
    expect(html).toContain('Active · 13 s');
    expect(html).toContain('class="pu-ring-fill"');
    // Half the ring has run down: offset ≈ C × (1 − 12.2/25).
    const c = 2 * Math.PI * 15;
    expect(html).toContain(`stroke-dashoffset="${(c * (1 - 12.2 / 25)).toFixed(2)}"`);
    expect(html).toContain('data-effect="lightLoad"');
  });

  it('shows Downhill momentum as armed', () => {
    const html = dock(
      pu({ effect: { kind: 'downhill', phase: 'armed', remainingS: 150, durationS: 180 } }),
    );
    expect(html).toContain('Armed · waits for a descent');
    expect(html).toContain('pu-ring-fill is-armed');
    expect(html).toContain('data-effect=""');
  });

  it('shows the effort challenge: target, live power, countdown, dismiss', () => {
    const offered = dock(
      pu({
        challenge: {
          phase: 'offered',
          targetW: 250,
          holdS: 30,
          heldS: 0,
          remainingS: 14.2,
          powerW: 212,
        },
      }),
    );
    expect(offered).toContain('data-testid="powerup-challenge"');
    expect(offered).toMatch(/Hold <strong>250 W<\/strong> for 30 s/);
    expect(offered).toMatch(/data-testid="powerup-challenge-power">212 W</);
    expect(offered).toContain('Reach it within 15 s');
    expect(offered).toContain('data-testid="powerup-challenge-dismiss"');
    const holding = dock(
      pu({
        challenge: {
          phase: 'holding',
          targetW: 250,
          holdS: 30,
          heldS: 12,
          remainingS: 18,
          powerW: 255,
        },
      }),
    );
    expect(holding).toContain('Holding · 18 s to go');
    expect(holding).toContain('pu-meter is-on');
    expect(holding).toContain('class="pu-progress"');
  });

  it('shows the race gain and the pick-up cue', () => {
    const html = dock(pu({ raceOffsetM: 37.6 }), true, 'Tailwind picked up');
    expect(html).toMatch(/data-testid="powerup-gain"[^>]*>\+38 m from power-ups</);
    expect(html).toMatch(/data-testid="powerup-cue"[^>]*>Tailwind picked up</);
    expect(cueText({ seq: 2, type: 'skipped', kind: 'tailwind' })).toBe(
      'Already holding a power-up',
    );
    expect(cueText({ seq: 3, type: 'challenge-won', kind: 'downhill' })).toBe(
      'Challenge met · Downhill momentum',
    );
    expect(cueText({ seq: 4, type: 'ended', kind: 'downhill' })).toBeNull();
    // Nothing held, nothing running, no gain: an empty dock.
    expect(dock(pu())).not.toContain('pu-card');
  });
});

function state(over: Partial<AppState> = {}): AppState {
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
    ...over,
  };
}

function withApp(s: AppState, el: ReactElement): string {
  const app = { store: createStore<AppState>(() => s) } as unknown as App;
  return renderToString(createElement(AppContext.Provider, { value: app }, el));
}

const SUMMARY: NonNullable<AppState['lastRide']> = {
  rideId: 'ride-1',
  durationS: 1834,
  distanceM: 15_420,
  avgPowerW: 212,
  points: 31,
  bests: [],
  workoutName: null,
  routeName: 'Rolling loop',
};

describe('summary and settings (SSR)', () => {
  it('the summary names the race gain on its own line; distance is the recorded one', () => {
    const html = withApp(
      state({ lastRide: { ...SUMMARY, powerUpGainM: 38 } }),
      createElement(SummaryScreen, { onDone: noop, onAgain: noop }),
    );
    expect(html).toMatch(/data-testid="summary-powerups"[\s\S]*?\+38 m from power-ups/);
    expect(html).toContain('count your own riding only');
    expect(html).toMatch(/data-testid="summary-distance".*?>15.42</);
    const none = withApp(
      state({ lastRide: SUMMARY }),
      createElement(SummaryScreen, { onDone: noop, onAgain: noop }),
    );
    expect(none).not.toContain('summary-powerups');
  });

  it('Settings → Power-ups has both switches, on by default', () => {
    const html = withApp(state(), createElement(PowerUpSettings));
    expect(html).toContain('data-testid="settings-powerups"');
    expect(html).toMatch(/data-testid="settings-powerups-enabled"[^>]*checked/);
    expect(html).toMatch(/data-testid="settings-powerups-challenges"[^>]*checked/);
    expect(html).toContain('race position');
  });

  it('the group switch is the host’s; guests see the host’s choice', () => {
    expect(withApp(state(), createElement(GroupPowerUps, { role: 'host' }))).toMatch(
      /data-testid="group-powerups-toggle"[^>]*checked/,
    );
    const live = { powerUps: pu({ blocked: 'group' }) } as unknown as LiveState;
    expect(withApp(state({ live }), createElement(GroupPowerUps, { role: 'guest' }))).toContain(
      'switched power-ups off',
    );
  });
});

describe('overlay (SSR)', () => {
  const base: LiveState = {
    ride: {
      state: 'riding',
      elapsedS: 600,
      distanceM: 5000,
      speedMps: 9,
      powerW: 220,
      power3sW: 215,
      wattsPerKg: 2.9,
      cadenceRpm: 88,
      heartRateBpm: 140,
      gear: 12,
      gearCount: 24,
      gradePercent: 0,
    },
    devices: { trainer: { name: 'T', state: 'connected' }, heartRate: null, controller: null },
    group: null,
    localName: 'Me',
  };
  const overlay = (live: LiveState): string =>
    renderToString(
      createElement(OverlayView, {
        live,
        settings: DEFAULT_SETTINGS.overlay,
        editMode: false,
      }),
    );

  it('shows a held power-up compactly, with opaque outlined text', () => {
    const html = overlay({
      ...base,
      powerUps: pu({ held: 'tailwind', hand: ['tailwind'], canActivate: true }),
    });
    expect(html).toMatch(/data-testid="overlay-powerup-held"[^>]*data-kind="tailwind"/);
    expect(html).toMatch(/class="ov-pu-text ov-text">Tailwind ready</);
    expect(html).toContain('side button / P');
    expect(html).toContain('ov-powerup--active');
    expect(html).toMatch(/overlay-powerup-held[\s\S]*?class="ov-backdrop"/);
  });

  it('shows the running effect and the challenge; nothing before the ride', () => {
    const pills = powerUpPills(
      pu({
        effect: { kind: 'slipstream', phase: 'active', remainingS: 9.5, durationS: 30 },
        raceOffsetM: 21,
        challenge: null,
      }),
    );
    expect(pills).toEqual([
      {
        key: 'effect',
        kind: 'slipstream',
        text: 'Slipstream · 10 s',
        detail: '+21 m',
        active: true,
      },
    ]);
    const html = overlay({
      ...base,
      powerUps: pu({
        challenge: {
          phase: 'holding',
          targetW: 250,
          holdS: 30,
          heldS: 4,
          remainingS: 26,
          powerW: 251,
        },
      }),
    });
    expect(html).toContain('data-testid="overlay-powerup-challenge"');
    expect(html).toContain('Hold 250 W · 26 s');
    const idle = overlay({
      ...base,
      ride: { ...base.ride, state: 'idle' },
      powerUps: pu({ held: 'tailwind', hand: ['tailwind'] }),
    });
    expect(idle).not.toContain('overlay-powerup');
    expect(powerUpPills(null)).toEqual([]);
  });
});
