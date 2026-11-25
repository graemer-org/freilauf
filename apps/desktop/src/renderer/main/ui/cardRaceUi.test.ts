// Server-side render tests of the Card Race UI (docs/card-race.md): the two-card hand, effect
// chips and notices, the mode labels (create, room, guest), incompatible riders, Fog in the
// rider table, the summary lines and the overlay.
import type { GroupRider } from '@freilauf/p2p';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState } from '../appStore';
import { DEFAULT_SETTINGS, type LiveState } from '../../../shared/contract';
import type { CardRaceLive, PowerUpLive } from '../../../shared/powerUps';
import { CARD_RACE_NAME } from '../../../shared/powerUps';
import { CommunityService } from '../../core/communityService';
import { OverlayView } from '../../overlay/ui/OverlayView';
import { cardPills, groupRows } from '../../overlay/ui/logic';
import { CardHandView, cardCueText, incomingText, outgoingText, raceLine } from './CardHand';
import { GroupModeRow, ModeChoice } from './GroupMode';
import { GroupTab } from './GroupTab';
import { AppContext } from './hooks';
import { SummaryScreen } from './SummaryScreen';

function cards(over: Partial<CardRaceLive> = {}): CardRaceLive {
  return {
    slots: [null, null],
    slotNotes: [null, null],
    slotTargets: [null, null],
    attack: null,
    shield: null,
    protection: null,
    immuneS: 0,
    gainM: 0,
    lossM: 0,
    incoming: null,
    outgoing: null,
    ...over,
  };
}

function pu(c: Partial<CardRaceLive> = {}, over: Partial<PowerUpLive> = {}): PowerUpLive {
  const cr = cards(c);
  const hand = cr.slots.filter((k) => k !== null);
  return {
    blocked: null,
    held: hand[0] ?? null,
    hand,
    capacity: 2,
    canActivate: true,
    effect: null,
    challenge: null,
    upcoming: [],
    raceOffsetM: cr.gainM + cr.lossM,
    picked: 0,
    used: 0,
    event: null,
    cards: cr,
    ...over,
  };
}

const noop = (): void => undefined;
const hand = (p: PowerUpLive, notice: { text: string; tone: 'attack' } | null = null) =>
  renderToString(createElement(CardHandView, { pu: p, notice, onPlay: noop, onDismiss: noop }));

