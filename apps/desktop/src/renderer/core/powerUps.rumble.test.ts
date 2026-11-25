/** The power-up engine in Freilauf Rumble (docs/rumble.md, ADR 0008). */
import { DEFAULT_BIKE, stepBike } from '@freilauf/sim';
import { describe, expect, it } from 'vitest';
import type { PowerUpBlock, PowerUpKind } from '../../shared/powerUps';
import { POWER_UP_KINDS, RUMBLE_ITEM_KINDS, gapsHidden } from '../../shared/powerUps';
import {
  DEFAULT_POWER_UP_CONFIG,
  POWER_UP_DEFINITIONS,
  PROTECTION_S,
  RUMBLE_POOL,
  PowerUpEngine,
  type PowerUpConfig,
  type PowerUpTick,
  kindFor,
  modifiedBike,
  powerUpConfig,
} from './powerUps';

const BIKE = { ...DEFAULT_BIKE, totalMassKg: 83 };

/** Drives an engine like the controller does; the "real" bike never sees the engine. */
class Ride {
  elapsedS = 0;
  distanceM = 0;
  speedMps = 0;
  powerW = 200;
  gradePercent = 0;
  blocked: PowerUpBlock | null = null;
  state: PowerUpTick['state'] = 'riding';
  readonly engine: PowerUpEngine;
  /** Recorded speed and distance after every tick (for "byte-identical" comparisons). */
  readonly trace: number[] = [];

  constructor(engine: PowerUpEngine) {
    this.engine = engine;
  }

  tick(dt = 0.25) {
    if (this.state === 'riding') {
      const step = stepBike(this.speedMps, this.powerW, this.gradePercent, BIKE, dt);
      this.speedMps = step.speedMps;
      this.distanceM += step.distanceM;
      this.elapsedS += dt;
    }
    this.trace.push(this.speedMps, this.distanceM);
    return this.engine.update({
      state: this.state,
      elapsedS: this.elapsedS,
      distanceM: this.distanceM,
      routeM: null,
      speedMps: this.speedMps,
      powerW: this.powerW,
      power3sW: this.powerW,
      gradePercent: this.gradePercent,
      brake: 0,
      bike: BIKE,
      ftpW: 250,
      blocked: this.blocked,
      challenges: false,
    });
  }

  ride(seconds: number) {
    const events = [];
    for (let i = 0; i < seconds * 4; i++) events.push(...this.tick());
    return events;
  }
}

const cfg = (over: Partial<PowerUpConfig> = {}): PowerUpConfig => ({
  ...DEFAULT_POWER_UP_CONFIG,
  ...over,
});

function rumble(over: Partial<PowerUpConfig> = {}, seed = 'ride:rb') {
  const e = new PowerUpEngine({ seed, config: cfg(over), mode: 'rumble' });
  return { e, r: new Ride(e) };
}

