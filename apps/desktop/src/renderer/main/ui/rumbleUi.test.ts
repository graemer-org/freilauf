// Server-side render tests of the Freilauf Rumble UI (docs/rumble.md): the two item slots,
// effect chips, notices and the incoming marker, the mode labels (create, room, guest),
// incompatible riders, hornets in the rider table, the summary lines and the overlay.
import type { GroupRider } from '@freilauf/p2p';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState } from '../appStore';
import { DEFAULT_SETTINGS, type LiveState } from '../../../shared/contract';
import type { PowerUpLive, RumbleLive } from '../../../shared/powerUps';
import { RUMBLE_NAME } from '../../../shared/powerUps';
import { CommunityService } from '../../core/communityService';
import { OverlayView } from '../../overlay/ui/OverlayView';
import { groupRows, rumblePills } from '../../overlay/ui/logic';
import {
  ItemSlotsView,
  hitTitle,
  incomingText,
  itemCueText,
  outgoingText,
  puddleAhead,
  raceLine,
} from './ItemSlots';
import { GroupModeRow, ModeChoice } from './GroupMode';
import { GroupTab, fxTag } from './GroupTab';
import { AppContext } from './hooks';
import { SummaryScreen } from './SummaryScreen';

function rumble(over: Partial<RumbleLive> = {}): RumbleLive {
  return {
    slots: [null, null],
    slotNotes: [null, null],
    slotTargets: [null, null],
    hit: null,
    cape: null,
    protection: null,
    immuneS: 0,
    gainM: 0,
    lossM: 0,
    incoming: null,
    outgoing: null,
    puddles: [],
    ...over,
  };
}

function pu(c: Partial<RumbleLive> = {}, over: Partial<PowerUpLive> = {}): PowerUpLive {
  const r = rumble(c);
  const hand = r.slots.filter((k) => k !== null);
  return {
    blocked: null,
    held: hand[0] ?? null,
    hand,
    capacity: 2,
    canActivate: true,
    effect: null,
    challenge: null,
    upcoming: [],
    raceOffsetM: r.gainM + r.lossM,
    picked: 0,
    used: 0,
    event: null,
    rumble: r,
    ...over,
  };
}

const noop = (): void => undefined;
const slots = (
  p: PowerUpLive,
  notice: { text: string; tone: 'attack' } | null = null,
  incoming: { kind: 'bottle' | 'hornets'; by: string } | null = null,
) =>
  renderToString(
    createElement(ItemSlotsView, { pu: p, notice, incoming, onUse: noop, onDismiss: noop }),
  );