describe('the two-card hand (SSR)', () => {
  it('left card bottom left with P, right card bottom right with L; attacks name their target', () => {
    const html = hand(pu({ slots: ['headwind', 'shield'], slotTargets: ['Ben', null] }));
    expect(html).toMatch(/data-testid="card-left"[^>]*data-kind="headwind"[^>]*data-ready="true"/);
    expect(html).toMatch(/data-testid="card-right"[^>]*data-kind="shield"/);
    expect(html).toContain('→ Ben · Left button or P');
    expect(html).toContain('Right button or L');
    expect(html).toContain('aria-keyshortcuts="P"');
    expect(html).toContain('aria-keyshortcuts="L"');
    expect(html).toContain('cr-card is-attack');
    expect(html).toContain('cr-card is-guard');
    expect(html).toMatch(/class="pu-icon"[^>]*data-kind="headwind"/);
  });

  it('says why a card waits, and shows empty slots', () => {
    const html = hand(
      pu({ slots: [null, 'headwind'], slotNotes: [null, 'Ben is protected · 12 s'] }),
    );
    expect(html).toMatch(/data-testid="card-left"[^>]*data-kind=""/);
    expect(html).toContain('Ride through a gate');
    expect(html).toContain('Ben is protected · 12 s');
    expect(html).toMatch(/data-testid="card-right"[^>]*aria-disabled="true"/);
  });

  it('shows what acts on the rider: an attack, own boost, shield, protection; and the split', () => {
    const html = hand(
      pu(
        {
          slots: ['fog', null],
          attack: { kind: 'headwind', by: 'Anna', remainingS: 6.2, durationS: 10 },
          shield: { remainingS: 30, durationS: 60 },
          gainM: 12.4,
          lossM: -8.6,
        },
        { effect: { kind: 'tailwind', phase: 'active', remainingS: 4, durationS: 15 } },
      ),
    );
    expect(html).toMatch(/data-testid="card-hand"[^>]*data-attack="headwind"[^>]*data-shield="up"/);
    expect(html).toMatch(/data-testid="card-attack"[\s\S]*?Headwind[\s\S]*?from Anna · 7 s/);
    expect(html).toMatch(/data-testid="card-boost"[\s\S]*?Tailwind[\s\S]*?Active · 4 s/);
    expect(html).toMatch(/data-testid="card-shield"[\s\S]*?Blocks the next attack · 30 s/);
    expect(html).toContain('+12 m from cards · −9 m from attacks');
    const fog = hand(pu({ attack: { kind: 'fog', by: 'Cleo', remainingS: 3, durationS: 12 } }));
    expect(fog).toContain('Fog · gaps hidden');
    const prot = hand(pu({ protection: { remainingS: 11.2, durationS: 15 } }));
    expect(prot).toMatch(/data-testid="card-protection"[\s\S]*?No attack lands · 12 s/);
    expect(prot).toContain('data-protected="yes"');
    expect(raceLine(cards())).toBeNull();
  });

  it('notices: incoming attacks, our attack’s fate, card cues', () => {
    expect(incomingText({ seq: 1, kind: 'headwind', by: 'Ben', result: 'hit' })).toBe(
      'Ben played Headwind on you',
    );
    expect(incomingText({ seq: 2, kind: 'fog', by: 'Ben', result: 'blocked' })).toBe(
      'Your shield blocked Ben’s Fog',
    );
    expect(incomingText({ seq: 3, kind: 'headwind', by: 'Ben', result: 'protected' })).toContain(
      'you were protected',
    );
    const out = (result: Parameters<typeof outgoingText>[0]['result']) =>
      outgoingText({ seq: 1, kind: 'headwind', target: 'Anna', result });
    expect(out('sent')).toBe('Headwind → Anna');
    expect(out('hit')).toBe('Headwind hit Anna');
    expect(out('blocked')).toBe('Anna’s shield blocked your Headwind');
    expect(out('protected')).toContain('the card is back');
    expect(out('timeout')).toBe('No answer from Anna · the card is back');
    expect(cardCueText(pu({}, { event: { seq: 4, type: 'skipped', kind: 'fog' } }))).toBe(
      'Hand full · play a card first',
    );
    expect(cardCueText(pu({}, { event: { seq: 5, type: 'picked', kind: 'shield' } }))).toBe(
      'Shield card',
    );
    const html = hand(pu(), { text: 'Ben played Headwind on you', tone: 'attack' });
    expect(html).toMatch(
      /class="cr-notice is-attack"[^>]*data-testid="card-notice"[^>]*>Ben played Headwind on you</,
    );
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
    groupPowerUps: true,
    groupMode: 'normal',
    ...over,
  };
}

function withApp(s: AppState, el: ReactElement): string {
  const app = { store: createStore<AppState>(() => s) } as unknown as App;
  return renderToString(createElement(AppContext.Provider, { value: app }, el));
}

const rider = (
  name: string,
  gapM: number,
  withCards = true,
  extra: Partial<GroupRider> = {},
): GroupRider => ({
  peerId: `peer-${name}`,
  name,
  distanceM: 1000,
  speedMps: 9,
  powerW: 200,
  cadenceRpm: 90,
  heartRateBpm: null,
  gear: 11,
  gapM,
  stale: false,
  ...(withCards ? { cards: { v: 1 } } : {}),
  ...extra,
});

const ride: LiveState['ride'] = {
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
};

const joined = (role: 'host' | 'guest'): AppState['group'] => ({
  phase: 'joined',
  roomCode: 'ABCDEF',
  joinLink: 'freilauf://join/ABCDEF#X',
  inviteCode: 'ABC-DEF',
  transport: 'relays',
  relay: 'ready',
  role,
  signallingUrl: '',
  peers: [],
  notes: [],
});

describe('mode labels (SSR)', () => {
  it('creating a ride: Normal or Card Race, with what it means', () => {
    const html = withApp(state({ groupMode: 'cardRace' }), createElement(ModeChoice));
    expect(html).toMatch(/data-testid="group-mode-create-cardRace"[^>]*>Card Race</);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="group-mode-create-cardRace"/);
    expect(html).toContain('Hold two cards');
    const start = withApp(
      state(),
      createElement(GroupTab, { onOpenSettings: noop, variant: 'start' }),
    );
    expect(start).toContain('data-testid="group-mode-choice"');
  });

  it('in the room: the host switches, a guest sees the host’s choice, old apps are named', () => {
    const host = withApp(
      state({ group: joined('host'), groupMode: 'cardRace' }),
      createElement(GroupModeRow, { role: 'host' }),
    );
    expect(host).toMatch(/data-testid="group-mode"[^>]*data-mode="cardRace"/);
    expect(host).toContain('data-testid="group-mode-switch"');
    expect(host).not.toContain('group-powerups-toggle'); // the power-ups switch is normal mode's
    const live = {
      ride,
      devices: { trainer: null, heartRate: null, controller: null },
      group: {
        roomCode: 'ABCDEF',
        mode: 'cardRace',
        riders: [rider('Anna', 10, false), rider('Ben', -5)],
      },
      localName: 'Cleo',
    } as LiveState;
    const guest = withApp(
      state({ group: joined('guest'), live }),
      createElement(GroupModeRow, { role: 'guest' }),
    );
    expect(guest).toMatch(
      /data-testid="group-mode-badge"[^>]*data-mode="cardRace"[^>]*>.*Card Race/,
    );
    expect(guest).toContain('Chosen by the host');
    expect(guest).toMatch(
      /data-testid="group-mode-incompatible"[^>]*>Anna’s app does not support Card Race/,
    );
    const normal = withApp(
      state({
        group: joined('guest'),
        live: { ...live, group: { ...live.group!, mode: undefined } },
      }),
      createElement(GroupModeRow, { role: 'guest' }),
    );
    expect(normal).toMatch(/data-mode="normal"/);
    expect(normal).not.toContain('group-mode-incompatible');
  });

  it('the rider table shows effects on others, and "?" gaps under Fog on this rider', () => {
    const live = {
      ride,
      devices: { trainer: null, heartRate: null, controller: null },
      group: {
        roomCode: 'ABCDEF',
        mode: 'cardRace',
        riders: [rider('Anna', 30, true, { cards: { v: 1, shieldS: 20 } }), rider('Ben', -12)],
      },
      localName: 'Cleo',
      powerUps: pu({ attack: { kind: 'fog', by: 'Ben', remainingS: 5, durationS: 12 } }),
    } as LiveState;
    const html = withApp(
      state({ group: joined('guest'), live }),
      createElement(GroupTab, { onOpenSettings: noop, variant: 'ride' }),
    );
    expect(html).toContain('data-fog="true"');
    expect(html).toMatch(/data-testid="group-rider-fx"[^>]*>Shield</);
    expect(html.match(/data-testid="group-rider-gap"[^>]*>\?</g)).toHaveLength(2);
    const clear = withApp(
      state({ group: joined('guest'), live: { ...live, powerUps: pu() } }),
      createElement(GroupTab, { onOpenSettings: noop, variant: 'ride' }),
    );
    expect(clear).toContain('+30 m');
    expect(clear).not.toContain('data-fog');
  });
});

describe('summary and overlay (SSR)', () => {
  it('the summary splits cards and attacks; the recorded numbers stay apart', () => {
    const lastRide: NonNullable<AppState['lastRide']> = {
      rideId: 'r',
      durationS: 1800,
      distanceM: 15_420,
      avgPowerW: 210,
      points: 30,
      bests: [],
      workoutName: null,
      routeName: null,
      powerUpGainM: 14,
      cards: { gainM: 38, lossM: -24 },
    };
    const html = withApp(
      state({ lastRide }),
      createElement(SummaryScreen, { onDone: noop, onAgain: noop }),
    );
    expect(html).toMatch(/data-testid="summary-cards-gain"[^>]*>\+38 m from cards</);
    expect(html).toMatch(/data-testid="summary-cards-loss"[^>]*>−24 m from attacks</);
    expect(html).toContain(`in your race position (${CARD_RACE_NAME})`);
    expect(html).not.toContain('data-testid="summary-powerups"');
    expect(html).toMatch(/data-testid="summary-distance".*?>15.42</);
  });

  it('the overlay: the attack, the hand with its keys, protection; the mode over the group; "?" under Fog', () => {
    const live: LiveState = {
      ride,
      devices: { trainer: { name: 'T', state: 'connected' }, heartRate: null, controller: null },
      group: { roomCode: 'X', mode: 'cardRace', riders: [rider('Anna', 25)] },
      localName: 'Me',
      powerUps: pu({
        slots: ['headwind', 'shield'],
        slotNotes: [null, null],
        attack: { kind: 'headwind', by: 'Anna', remainingS: 4.2, durationS: 10 },
        lossM: -6,
      }),
    };
    const html = renderToString(
      createElement(OverlayView, { live, settings: DEFAULT_SETTINGS.overlay, editMode: false }),
    );
    expect(html).toMatch(/data-testid="overlay-powerup-attack"[^>]*data-kind="headwind"/);
    expect(html).toContain('ov-powerup--attack');
    expect(html).toMatch(/class="ov-pu-text ov-text">Headwind from Anna</);
    expect(html).toMatch(/class="ov-pu-text ov-text">L Headwind · R Shield</);
    expect(html).toMatch(/class="ov-pu-detail ov-text">P \/ L</);
    expect(html).toMatch(/data-testid="overlay-group-mode"[^>]*>Card Race</);
    // Text stays opaque and outlined; only the backdrop layer fades.
    expect(html).toMatch(/overlay-powerup-attack[\s\S]*?class="ov-backdrop"/);
    expect(
      cardPills(
        pu({ slots: [null, null], protection: { remainingS: 9, durationS: 15 }, lossM: -12 }),
      ).map((p) => p.text),
    ).toEqual(['L – · R –', 'Protected · 9 s']);
    const fogged = {
      ...live,
      powerUps: pu({ attack: { kind: 'fog', by: 'Anna', remainingS: 4, durationS: 12 } }),
    };
    expect(groupRows(fogged).find((r) => !r.local)?.gapText).toBe('?');
    expect(groupRows(live).find((r) => !r.local)?.gapText).toBe('+25 m');
    const foggedHtml = renderToString(
      createElement(OverlayView, {
        live: fogged,
        settings: DEFAULT_SETTINGS.overlay,
        editMode: false,
      }),
    );
    expect(foggedHtml).toContain('Fog from Anna');
    expect(foggedHtml).toContain('gaps hidden');
  });
});