describe('Rumble: two item slots', () => {
  it('fills left, then right; a third item is skipped', () => {
    const { e, r } = rumble({ spacing: { minM: 60, maxM: 60 } });
    const events = r.ride(40); // over 200 m: at least three feed bags
    const picked = events.filter((x) => x.type === 'picked');
    expect(picked).toHaveLength(2);
    expect(events.some((x) => x.type === 'skipped')).toBe(true);
    expect(e.slots).toEqual([picked[0]!.kind, picked[1]!.kind]);
    const live = e.toLive();
    expect(live.capacity).toBe(2);
    expect(live.rumble?.slots).toEqual(e.slots);
    expect(live.rumble?.puddles).toEqual([]);
  });

  it('left button uses the left item, right the right one; slots stay put', () => {
    const { e, r } = rumble();
    r.ride(5);
    e.grant('tailwind');
    e.grant('cape');
    expect(e.slots).toEqual(['tailwind', 'cape']);
    // Right item first: the cape goes on, the tailwind stays on the left.
    expect(e.activate(1)).toBe(true);
    expect(e.slots).toEqual(['tailwind', null]);
    expect(e.toLive().rumble?.cape?.remainingS).toBeCloseTo(60, 0);
    // A new item fills the empty right slot, not the left.
    e.grant('slipstream');
    expect(e.slots).toEqual(['tailwind', 'slipstream']);
    expect(e.activate(0)).toBe(true);
    expect(e.slots).toEqual([null, 'slipstream']);
    expect(e.toLive().effect?.kind).toBe('tailwind');
    // One boost at a time: the second waits, with a note.
    expect(e.activate(1)).toBe(false);
    expect(e.playNote(1)).toBe('After your boost');
    expect(e.toLive().rumble?.slotNotes).toEqual([null, 'After your boost']);
  });

  it('an attack item is not used by activate(); spendItem takes it, returnItem puts it back', () => {
    const { e, r } = rumble();
    r.ride(5);
    e.grant('bottle');
    e.grant('puddle');
    expect(e.activate(0)).toBe(false);
    expect(e.activate(1)).toBe(false);
    expect(e.spendItem(0)).toBe('bottle');
    expect(e.toLive().event).toMatchObject({ type: 'played', kind: 'bottle' });
    expect(e.spendItem(1)).toBe('puddle');
    expect(e.toLive().event).toMatchObject({ type: 'dropped', kind: 'puddle' });
    expect(e.slots).toEqual([null, null]);
    expect(e.toLive().used).toBe(2);
    expect(e.returnItem('bottle')).toBe(true);
    expect(e.slots).toEqual(['bottle', null]);
    expect(e.toLive().used).toBe(1);
    expect(e.spendItem(1)).toBeNull();
  });

  it('feed bags and challenges draw from the Rumble pool with fixed weights, the same for everyone', () => {
    expect(new Set(RUMBLE_POOL)).toEqual(new Set(RUMBLE_ITEM_KINDS));
    const weight = (k: PowerUpKind) => RUMBLE_POOL.filter((x) => x === k).length;
    // Boosts 2 each (8 of 15), water bottle 2, mud puddle 2, rain cape 2, hornets 1.
    expect(RUMBLE_POOL).toHaveLength(15);
    for (const k of POWER_UP_KINDS) expect(weight(k)).toBe(2);
    expect([weight('bottle'), weight('puddle'), weight('cape'), weight('hornets')]).toEqual([
      2, 2, 2, 1,
    ]);
    const kinds = Array.from({ length: 3000 }, (_, i) => kindFor('route:r', i, RUMBLE_POOL));
    const share = (k: PowerUpKind) => kinds.filter((x) => x === k).length / kinds.length;
    expect(share('hornets')).toBeCloseTo(1 / 15, 1);
    expect(share('bottle')).toBeCloseTo(2 / 15, 1);
    expect(POWER_UP_KINDS.reduce((a, k) => a + share(k), 0)).toBeCloseTo(8 / 15, 1);
    // Riders on the same route meet the same item at the same feed bag.
    expect(kindFor('route:r', 7, RUMBLE_POOL)).toBe(kindFor('route:r', 7, RUMBLE_POOL));
    expect(powerUpConfig({ itemPool: ['bottle', 'bogus'] }).itemPool).toEqual(['bottle']);
    expect(powerUpConfig({ itemPool: ['headwind'] }).itemPool).toEqual(RUMBLE_POOL);
  });
});

/** A steady 200 W ride for a minute, then a hit received; returns what happened. */
function hitBy(kind: PowerUpKind, setup: (r: Ride, e: PowerUpEngine) => void = () => {}) {
  const { e, r } = rumble();
  setup(r, e);
  r.ride(60);
  const result = e.receiveHit(kind, 'Ben');
  let hitS = 0;
  let hiddenS = 0;
  for (let i = 0; i < 4 * 120; i++) {
    r.tick();
    if (e.toLive().rumble?.hit) hitS += 0.25;
    if (gapsHidden(e.toLive())) hiddenS += 0.25;
  }
  return { e, r, result, hitS, hiddenS };
}

/** What a boost gains in the same minute-in ride (for "a hit costs about what a boost gains"). */
function boostGain(kind: PowerUpKind): number {
  const { e, r } = rumble();
  r.ride(60);
  e.grant(kind);
  e.activate(0);
  r.ride(120);
  return e.gainM;
}

