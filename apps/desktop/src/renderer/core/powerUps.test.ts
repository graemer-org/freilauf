import { DEFAULT_BIKE, stepBike } from '@freilauf/sim';
import { describe, expect, it } from 'vitest';
import type { PowerUpBlock, PowerUpKind } from '../../shared/powerUps';
import {
  DEFAULT_POWER_UP_CONFIG,
  POWER_UP_DEFINITIONS,
  PowerUpEngine,
  type PowerUpConfig,
  type PowerUpTick,
  freeRideSpots,
  kindFor,
  modifiedBike,
  powerUpConfig,
  powerUpSeed,
  routeSpots,
} from './powerUps';

const BIKE = { ...DEFAULT_BIKE, totalMassKg: 83 };

/**
 * Drives an engine like the controller does: the "real" bike is integrated with stepBike, the
 * engine gets the recorded distance and speed and must never change them.
 */
class Ride {
  elapsedS = 0;
  distanceM = 0;
  speedMps = 0;
  routeM: number | null;
  powerW = 200;
  gradePercent = 0;
  blocked: PowerUpBlock | null = null;
  challenges = true;
  state: PowerUpTick['state'] = 'riding';
  readonly engine: PowerUpEngine;
  readonly lengthM: number;
  readonly loop: boolean;
  /** Recent powers for a 3 s average. */
  #recent: number[] = [];

  constructor(
    engine: PowerUpEngine,
    opts: { routeStartM?: number | null; lengthM?: number; loop?: boolean } = {},
  ) {
    this.engine = engine;
    this.routeM = opts.routeStartM ?? null;
    this.lengthM = opts.lengthM ?? 0;
    this.loop = opts.loop ?? false;
  }