describe('the two item slots (SSR)', () => {
  it('left slot bottom left with P, right slot bottom right with L; aimed items name their target', () => {
    const html = slots(pu({ slots: ['bottle', 'cape'], slotTargets: ['Ben', null] }));
    expect(html).toMatch(/data-testid="item-left"[^>]*data-kind="bottle"[^>]*data-ready="true"/);
    expect(html).toMatch(/data-testid="item-right"[^>]*data-kind="cape"/);
    expect(html).toContain('Water bottle');
    expect(html).toContain('Rain cape');
    expect(html).toContain('→ Ben · Left button or P');
    expect(html).toContain('Right button or L');
    expect(html).toContain('aria-keyshortcuts="P"');
    expect(html).toContain('aria-keyshortcuts="L"');
    expect(html).toContain('rb-item is-attack');
    expect(html).toContain('rb-item is-guard');
    expect(html).toContain('aria-label="Your items"');
    expect(html).toMatch(/class="rb-pocket"[^>]*><svg class="pu-icon"[^>]*data-kind="bottle"/);
    const more = slots(pu({ slots: ['puddle', 'hornets'], slotTargets: [null, 'Cleo'] }));
    expect(more).toContain('Mud puddle');
    expect(more).toContain('Hornets');
    expect(more).toContain('→ Cleo · Right button or L');
  });

  it('says why an item waits, and shows empty slots', () => {
    const html = slots(
      pu({ slots: [null, 'bottle'], slotNotes: [null, 'Ben is protected · 12 s'] }),
    );
    expect(html).toMatch(/data-testid="item-left"[^>]*data-kind=""/);
    expect(html).toContain('Left slot');
    expect(html).toContain('Ride past a feed bag');
    expect(html).toContain('Ben is protected · 12 s');
    expect(html).toMatch(/data-testid="item-right"[^>]*aria-disabled="true"/);
  });

  it('shows what acts on the rider: a hit, own boost, rain cape, protection; puddles ahead; the split', () => {
    const html = slots(
      pu(
        {
          slots: ['hornets', null],
          hit: { kind: 'bottle', by: 'Anna', remainingS: 6.2, durationS: 10 },
          cape: { remainingS: 30, durationS: 60 },
          gainM: 12.4,
          lossM: -8.6,
          puddles: [
            { id: 'a', aheadM: -3, own: true, by: 'Cleo' },
            { id: 'b', aheadM: 41.6, own: false, by: 'Anna' },
          ],
        },
        { effect: { kind: 'tailwind', phase: 'active', remainingS: 4, durationS: 15 } },
      ),
    );
    expect(html).toMatch(/data-testid="item-slots"[^>]*data-hit="bottle"[^>]*data-cape="on"/);
    expect(html).toMatch(
      /data-testid="rumble-hit"[\s\S]*?Water bottle · slowed[\s\S]*?from Anna · 7 s/,
    );
    expect(html).toMatch(/data-testid="rumble-boost"[\s\S]*?Tailwind[\s\S]*?Active · 4 s/);
    expect(html).toMatch(/data-testid="rumble-cape"[\s\S]*?Keeps off the next hit · 30 s/);
    expect(html).toMatch(/data-testid="rumble-puddle-ahead"[^>]*>Anna’s mud puddle ahead · 42 m</);
    expect(html).toContain('+12 m from items · −9 m from hits');
    const hornets = slots(
      pu({ hit: { kind: 'hornets', by: 'Cleo', remainingS: 3, durationS: 8 } }),
    );
    expect(hornets).toContain('Hornets · gaps hidden');
    const prot = slots(pu({ protection: { remainingS: 11.2, durationS: 15 } }));
    expect(prot).toMatch(/data-testid="rumble-protection"[\s\S]*?Nothing lands · 12 s/);
    expect(prot).toContain('data-protected="yes"');
    expect(raceLine(rumble())).toBeNull();
    expect(
      puddleAhead(rumble({ puddles: [{ id: 'x', aheadM: 400, own: false, by: 'A' }] })),
    ).toBeNull();
  });

  it('notices: what hit you, what became of your item, item cues; the incoming marker', () => {
    expect(incomingText({ seq: 1, kind: 'bottle', by: 'Ben', result: 'hit' })).toBe(
      'Ben got you with a water bottle',
    );
    expect(incomingText({ seq: 2, kind: 'hornets', by: 'Ben', result: 'hit' })).toBe(
      'Ben sent hornets after you',
    );
    expect(incomingText({ seq: 3, kind: 'puddle', by: 'Ben', result: 'hit' })).toBe(
      'You rode through Ben’s mud puddle',
    );
    expect(incomingText({ seq: 4, kind: 'bottle', by: 'Ben', result: 'blocked' })).toBe(
      'Your rain cape kept off Ben’s water bottle',
    );
    expect(incomingText({ seq: 5, kind: 'bottle', by: 'Ben', result: 'protected' })).toContain(
      'you were protected',
    );
    const out = (
      result: Parameters<typeof outgoingText>[0]['result'],
      kind: 'bottle' | 'puddle' | 'hornets' = 'bottle',
      target = 'Anna',
    ) => outgoingText({ seq: 1, kind, target, result });
    expect(out('sent')).toBe('Water bottle → Anna');
    expect(out('hit')).toBe('Your water bottle got Anna');
    expect(out('hit', 'hornets')).toBe('Your hornets caught Anna');
    expect(out('sent', 'puddle', '')).toBe('Mud puddle dropped behind you');
    expect(out('hit', 'puddle', 'Cleo')).toBe('Cleo rode through your mud puddle');
    expect(out('blocked')).toBe('Anna’s rain cape kept off your water bottle');
    expect(out('protected')).toContain('the item is back');
    expect(out('timeout')).toBe('No answer from Anna · the item is back');
    expect(itemCueText(pu({}, { event: { seq: 4, type: 'skipped', kind: 'cape' } }))).toBe(
      'Both slots full · use an item first',
    );
    expect(itemCueText(pu({}, { event: { seq: 5, type: 'picked', kind: 'cape' } }))).toBe(
      'Rain cape from the feed bag',
    );
    expect(itemCueText(pu({}, { event: { seq: 6, type: 'dropped', kind: 'puddle' } }))).toBeNull();
    const html = slots(
      pu(),
      { text: 'Ben got you with a water bottle', tone: 'attack' },
      {
        kind: 'bottle',
        by: 'Ben',
      },
    );
    expect(html).toMatch(
      /class="rb-notice is-attack"[^>]*data-testid="rumble-notice"[^>]*>Ben got you with a water bottle</,
    );
    expect(html).toMatch(
      /data-testid="rumble-incoming"[^>]*data-kind="bottle"[\s\S]*?Water bottle from Ben/,
    );
  });

  it('never uses a commercial kart game’s words', () => {
    const html =
      slots(pu({ slots: ['bottle', 'puddle'] })) + slots(pu({ slots: ['hornets', 'cape'] }));
    expect(html).not.toMatch(/kart|mario|shell|banana|card/i);
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
  withItems = true,
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
  ...(withItems ? { items: { v: 2 } } : {}),
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
  it('creating a ride: Normal or Freilauf Rumble, with what it means', () => {
    const html = withApp(state({ groupMode: 'rumble' }), createElement(ModeChoice));
    expect(html).toMatch(/data-testid="group-mode-create-normal"[^>]*>Normal</);
    expect(html).toMatch(/data-testid="group-mode-create-rumble"[^>]*>Freilauf Rumble</);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="group-mode-create-rumble"/);
    expect(html).toContain('Grab items from feed bags');
    const start = withApp(
      state(),
      createElement(GroupTab, { onOpenSettings: noop, variant: 'start' }),
    );
    expect(start).toContain('data-testid="group-mode-choice"');
  });

  it('in the room: the host switches, a guest sees the host’s choice, old apps are named', () => {
    const host = withApp(
      state({ group: joined('host'), groupMode: 'rumble' }),
      createElement(GroupModeRow, { role: 'host' }),
    );
    expect(host).toMatch(/data-testid="group-mode"[^>]*data-mode="rumble"/);
    expect(host).toContain('data-testid="group-mode-switch"');
    expect(host).not.toContain('group-powerups-toggle'); // the power-ups switch is normal mode's
    const live = {
      ride,
      devices: { trainer: null, heartRate: null, controller: null },
      group: {
        roomCode: 'ABCDEF',
        mode: 'rumble',
        riders: [rider('Anna', 10, false), rider('Ben', -5)],
      },
      localName: 'Cleo',
    } as LiveState;
    const guest = withApp(
      state({ group: joined('guest'), live }),
      createElement(GroupModeRow, { role: 'guest' }),
    );
    expect(guest).toMatch(
      /data-testid="group-mode-badge"[^>]*data-mode="rumble"[^>]*>.*Freilauf Rumble/,
    );
    expect(guest).toContain('Chosen by the host');
    expect(guest).toMatch(
      /data-testid="group-mode-incompatible"[^>]*>Anna’s app does not support Freilauf Rumble: they ride along with normal power-ups and nothing can hit them\./,
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

  it('the rider table shows effects on others, and "?" gaps while hornets buzz around this rider', () => {
    const live = {
      ride,
      devices: { trainer: null, heartRate: null, controller: null },
      group: {
        roomCode: 'ABCDEF',
        mode: 'rumble',
        riders: [
          rider('Anna', 30, true, { items: { v: 2, capeS: 20 } }),
          rider('Ben', -12, true, { items: { v: 2, hit: { kind: 'puddle', s: 3 } } }),
        ],
      },
      localName: 'Cleo',
      powerUps: pu({ hit: { kind: 'hornets', by: 'Ben', remainingS: 5, durationS: 8 } }),
    } as LiveState;
    const html = withApp(
      state({ group: joined('guest'), live }),
      createElement(GroupTab, { onOpenSettings: noop, variant: 'ride' }),
    );
    expect(html).toContain('data-hidden-gaps="true"');
    expect(html).toMatch(/data-testid="group-rider-fx"[^>]*>Rain cape</);
    expect(html).toMatch(/data-testid="group-rider-fx"[^>]*>Mud puddle</);
    expect(html.match(/data-testid="group-rider-gap"[^>]*>\?</g)).toHaveLength(2);
    const clear = withApp(
      state({ group: joined('guest'), live: { ...live, powerUps: pu() } }),
      createElement(GroupTab, { onOpenSettings: noop, variant: 'ride' }),
    );
    expect(clear).toContain('+30 m');
    expect(clear).not.toContain('data-hidden-gaps');
  });
});

describe('summary and overlay (SSR)', () => {
  it('the summary splits items and hits; the recorded numbers stay apart', () => {
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
      rumble: { gainM: 38, lossM: -24 },
    };
    const html = withApp(
      state({ lastRide }),
      createElement(SummaryScreen, { onDone: noop, onAgain: noop }),
    );
    expect(html).toMatch(/data-testid="summary-rumble-gain"[^>]*>\+38 m from items</);
    expect(html).toMatch(/data-testid="summary-rumble-loss"[^>]*>−24 m from hits</);
    expect(html).toContain(`in your race position (${RUMBLE_NAME})`);
    expect(html).not.toContain('data-testid="summary-powerups"');
    expect(html).toMatch(/data-testid="summary-distance".*?>15.42</);
  });

  it('the overlay: the hit, the two slots with their keys, protection, a puddle ahead; the mode over the group; "?" under hornets', () => {
    const live: LiveState = {
      ride,
      devices: { trainer: { name: 'T', state: 'connected' }, heartRate: null, controller: null },
      group: { roomCode: 'X', mode: 'rumble', riders: [rider('Anna', 25)] },
      localName: 'Me',
      powerUps: pu({
        slots: ['bottle', 'cape'],
        slotNotes: [null, null],
        hit: { kind: 'bottle', by: 'Anna', remainingS: 4.2, durationS: 10 },
        lossM: -6,
      }),
    };
    const html = renderToString(
      createElement(OverlayView, { live, settings: DEFAULT_SETTINGS.overlay, editMode: false }),
    );
    expect(html).toMatch(/data-testid="overlay-powerup-hit"[^>]*data-kind="bottle"/);
    expect(html).toContain('ov-powerup--attack');
    expect(html).toMatch(/class="ov-pu-text ov-text">Water bottle from Anna</);
    expect(html).toMatch(/class="ov-pu-text ov-text">L Water bottle · R Rain cape</);
    expect(html).toMatch(/class="ov-pu-detail ov-text">P \/ L</);
    expect(html).toMatch(/data-testid="overlay-group-mode"[^>]*>Freilauf Rumble</);
    // Text stays opaque and outlined; only the backdrop layer fades.
    expect(html).toMatch(/overlay-powerup-hit[\s\S]*?class="ov-backdrop"/);
    expect(
      rumblePills(
        pu({ slots: [null, null], protection: { remainingS: 9, durationS: 15 }, lossM: -12 }),
      ).map((p) => p.text),
    ).toEqual(['L – · R –', 'Protected · 9 s']);
    expect(
      rumblePills(
        pu({
          slots: ['cape', null],
          cape: { remainingS: 50, durationS: 60 },
          puddles: [{ id: 'p', aheadM: 33, own: false, by: 'Ben' }],
        }),
      ).map((p) => p.text),
    ).toEqual(['L Rain cape · R –', 'Mud puddle ahead · 33 m', 'Rain cape · 50 s']);
    const stung = {
      ...live,
      powerUps: pu({ hit: { kind: 'hornets', by: 'Anna', remainingS: 4, durationS: 8 } }),
    };
    expect(groupRows(stung).find((r) => !r.local)?.gapText).toBe('?');
    expect(groupRows(live).find((r) => !r.local)?.gapText).toBe('+25 m');
    const stungHtml = renderToString(
      createElement(OverlayView, {
        live: stung,
        settings: DEFAULT_SETTINGS.overlay,
        editMode: false,
      }),
    );
    expect(stungHtml).toContain('Hornets from Anna');
    expect(stungHtml).toContain('gaps hidden');
  });
});

describe('Rumble v3 items in the UI (ADR 0009)', () => {
  it('slots: the new items with their names; the mini tool marked as of no use without a flat', () => {
    const html = slots(
      pu({
        slots: ['tool', 'energyBar'],
        slotNotes: ['Only with a flat or chain off', null],
      }),
    );
    expect(html).toMatch(/data-testid="item-left"[^>]*data-kind="tool"[^>]*data-ready="false"/);
    expect(html).toContain('is-unusable');
    expect(html).toContain('Mini tool');
    expect(html).toContain('Only with a flat or chain off');
    expect(html).toMatch(
      /data-testid="item-right"[^>]*data-kind="energyBar"[^>]*data-ready="true"/,
    );
    expect(html).toContain('Energy bar');
    for (const [kind, name] of [
      ['tacks', 'Tacks'],
      ['chain', 'Dropped chain'],
      ['teamCar', 'Team car'],
      ['rough', 'Rough section'],
    ] as const) {
      expect(slots(pu({ slots: [kind, null] }))).toContain(name);
    }
  });

  it('a flat tyre, the repair with its ring, a dropped chain and rough road under the rider', () => {
    const flat = slots(pu({ hit: { kind: 'tacks', by: 'Ben', remainingS: 14, durationS: 20 } }));
    expect(flat).toContain('Flat tyre!');
    expect(flat).toContain('from Ben · 14 s');
    expect(flat).toMatch(/data-testid="item-slots"[^>]*data-hit="tacks"[^>]*data-repair=""/);
    const fixing = slots(
      pu({
        hit: {
          kind: 'tacks',
          by: 'Ben',
          remainingS: 2,
          durationS: 20,
          repair: { remainingS: 2, durationS: 3 },
        },
      }),
    );
    expect(fixing).toContain('data-testid="rumble-repair"');
    expect(fixing).toContain('Fixing the flat');
    expect(fixing).toContain('Mini tool · 2 s');
    expect(fixing).toContain('is-working');
    expect(fixing).not.toContain('data-testid="rumble-hit"');
    expect(hitTitle('chain')).toBe('Chain off!');
    const rough = slots(pu({ terrain: { variant: 'gravel', by: 'Ben' } }));
    expect(rough).toContain('data-testid="rumble-terrain"');
    expect(rough).toContain('Gravel track');
    expect(rough).toMatch(/data-terrain="gravel"/);
  });

  it('notices for the new items', () => {
    const inc = (kind: 'tacks' | 'chain', result: 'hit' | 'blocked' = 'hit') =>
      incomingText({ seq: 1, kind, by: 'Ben', result });
    expect(inc('tacks')).toBe('Flat tyre! You rode over Ben’s tacks');
    expect(inc('chain')).toBe('Chain off! Ben dropped your chain');
    expect(inc('tacks', 'blocked')).toBe('Your rain cape kept off Ben’s tacks');
    const out = (kind: 'tacks' | 'chain' | 'rough', result: 'sent' | 'hit', target = 'Cleo') =>
      outgoingText({ seq: 1, kind, target, result });
    expect(out('tacks', 'sent', '')).toBe('Tacks scattered behind you');
    expect(out('tacks', 'hit')).toBe('Cleo rode over your tacks · flat tyre');
    expect(out('chain', 'sent')).toBe('Dropped chain → Cleo');
    expect(out('chain', 'hit')).toBe('Your dropped chain got Cleo');
    expect(out('rough', 'sent', 'Cobbles')).toBe('Cobbles laid behind you');
    const cue = (
      type: 'repairing' | 'supplied' | 'ended' | 'activated',
      kind: 'tool' | 'teamCar' | 'tacks' | 'chain' | 'energyBar',
    ) =>
      itemCueText(
        pu({ supply: { seq: 1, kinds: ['tool', 'cape'] } }, { event: { seq: 2, type, kind } }),
      );
    expect(cue('repairing', 'tool')).toBe('Mini tool out · fixing it');
    expect(cue('supplied', 'teamCar')).toBe('Team car: Mini tool and Rain cape');
    expect(cue('ended', 'tacks')).toBe('Tyre fixed · back up to speed');
    expect(cue('ended', 'chain')).toBe('Chain back on');
    expect(cue('activated', 'energyBar')).toBe('Energy bar · fresh legs for 15 s');
  });

  it('what lies ahead: tacks, a rough section; others in the group panel', () => {
    expect(
      puddleAhead(
        rumble({ puddles: [{ id: 't', kind: 'tacks', aheadM: 24.6, own: false, by: 'Ben' }] }),
      ),
    ).toBe('Ben’s tacks ahead · 25 m');
    const rough = [
      { id: 'r', fromM: 80, toM: 230, variant: 'roots' as const, own: false, by: 'Ben' },
    ];
    expect(puddleAhead(rumble({ rough }))).toBe('Forest path ahead · 80 m');
    // Own sections are not announced; nor one the rider is already on.
    expect(puddleAhead(rumble({ rough: [{ ...rough[0]!, own: true }] }))).toBeNull();
    expect(fxTag({ v: 3, hit: { kind: 'tacks', s: 9 } })).toBe('Flat tyre');
    expect(fxTag({ v: 3, hit: { kind: 'tacks', s: 2 }, repairS: 2 })).toBe('Fixing a flat');
    expect(fxTag({ v: 3, hit: { kind: 'chain', s: 2 } })).toBe('Chain off');
  });

  it('the overlay during a flat, the repair, rough road and tacks ahead', () => {
    const texts = (c: Partial<RumbleLive>) => rumblePills(pu(c)).map((p) => p.text);
    expect(
      texts({
        slots: ['tool', null],
        hit: { kind: 'tacks', by: 'Ben', remainingS: 12, durationS: 20 },
      }),
    ).toEqual(['Flat tyre from Ben', 'L Mini tool · R –']);
    expect(
      texts({
        hit: {
          kind: 'chain',
          by: 'Ben',
          remainingS: 0.6,
          durationS: 6,
          repair: { remainingS: 0.6, durationS: 1 },
        },
      })[0],
    ).toBe('Chain going back on');
    expect(texts({ terrain: { variant: 'debris', by: 'Ben' } })).toEqual([
      'Branches and leaves',
      'L – · R –',
    ]);
    expect(
      texts({ puddles: [{ id: 't', kind: 'tacks', aheadM: 30, own: false, by: 'Ben' }] }),
    ).toEqual(['L – · R –', 'Tacks ahead · 30 m']);
    const live: LiveState = {
      ride,
      devices: { trainer: { name: 'T', state: 'connected' }, heartRate: null, controller: null },
      group: { roomCode: 'X', mode: 'rumble', riders: [rider('Ben', 25)] },
      localName: 'Me',
      powerUps: pu({ hit: { kind: 'tacks', by: 'Ben', remainingS: 12, durationS: 20 }, lossM: -9 }),
    };
    const html = renderToString(
      createElement(OverlayView, { live, settings: DEFAULT_SETTINGS.overlay, editMode: false }),
    );
    expect(html).toMatch(/data-testid="overlay-powerup-hit"[^>]*data-kind="tacks"/);
    expect(html).toContain('Flat tyre from Ben');
  });
});