describe('Rumble: what each item does', () => {
  const flat = { gradePercent: 0, speedMps: 9 };

  it.each([
    ['bottle', 10, 2, 'ahead'],
    ['puddle', 5, 3, 'behind'],
    ['hornets', 8, 2.2, 'leader'],
  ] as const)(
    '%s: %i s of %f× air resistance on whoever it hits; race position only, never the recording',
    (kind, durationS, drag, target) => {
      const def = POWER_UP_DEFINITIONS[kind];
      expect(def).toMatchObject({ durationS, target, role: 'attack' });
      expect(def.modifiers(flat)).toEqual({ dragFactor: drag, massFactor: 1, rollingFactor: 1 });
      const hit = hitBy(kind);
      expect(hit.result).toBe('hit');
      expect(hit.hitS).toBeCloseTo(durationS, 0);
      const live = hit.e.toLive();
      // About as much as a boost gains at 200 W on the flat (Tailwind ≈ 19 m, Slipstream ≈ 24 m).
      expect(live.raceOffsetM).toBeLessThan(-18);
      expect(live.raceOffsetM).toBeGreaterThan(-32);
      const boosts = (boostGain('tailwind') + boostGain('slipstream')) / 2;
      expect(-live.raceOffsetM / boosts).toBeGreaterThan(0.75);
      expect(-live.raceOffsetM / boosts).toBeLessThan(1.35);
      expect(live.rumble?.lossM).toBeCloseTo(live.raceOffsetM, 1);
      expect(live.rumble?.gainM).toBe(0);
      expect(live.rumble?.incoming).toMatchObject({ kind, by: 'Ben', result: 'hit' });
      // Hornets also hide the gaps on this rider's own screen, for as long as they buzz.
      expect(hit.hiddenS).toBeCloseTo(kind === 'hornets' ? durationS : 0, 0);
      // The recorded ride is bit for bit the one without any hit.
      const calm = rumble();
      calm.r.ride(180);
      expect(hit.r.trace).toEqual(calm.r.trace);
    },
  );

  it('the loss is exactly the shadow bike’s: an independent integration agrees (bottle)', () => {
    const def = POWER_UP_DEFINITIONS.bottle;
    const hit = hitBy('bottle');
    let v = 0;
    let real = 0;
    let shadow = 0;
    let vs = 0;
    for (let i = 0; i < 4 * 180; i++) {
      const t = (i + 1) * 0.25;
      const a = stepBike(v, 200, 0, BIKE, 0.25);
      const on = t > 60 && t < 70; // acts in the ticks after 60 s, ends at 70 s
      const s =
        t <= 60
          ? a
          : stepBike(vs, 200, 0, on ? modifiedBike(BIKE, def.modifiers(flat)) : BIKE, 0.25);
      v = a.speedMps;
      vs = s.speedMps;
      real += a.distanceM;
      shadow += s.distanceM;
    }
    expect(shadow - real).toBeCloseTo(hit.e.raceOffsetM, 0);
  });

  it('the rain cape keeps off the next hit of any kind — bottle, puddle, hornets — and is used up', () => {
    for (const kind of ['bottle', 'puddle', 'hornets'] as const) {
      const { e, r } = rumble();
      r.ride(5);
      e.grant('cape');
      expect(e.activate(0)).toBe(true);
      r.ride(20);
      expect(e.toLive().rumble?.cape?.remainingS).toBeCloseTo(40, 0);
      expect(e.hitCheck()).toBeNull(); // a puddle would be claimed: the cape takes it
      expect(e.receiveHit(kind, 'Ben')).toBe('blocked');
      const live = e.toLive().rumble!;
      expect(live.cape).toBeNull();
      expect(live.hit).toBeNull();
      expect(live.protection?.remainingS).toBeCloseTo(PROTECTION_S, 1);
      expect(live.incoming).toMatchObject({ kind, by: 'Ben', result: 'blocked' });
      r.ride(30);
      expect(e.raceOffsetM).toBe(0);
    }
  });

  it('an unused rain cape comes off after 60 s; a second one waits while one is on', () => {
    const { e, r } = rumble();
    r.ride(1);
    e.grant('cape');
    e.grant('cape');
    e.activate(0);
    expect(e.playNote(1)).toBe('Cape is up');
    r.ride(61);
    expect(e.toLive().rumble?.cape).toBeNull();
    expect(e.receiveHit('bottle', 'Ben')).toBe('hit');
  });

  it('protection: no second hit while one slows the rider and for 15 s after it', () => {
    const { e, r } = rumble();
    r.ride(10);
    expect(e.receiveHit('bottle', 'Ben')).toBe('hit');
    r.ride(5);
    expect(e.hitCheck()).toBe('protected');
    expect(e.receiveHit('hornets', 'Cleo')).toBe('protected');
    expect(e.receiveHit('puddle', 'Cleo')).toBe('protected');
    r.ride(5.25); // the bottle is over
    const p = e.toLive().rumble!;
    expect(p.hit).toBeNull();
    expect(p.protection?.durationS).toBe(PROTECTION_S);
    expect(p.protection?.remainingS).toBeGreaterThan(14);
    r.ride(14);
    expect(e.receiveHit('bottle', 'Ben')).toBe('protected');
    expect(e.toLive().rumble?.incoming).toMatchObject({ by: 'Ben', result: 'protected' });
    r.ride(1.5);
    expect(e.toLive().rumble?.protection).toBeNull();
    expect(e.hitCheck()).toBeNull();
    expect(e.receiveHit('puddle', 'Ben')).toBe('hit');
  });

  it('nothing lands while paused, in ERG or in an FTP test; boosts are no hits', () => {
    for (const set of [
      (r: Ride) => (r.state = 'paused'),
      (r: Ride) => (r.blocked = 'erg'),
      (r: Ride) => (r.blocked = 'ftpTest'),
    ]) {
      const { e, r } = rumble();
      r.ride(5);
      set(r);
      r.ride(1);
      expect(e.hitCheck()).toBe('unavailable');
      expect(e.receiveHit('bottle', 'Ben')).toBe('unavailable');
      expect(e.receiveHit('puddle', 'Ben')).toBe('unavailable');
      expect(e.toLive().rumble?.incoming).toBeNull();
    }
    const { e, r } = rumble();
    r.ride(5);
    expect(e.receiveHit('tailwind', 'Ben')).toBe('unavailable');
    expect(e.receiveHit('cape', 'Ben')).toBe('unavailable');
  });

  it('an ERG step ends a hit in progress', () => {
    const { e, r } = rumble();
    r.ride(5);
    e.receiveHit('bottle', 'Ben');
    r.ride(2);
    r.blocked = 'erg';
    r.ride(1);
    expect(e.toLive().rumble?.hit).toBeNull();
  });

  it('own boosts and hits add up separately: + from items, − from hits', () => {
    const { e, r } = rumble();
    r.ride(60);
    e.grant('tailwind');
    e.activate(0);
    e.receiveHit('bottle', 'Ben');
    r.ride(120);
    const c = e.toLive().rumble!;
    expect(c.gainM).toBeGreaterThan(10);
    expect(c.lossM).toBeLessThan(-5);
    expect(e.raceOffsetM).toBeCloseTo(c.gainM + c.lossM, 0);
  });
});