  tick(dt = 0.25) {
    if (this.state === 'riding') {
      const step = stepBike(this.speedMps, this.powerW, this.gradePercent, BIKE, dt);
      this.speedMps = step.speedMps;
      this.distanceM += step.distanceM;
      this.elapsedS += dt;
      if (this.routeM !== null) {
        this.routeM += step.distanceM;
        if (this.loop && this.routeM >= this.lengthM) this.routeM -= this.lengthM;
      }
    }
    this.#recent.push(this.powerW);
    if (this.#recent.length > 12) this.#recent.shift();
    const power3sW = this.#recent.reduce((a, b) => a + b, 0) / this.#recent.length;
    return this.engine.update({
      state: this.state,
      elapsedS: this.elapsedS,
      distanceM: this.distanceM,
      routeM: this.routeM,
      speedMps: this.speedMps,
      powerW: this.powerW,
      power3sW,
      gradePercent: this.gradePercent,
      brake: 0,
      bike: BIKE,
      ftpW: 250,
      blocked: this.blocked,
      challenges: this.challenges,
    });
  }

  ride(seconds: number) {
    const events = [];
    for (let i = 0; i < seconds * 4; i++) events.push(...this.tick());
    return events;
  }

  rideUntil(pred: () => boolean, maxS = 3600) {
    for (let i = 0; i < maxS * 4 && !pred(); i++) this.tick();
    return pred();
  }
}

const cfg = (over: Partial<PowerUpConfig> = {}): PowerUpConfig => ({
  ...DEFAULT_POWER_UP_CONFIG,
  ...over,
});

describe('pick-up schedule', () => {
  it('is deterministic per seed and every 2–4 km', () => {
    const a = routeSpots('route:builtin-rolling', 20_000, false, DEFAULT_POWER_UP_CONFIG.spacing);
    const b = routeSpots('route:builtin-rolling', 20_000, false, DEFAULT_POWER_UP_CONFIG.spacing);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(4);
    let prev = 0;
    for (const s of a) {
      expect(s - prev).toBeGreaterThanOrEqual(1999);
      expect(s - prev).toBeLessThanOrEqual(4001);
      prev = s;
    }
    expect(routeSpots('route:other', 20_000, false, DEFAULT_POWER_UP_CONFIG.spacing)).not.toEqual(
      a,
    );
    const free = freeRideSpots('ride:x', 10, DEFAULT_POWER_UP_CONFIG.spacing);
    expect(free).toEqual(freeRideSpots('ride:x', 10, DEFAULT_POWER_UP_CONFIG.spacing));
    expect(free).not.toEqual(freeRideSpots('ride:y', 10, DEFAULT_POWER_UP_CONFIG.spacing));
  });

  it('keeps a loop clear of the finish line and a one-way route inside its length', () => {
    const loop = routeSpots('route:l', 9000, true, { minM: 2000, maxM: 4000 });
    for (const s of loop) expect(s).toBeLessThan(9000 - 1000);
    const oneWay = routeSpots('route:l', 9000, false, { minM: 2000, maxM: 4000 });
    for (const s of oneWay) expect(s).toBeLessThan(9000);
  });

  it('places spots at fixed route positions: two riders from different starts meet the same ones', () => {
    const config = cfg({ spacing: { minM: 300, maxM: 500 } });
    const seed = powerUpSeed('my-route', 'ride-a');
    expect(powerUpSeed('my-route', 'ride-b')).toBe(seed);
    const track = { id: 'my-route', lengthM: 5000, loop: true };
    const a = new PowerUpEngine({ seed, track, config });
    const b = new PowerUpEngine({ seed: powerUpSeed('my-route', 'ride-b'), track, config });
    expect(a.spots).toEqual(b.spots);
    // Rider A starts at 0, rider B at 2 km: both pick up at the first spot after their start.
    const ra = new Ride(a, { routeStartM: 0, lengthM: 5000, loop: true });
    const rb = new Ride(b, { routeStartM: 2000, lengthM: 5000, loop: true });
    expect(ra.rideUntil(() => a.hand.length > 0)).toBe(true);
    expect(rb.rideUntil(() => b.hand.length > 0)).toBe(true);
    const firstA = a.spots[0]!;
    const firstB = a.spots.find((s) => s > 2000)!;
    expect(ra.routeM!).toBeGreaterThanOrEqual(firstA);
    expect(ra.routeM! - firstA).toBeLessThan(5);
    expect(rb.routeM! - firstB).toBeLessThan(5);
    expect(a.hand[0]).toBe(kindFor(seed, 0));
    expect(b.hand[0]).toBe(kindFor(seed, a.spots.indexOf(firstB)));
  });

  it('reports the spots ahead and none while blocked', () => {
    const e = new PowerUpEngine({
      seed: 'ride:t',
      config: cfg({ spacing: { minM: 200, maxM: 200 } }),
    });
    const r = new Ride(e);
    r.tick();
    expect(e.toLive().upcoming[0]).toBeCloseTo(200 - r.distanceM, 0);
    r.blocked = 'erg';
    r.tick();
    expect(e.toLive().upcoming).toEqual([]);
  });

  it('crosses a loop finish line and ignores a jump', () => {
    const track = { id: 'loop', lengthM: 1000, loop: true };
    const e = new PowerUpEngine({
      seed: 'route:loop',
      track,
      config: cfg({ spacing: { minM: 100, maxM: 100 } }),
    });
    expect(e.spots[0]).toBe(100);
    const r = new Ride(e, { routeStartM: 960, lengthM: 1000, loop: true });
    r.tick();
    // Jump from ~960 to 150 in one tick: not riding through 100.
    r.routeM = 150;
    r.tick();
    expect(e.hand.length).toBe(0);
  });
});

describe('the hand', () => {
  it('holds one power-up; a second pick-up is skipped', () => {
    const e = new PowerUpEngine({
      seed: 'ride:h',
      config: cfg({ spacing: { minM: 50, maxM: 50 } }),
    });
    const r = new Ride(e);
    const events = r.ride(40);
    expect(events.filter((x) => x.type === 'picked')).toHaveLength(1);
    expect(events.some((x) => x.type === 'skipped')).toBe(true);
    expect(e.hand).toHaveLength(1);
    expect(e.toLive().held).toBe(e.hand[0]);
  });

  it('does not pick up in ERG or an FTP test, and a held card stays', () => {
    const e = new PowerUpEngine({
      seed: 'ride:erg',
      config: cfg({ spacing: { minM: 50, maxM: 50 } }),
    });
    const r = new Ride(e);
    r.blocked = 'erg';
    r.ride(30);
    expect(e.hand).toHaveLength(0);
    r.blocked = null;
    r.ride(15);
    expect(e.hand).toHaveLength(1);
    r.blocked = 'ftpTest';
    r.ride(5);
    expect(e.hand).toHaveLength(1);
    expect(e.activate()).toBe(false);
    expect(e.hand).toHaveLength(1);
  });
});

/** Rides to steady state, then uses `kind` and returns the race offset gained. */
function gainOf(kind: PowerUpKind, setup: (r: Ride) => void = () => {}) {
  const e = new PowerUpEngine({ seed: 'ride:g' });
  const r = new Ride(e);
  setup(r);
  r.ride(60);
  e.grant(kind);
  const before = { distance: r.distanceM, offset: e.raceOffsetM };
  expect(e.activate()).toBe(true);
  const events: string[] = [];
  let activeS = 0;
  for (let i = 0; i < 4 * 240; i++) {
    for (const ev of r.tick()) events.push(ev.type);
    if (e.toLive().effect?.phase === 'active') activeS += 0.25;
  }
  return { e, r, before, events, activeS, gained: e.raceOffsetM - before.offset };
}

describe('effects', () => {
  it('Tailwind: 15 s, 40 % less drag', () => {
    expect(POWER_UP_DEFINITIONS.tailwind.durationS).toBe(15);
    expect(POWER_UP_DEFINITIONS.tailwind.modifiers({ gradePercent: 0, speedMps: 9 })).toEqual({
      dragFactor: 0.6,
      massFactor: 1,
      rollingFactor: 1,
      powerFactor: 1,
    });
    const g = gainOf('tailwind');
    expect(g.activeS).toBeCloseTo(15, 0);
    // A few tens of metres, not a different race.
    expect(g.gained).toBeGreaterThan(15);
    expect(g.gained).toBeLessThan(80);
  });

  it('Slipstream: 30 s, 25 % less drag', () => {
    const def = POWER_UP_DEFINITIONS.slipstream;
    expect(def.durationS).toBe(30);
    expect(def.modifiers({ gradePercent: 0, speedMps: 9 }).dragFactor).toBe(0.75);
    const g = gainOf('slipstream');
    expect(g.activeS).toBeCloseTo(30, 0);
    expect(g.gained).toBeGreaterThan(15);
    expect(g.gained).toBeLessThan(100);
  });

  it('Light load: 25 s, 12 % less mass uphill only', () => {
    const def = POWER_UP_DEFINITIONS.lightLoad;
    expect(def.durationS).toBe(25);
    expect(def.modifiers({ gradePercent: 6, speedMps: 4 }).massFactor).toBe(0.88);
    expect(def.modifiers({ gradePercent: 0, speedMps: 9 }).massFactor).toBe(1);
    expect(def.modifiers({ gradePercent: -5, speedMps: 15 }).massFactor).toBe(1);
    const climb = gainOf('lightLoad', (r) => (r.gradePercent = 6));
    expect(climb.activeS).toBeCloseTo(25, 0);
    expect(climb.gained).toBeGreaterThan(5);
    expect(gainOf('lightLoad').gained).toBe(0);
  });

  it('Downhill momentum: armed until the next descent, then 20 s', () => {
    const def = POWER_UP_DEFINITIONS.downhill;
    expect(def.durationS).toBe(20);
    expect(def.armedS).toBe(180);
    const e = new PowerUpEngine({ seed: 'ride:d' });
    const r = new Ride(e);
    r.ride(30);
    e.grant('downhill');
    expect(e.activate()).toBe(true);
    r.ride(30);
    expect(e.toLive().effect).toMatchObject({ kind: 'downhill', phase: 'armed' });
    expect(e.raceOffsetM).toBe(0);
    // A descent starts it.
    r.gradePercent = -4;
    const events = r.ride(1).map((x) => x.type);
    expect(events).toContain('started');
    expect(e.toLive().effect).toMatchObject({ phase: 'active', durationS: 20 });
    r.ride(25);
    expect(e.toLive().effect).toBeNull();
    expect(e.raceOffsetM).toBeGreaterThan(10);
  });

  it('Downhill momentum expires unused after 3 min without a descent', () => {
    const e = new PowerUpEngine({ seed: 'ride:d2' });
    const r = new Ride(e);
    r.ride(5);
    e.grant('downhill');
    e.activate();
    const events = r.ride(185).map((x) => x.type);
    expect(events).toContain('expired');
    expect(e.toLive().effect).toBeNull();
    expect(e.raceOffsetM).toBe(0);
  });

  it('only one effect at a time; an ERG step ends an active effect', () => {
    const e = new PowerUpEngine({ seed: 'ride:one' });
    const r = new Ride(e);
    r.ride(10);
    e.grant('tailwind');
    e.activate();
    e.grant('slipstream');
    expect(e.canActivate).toBe(false);
    expect(e.activate()).toBe(false);
    r.blocked = 'erg';
    expect(r.ride(1).map((x) => x.type)).toContain('ended');
    expect(e.toLive().effect).toBeNull();
  });
});

describe('race offset vs. recorded physics', () => {
  it('never touches the recorded distance or speed', () => {
    const plain = new Ride(new PowerUpEngine({ seed: 'ride:p' }));
    const boosted = new Ride(new PowerUpEngine({ seed: 'ride:p' }));
    plain.ride(30);
    boosted.ride(30);
    boosted.engine.grant('tailwind');
    boosted.engine.activate();
    plain.ride(120);
    boosted.ride(120);
    // Same physics, to the bit; only the race offset differs.
    expect(boosted.distanceM).toBe(plain.distanceM);
    expect(boosted.speedMps).toBe(plain.speedMps);
    expect(plain.engine.raceOffsetM).toBe(0);
    expect(boosted.engine.raceOffsetM).toBeGreaterThan(10);
  });

  it('the gain bleeds off after the effect and stops growing', () => {
    const g = gainOf('tailwind');
    const after = g.e.raceOffsetM;
    g.r.ride(120);
    expect(g.e.raceOffsetM).toBe(after);
    expect(g.e.raceOffsetM).toBeGreaterThan(0);
  });

  it('shadow bike uses the modifiers only', () => {
    expect(
      modifiedBike(BIKE, { dragFactor: 0.5, massFactor: 0.9, rollingFactor: 0.5, powerFactor: 1 }),
    ).toEqual({
      ...BIKE,
      cdaM2: BIKE.cdaM2 * 0.5,
      totalMassKg: BIKE.totalMassKg * 0.9,
      crr: BIKE.crr * 0.5,
    });
  });
});

describe('effort challenges', () => {
  /** No pick-up spots on the way: a card from one would rule out the offers. */
  const quiet = (challenge = {}) => powerUpConfig({ spacingM: [99_000, 100_000], challenge });
  /** 6 min hard, then easy: a clear drop after 9 min. */
  function declining(opts: { challenges?: boolean } = {}) {
    const e = new PowerUpEngine({ seed: 'ride:c', config: quiet() });
    const r = new Ride(e);
    if (opts.challenges === false) r.challenges = false;
    r.powerW = 220;
    r.ride(360);
    r.powerW = 170;
    return { e, r };
  }

  it('offers a hold when the power has clearly dropped, with an achievable target', () => {
    const { e, r } = declining();
    expect(r.rideUntil(() => e.toLive().challenge !== null, 300)).toBe(true);
    const ch = e.toLive().challenge!;
    expect(ch.phase).toBe('offered');
    // ~115 % of the recent 3-min average, a multiple of 5 W.
    expect(ch.targetW % 5).toBe(0);
    expect(ch.targetW).toBeGreaterThanOrEqual(190);
    expect(ch.targetW).toBeLessThanOrEqual(225);
    expect(ch.holdS).toBe(30);
    // The 3-min window holds 170 W against a baseline of ≥ 200 W.
    const w = e.windows()!;
    expect(w.recentW).toBeLessThanOrEqual(0.88 * w.baselineW);
  });

  it('holding the target for 30 s grants a power-up', () => {
    const { e, r } = declining();
    r.rideUntil(() => e.toLive().challenge !== null, 300);
    r.powerW = e.toLive().challenge!.targetW + 10;
    const events = r.ride(40).map((x) => x.type);
    expect(events).toContain('challenge-won');
    expect(e.hand).toHaveLength(1);
    expect(e.toLive().challenge).toBeNull();
  });

  it('failing or ignoring it does nothing; then no offer for 10 min', () => {
    const { e, r } = declining();
    r.rideUntil(() => e.toLive().challenge !== null, 300);
    const offeredAt = r.elapsedS;
    // Ignore: the offer lapses after 20 s.
    const events = r.ride(25).map((x) => x.type);
    expect(events).toContain('challenge-ended');
    expect(e.hand).toHaveLength(0);
    // Still declining, but within the cooldown nothing is offered.
    r.powerW = 140;
    const until = offeredAt + 590 - r.elapsedS;
    expect(r.ride(until).some((x) => x.type === 'challenge-offered')).toBe(false);
  });

  it('a hold given up fails after the grace time', () => {
    const { e, r } = declining();
    r.rideUntil(() => e.toLive().challenge !== null, 300);
    r.powerW = e.toLive().challenge!.targetW + 20;
    r.ride(10);
    expect(e.toLive().challenge?.phase).toBe('holding');
    r.powerW = 100;
    expect(r.ride(8).map((x) => x.type)).toContain('challenge-failed');
    expect(e.hand).toHaveLength(0);
  });

  it('can be dismissed', () => {
    const { e, r } = declining();
    r.rideUntil(() => e.toLive().challenge !== null, 300);
    expect(e.dismissChallenge()).toBe(true);
    expect(e.toLive().challenge).toBeNull();
  });

  it('is not offered in the first minutes, in ERG, on a descent, when off, or while holding', () => {
    // First minutes: a drop at 3 min is not enough data.
    {
      const e = new PowerUpEngine({ seed: 'ride:early', config: quiet() });
      const r = new Ride(e);
      r.powerW = 250;
      r.ride(120);
      r.powerW = 120;
      expect(r.ride(170).some((x) => x.type === 'challenge-offered')).toBe(false);
    }
    // Not before notBeforeS even with short windows.
    {
      const config = quiet({ recentS: 10, baselineS: 10 });
      const e = new PowerUpEngine({ seed: 'ride:early2', config });
      const r = new Ride(e);
      // A clear drop at 100 s: too early.
      r.powerW = 250;
      r.ride(100);
      r.powerW = 120;
      expect(r.ride(20).some((x) => x.type === 'challenge-offered')).toBe(false);
      r.powerW = 250;
      expect(r.ride(175).some((x) => x.type === 'challenge-offered')).toBe(false);
      // The same drop just before 5 min: offered once 5 min are up.
      r.powerW = 120;
      expect(r.ride(15).some((x) => x.type === 'challenge-offered')).toBe(true);
    }
    // ERG: blocked now, and ERG seconds in the windows.
    {
      const { e, r } = declining();
      r.blocked = 'erg';
      expect(r.ride(120).some((x) => x.type === 'challenge-offered')).toBe(false);
      r.blocked = null;
      expect(r.ride(60).some((x) => x.type === 'challenge-offered')).toBe(false);
      expect(e.toLive().challenge).toBeNull();
    }
    // Descent.
    {
      const { r } = declining();
      r.gradePercent = -4;
      expect(r.ride(200).some((x) => x.type === 'challenge-offered')).toBe(false);
    }
    // Switched off.
    {
      const { r } = declining({ challenges: false });
      expect(r.ride(200).some((x) => x.type === 'challenge-offered')).toBe(false);
    }
    // Holding a power-up.
    {
      const { e, r } = declining();
      e.grant('tailwind');
      expect(r.ride(200).some((x) => x.type === 'challenge-offered')).toBe(false);
    }
    // Steady effort: no drop, no offer.
    {
      const e = new PowerUpEngine({ seed: 'ride:steady', config: quiet() });
      const r = new Ride(e);
      r.powerW = 200;
      expect(r.ride(900).some((x) => x.type === 'challenge-offered')).toBe(false);
    }
  });

  it('caps the target at 105 % of FTP', () => {
    const e = new PowerUpEngine({ seed: 'ride:cap', config: quiet() });
    const r = new Ride(e);
    r.powerW = 320;
    r.ride(360);
    r.powerW = 250;
    r.rideUntil(() => e.toLive().challenge !== null, 300);
    // FTP 250: cap 262 W, but never below 105 % of the recent average.
    const ch = e.toLive().challenge!;
    expect(ch.targetW).toBeLessThanOrEqual(Math.ceil((1.05 * 280) / 5) * 5);
  });
});

describe('tuning', () => {
  it('accepts sane overrides and ignores the rest', () => {
    const c = powerUpConfig({ spacingM: [60, 90], challenge: { holdS: 8, bogus: 1, offerS: 'x' } });
    expect(c.spacing).toEqual({ minM: 60, maxM: 90 });
    expect(c.challenge.holdS).toBe(8);
    expect(c.challenge.offerS).toBe(20);
    expect(powerUpConfig({ spacingM: [5, 2] }).spacing).toEqual(DEFAULT_POWER_UP_CONFIG.spacing);
    expect(powerUpConfig('nonsense')).toEqual(DEFAULT_POWER_UP_CONFIG);
    expect(powerUpConfig({ pool: ['slipstream', 'bogus'] }).pool).toEqual(['slipstream']);
    expect(powerUpConfig({ pool: ['bogus'] }).pool).toEqual(DEFAULT_POWER_UP_CONFIG.pool);
  });
});

describe('serialisable state', () => {
  it('round-trips through JSON', () => {
    const e = new PowerUpEngine({ seed: 'ride:s' });
    const r = new Ride(e);
    r.ride(5);
    e.grant('slipstream');
    const live = e.toLive();
    expect(JSON.parse(JSON.stringify(live))).toEqual(live);
    expect(live).toMatchObject({ held: 'slipstream', hand: ['slipstream'], capacity: 1 });
  });
});
