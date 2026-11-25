/** The power-up engine in a Card Race (docs/card-race.md, ADR 0007). */
import { DEFAULT_BIKE, stepBike } from '@freilauf/sim';
import { describe, expect, it } from 'vitest';
import type { PowerUpBlock, PowerUpKind } from '../../shared/powerUps';
import { CARD_KINDS, POWER_UP_KINDS } from '../../shared/powerUps';
import {
  CARD_RACE_POOL,
  DEFAULT_POWER_UP_CONFIG,
  POWER_UP_DEFINITIONS,
  PROTECTION_S,
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

function cardRace(over: Partial<PowerUpConfig> = {}, seed = 'ride:cr') {
  const e = new PowerUpEngine({ seed, config: cfg(over), mode: 'cardRace' });
  return { e, r: new Ride(e) };
}

describe('Card Race: the hand of two', () => {
  it('fills left, then right; a third card is skipped', () => {
    const { e, r } = cardRace({ spacing: { minM: 60, maxM: 60 } });
    const events = r.ride(40); // over 200 m: at least three spots
    const picked = events.filter((x) => x.type === 'picked');
    expect(picked).toHaveLength(2);
    expect(events.some((x) => x.type === 'skipped')).toBe(true);
    expect(e.slots).toEqual([picked[0]!.kind, picked[1]!.kind]);
    const live = e.toLive();
    expect(live.capacity).toBe(2);
    expect(live.cards?.slots).toEqual(e.slots);
  });

  it('left button plays the left card, right the right one; slots stay put', () => {
    const { e, r } = cardRace();
    r.ride(5);
    e.grant('tailwind');
    e.grant('shield');
    expect(e.slots).toEqual(['tailwind', 'shield']);
    // Right card first: the shield goes up, the tailwind stays on the left.
    expect(e.activate(1)).toBe(true);
    expect(e.slots).toEqual(['tailwind', null]);
    expect(e.toLive().cards?.shield?.remainingS).toBeCloseTo(60, 0);
    // A new card fills the empty right slot, not the left.
    e.grant('slipstream');
    expect(e.slots).toEqual(['tailwind', 'slipstream']);
    expect(e.activate(0)).toBe(true);
    expect(e.slots).toEqual([null, 'slipstream']);
    expect(e.toLive().effect?.kind).toBe('tailwind');
    // One boost at a time: the second waits, with a note.
    expect(e.activate(1)).toBe(false);
    expect(e.playNote(1)).toBe('After your boost');
    expect(e.toLive().cards?.slotNotes).toEqual([null, 'After your boost']);
  });

  it('an attack card is not used up by activate(); spendCard takes it, returnCard puts it back', () => {
    const { e, r } = cardRace();
    r.ride(5);
    e.grant('headwind');
    expect(e.activate(0)).toBe(false);
    expect(e.slots).toEqual(['headwind', null]);
    expect(e.spendCard(0)).toBe('headwind');
    expect(e.slots).toEqual([null, null]);
    expect(e.toLive().used).toBe(1);
    expect(e.returnCard('headwind')).toBe(true);
    expect(e.slots).toEqual(['headwind', null]);
    expect(e.toLive().used).toBe(0);
    expect(e.spendCard(1)).toBeNull();
  });

  it('pick-ups and challenges draw from the Card Race pool, the same for everyone', () => {
    expect(new Set(CARD_RACE_POOL)).toEqual(new Set(CARD_KINDS));
    const kinds = Array.from({ length: 400 }, (_, i) => kindFor('route:r', i, CARD_RACE_POOL));
    const share = (k: PowerUpKind) => kinds.filter((x) => x === k).length / kinds.length;
    expect(share('fog')).toBeLessThan(share('headwind'));
    expect(POWER_UP_KINDS.reduce((a, k) => a + share(k), 0)).toBeGreaterThan(0.5);
    expect(powerUpConfig({ cardPool: ['headwind', 'bogus'] }).cardPool).toEqual(['headwind']);
  });
});

/** A steady 200 W ride for a minute, then `attack` received; returns what happened. */
function attacked(kind: PowerUpKind, setup: (r: Ride, e: PowerUpEngine) => void = () => {}) {
  const { e, r } = cardRace();
  setup(r, e);
  r.ride(60);
  const result = e.receiveAttack(kind, 'Ben');
  let attackS = 0;
  for (let i = 0; i < 4 * 120; i++) {
    r.tick();
    if (e.toLive().cards?.attack) attackS += 0.25;
  }
  return { e, r, result, attackS };
}

describe('Card Race: attacks', () => {
  it('Headwind: 10 s of 60 % more drag; the target loses race position, never recorded distance', () => {
    const def = POWER_UP_DEFINITIONS.headwind;
    expect(def).toMatchObject({ durationS: 10, target: 'ahead', role: 'attack' });
    expect(def.modifiers({ gradePercent: 0, speedMps: 9 })).toEqual({
      dragFactor: 1.6,
      massFactor: 1,
      rollingFactor: 1,
    });
    const hit = attacked('headwind');
    expect(hit.result).toBe('hit');
    expect(hit.attackS).toBeCloseTo(10, 0);
    const live = hit.e.toLive();
    // Gentle: about 15 m at 200 W, never more than a Tailwind gains.
    expect(live.raceOffsetM).toBeLessThan(-8);
    expect(live.raceOffsetM).toBeGreaterThan(-30);
    expect(live.cards?.lossM).toBeCloseTo(live.raceOffsetM, 1);
    expect(live.cards?.gainM).toBe(0);
    expect(live.cards?.incoming).toMatchObject({ kind: 'headwind', by: 'Ben', result: 'hit' });

    // The loss is exactly the shadow bike's: an independent integration agrees.
    let v = 0;
    let real = 0;
    let shadow = 0;
    let vs = 0;
    for (let i = 0; i < 4 * 180; i++) {
      const t = (i + 1) * 0.25;
      const a = stepBike(v, 200, 0, BIKE, 0.25);
      const hw = t > 60 && t < 70; // the effect acts in the ticks after 60 s, ends at 70 s
      const s =
        t <= 60
          ? a
          : stepBike(
              vs,
              200,
              0,
              hw ? modifiedBike(BIKE, def.modifiers({ gradePercent: 0, speedMps: v })) : BIKE,
              0.25,
            );
      v = a.speedMps;
      vs = s.speedMps;
      real += a.distanceM;
      shadow += s.distanceM;
    }
    expect(shadow - real).toBeCloseTo(live.raceOffsetM, 0);

    // The recorded ride is bit for bit the one without any attack.
    const calm = cardRace();
    calm.r.ride(180);
    expect(hit.r.trace).toEqual(calm.r.trace);
  });

  it('Fog: 12 s on the leader, no physics', () => {
    expect(POWER_UP_DEFINITIONS.fog).toMatchObject({
      durationS: 12,
      target: 'leader',
      role: 'attack',
    });
    const fog = attacked('fog');
    expect(fog.e.toLive().cards?.incoming).toMatchObject({ kind: 'fog', result: 'hit' });
    expect(fog.result).toBe('hit');
    expect(fog.attackS).toBeCloseTo(12, 0);
    expect(fog.e.raceOffsetM).toBe(0);
  });

  it('a raised Shield blocks the next attack and is used up; protection follows', () => {
    const { e, r } = cardRace();
    r.ride(5);
    e.grant('shield');
    expect(e.activate(0)).toBe(true);
    r.ride(20);
    expect(e.toLive().cards?.shield?.remainingS).toBeCloseTo(40, 0);
    expect(e.receiveAttack('headwind', 'Ben')).toBe('blocked');
    const live = e.toLive().cards!;
    expect(live.shield).toBeNull();
    expect(live.attack).toBeNull();
    expect(live.protection?.remainingS).toBeCloseTo(PROTECTION_S, 1);
    expect(live.incoming).toMatchObject({ kind: 'headwind', by: 'Ben', result: 'blocked' });
    r.ride(30);
    expect(e.raceOffsetM).toBe(0);
  });

  it('an unused Shield lowers after 60 s', () => {
    const { e, r } = cardRace();
    r.ride(1);
    e.grant('shield');
    e.activate(0);
    r.ride(61);
    expect(e.toLive().cards?.shield).toBeNull();
    expect(e.receiveAttack('headwind', 'Ben')).toBe('hit');
  });

  it('protection: no second hit during an attack and for 15 s after it', () => {
    const { e, r } = cardRace();
    r.ride(10);
    expect(e.receiveAttack('headwind', 'Ben')).toBe('hit');
    r.ride(5);
    expect(e.receiveAttack('fog', 'Cleo')).toBe('protected');
    r.ride(5.25); // the headwind is over
    const p = e.toLive().cards!;
    expect(p.attack).toBeNull();
    expect(p.protection?.durationS).toBe(PROTECTION_S);
    expect(p.protection?.remainingS).toBeGreaterThan(14);
    r.ride(14);
    expect(e.receiveAttack('headwind', 'Ben')).toBe('protected');
    expect(e.toLive().cards?.incoming).toMatchObject({ by: 'Ben', result: 'protected' });
    r.ride(1.5);
    expect(e.toLive().cards?.protection).toBeNull();
    expect(e.receiveAttack('headwind', 'Ben')).toBe('hit');
  });

  it('nothing lands while paused, in ERG or in an FTP test', () => {
    for (const set of [
      (r: Ride) => (r.state = 'paused'),
      (r: Ride) => (r.blocked = 'erg'),
      (r: Ride) => (r.blocked = 'ftpTest'),
    ]) {
      const { e, r } = cardRace();
      r.ride(5);
      set(r);
      r.ride(1);
      expect(e.receiveAttack('headwind', 'Ben')).toBe('unavailable');
      expect(e.toLive().cards?.incoming).toBeNull();
    }
  });

  it('an ERG step ends an attack in progress', () => {
    const { e, r } = cardRace();
    r.ride(5);
    e.receiveAttack('headwind', 'Ben');
    r.ride(2);
    r.blocked = 'erg';
    r.ride(1);
    expect(e.toLive().cards?.attack).toBeNull();
  });

  it('own boosts and attacks add up separately: + from cards, − from attacks', () => {
    const { e, r } = cardRace();
    r.ride(60);
    e.grant('tailwind');
    e.activate(0);
    e.receiveAttack('headwind', 'Ben');
    r.ride(120);
    const c = e.toLive().cards!;
    expect(c.gainM).toBeGreaterThan(10);
    expect(c.lossM).toBeLessThan(-5);
    expect(e.raceOffsetM).toBeCloseTo(c.gainM + c.lossM, 0);
  });
});

describe('normal mode is unchanged', () => {
  it('attacks do nothing, the offset never goes below 0, no Card Race state', () => {
    const e = new PowerUpEngine({ seed: 'ride:n' });
    const r = new Ride(e);
    r.ride(30);
    expect(e.receiveAttack('headwind', 'Ben')).toBe('unavailable');
    r.ride(30);
    expect(e.raceOffsetM).toBe(0);
    expect(e.toLive().cards).toBeUndefined();
    expect(e.toLive().capacity).toBe(1);
  });

  it('a normal engine gives the same live state whether Card Race code exists or not', () => {
    // Same ride, same pick-ups, same use: the normal engine never draws attack cards.
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

  it('switching a Card Race back to normal keeps one boost and drops the loss', () => {
    const { e, r } = cardRace();
    r.ride(30);
    e.grant('headwind');
    e.grant('slipstream');
    e.receiveAttack('headwind', 'Ben');
    r.ride(30);
    expect(e.raceOffsetM).toBeLessThan(0);
    e.setMode('normal');
    expect(e.slots).toEqual(['slipstream']);
    expect(e.raceOffsetM).toBe(0);
    expect(e.toLive().cards).toBeUndefined();
    e.setMode('cardRace');
    expect(e.slots).toEqual(['slipstream', null]);
  });
});