describe('normal mode is unchanged', () => {
  it('hits do nothing, the offset never goes below 0, no Rumble state', () => {
    const e = new PowerUpEngine({ seed: 'ride:n' });
    const r = new Ride(e);
    r.ride(30);
    expect(e.receiveHit('bottle', 'Ben')).toBe('unavailable');
    expect(e.hitCheck()).toBe('unavailable');
    r.ride(30);
    expect(e.raceOffsetM).toBe(0);
    expect(e.toLive().rumble).toBeUndefined();
    expect(e.toLive().capacity).toBe(1);
  });

  it('a normal engine gives the same live state whether Rumble code exists or not', () => {
    // Same ride, same pick-ups, same use: the normal engine never draws Rumble items.
    const a = new PowerUpEngine({
      seed: 'ride:same',
      config: cfg({ spacing: { minM: 80, maxM: 80 } }),
    });
    const ra = new Ride(a);
    ra.ride(60);
    for (const k of a.hand) expect(POWER_UP_KINDS).toContain(k);
    a.activate();
    ra.ride(60);
    expect(Object.keys(a.toLive()).sort()).toEqual(
      [
        'blocked',
        'held',
        'hand',
        'capacity',
        'canActivate',
        'effect',
        'challenge',
        'upcoming',
        'raceOffsetM',
        'picked',
        'used',
        'event',
      ].sort(),
    );
  });

  it('switching a Rumble back to normal keeps one boost and drops the loss', () => {
    const { e, r } = rumble();
    r.ride(30);
    e.grant('bottle');
    e.grant('slipstream');
    e.receiveHit('bottle', 'Ben');
    r.ride(30);
    expect(e.raceOffsetM).toBeLessThan(0);
    e.setMode('normal');
    expect(e.slots).toEqual(['slipstream']);
    expect(e.raceOffsetM).toBe(0);
    expect(e.toLive().rumble).toBeUndefined();
    e.setMode('rumble');
    expect(e.slots).toEqual(['slipstream', null]);
  });
});
