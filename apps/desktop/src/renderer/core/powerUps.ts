/**
 * The power-up engine (docs/power-ups.md, docs/adr/0006-power-ups.md): pure and deterministic,
 * no timers and no DOM. The ride controller calls `update()` once per tick with the ride's
 * time, distance and power; everything else follows from that and from a seed.
 *
 * - **Pick-ups:** spots every `spacing` metres, drawn from a seeded generator — on a route at
 *   fixed route positions (seed = route id, so every rider on that route meets the same spots),
 *   in a free ride along the ridden distance (seed = ride id). Riding through a spot adds an item
 *   to the hand when there is room; otherwise it is skipped ("already holding").
 * - **Effort challenges:** when the power has clearly dropped (see `ChallengeRules`), a short
 *   hold is offered; holding it grants an item. Ignoring or failing it does nothing.
 * - **Effects** change only the *race position*: a shadow copy of the virtual bike is integrated
 *   with the effect's modifiers (less drag, less mass …) next to the real one, and the
 *   difference in distance is the race offset. The recorded ride (speed, distance, FIT, points,
 *   bests) never sees it; `stepBike` itself is unchanged.
 *
 * Extension points for a battle mode (ADR 0006): more kinds (POWER_UP_DEFINITIONS), a larger
 * hand (`capacity`), `activate(index)`, `grant()` from other sources, `applyEffect()` for
 * effects another rider sends, `target` on a definition, and `toLive()` as the wire format.
 *
 * **Freilauf Rumble** (docs/rumble.md, ADR 0008) uses them: `setMode('rumble')` gives two fixed
 * item slots (left/right button), a pool with attacks and a rain cape, `receiveHit()` for a hit
 * from another rider (a thrown bottle, hornets, a puddle ridden through; applied here, to this
 * rider only), a protection window after every hit, and a second shadow bike for hits, so the
 * race offset splits into a gain from own items (≥ 0) and a loss to hits (≤ 0). Only in a Rumble
 * can the offset be negative; a normal ride is exactly as before.
 */
import type { BikeParams } from '@freilauf/sim';
import { stepBike } from '@freilauf/sim';
import type {
  AttackResult,
  GroupMode,
  IncomingHitLive,
  OutgoingAttackLive,
  PowerUpBlock,
  PowerUpChallengeLive,
  PowerUpEffectLive,
  PowerUpEventLive,
  PowerUpEventType,
  PowerUpKind,
  PowerUpLive,
  RoughVariant,
  RumbleLive,
} from '../../shared/powerUps';
import { POWER_UP_KINDS, RUMBLE_ITEM_KINDS } from '../../shared/powerUps';

// ───────────── effects ─────────────

/** Factors applied to the shadow bike while an effect acts (1 = unchanged). */
export interface EffectModifiers {
  /** × CdA: air resistance. */
  dragFactor: number;
  /** × total mass: gravity on climbs, rolling resistance and inertia. */
  massFactor: number;
  /** × Crr: rolling resistance. */
  rollingFactor: number;
  /** × the rider's power as the shadow bike gets it (energy bar > 1, dropped chain 0). */
  powerFactor: number;
}

export const NO_MODIFIERS: Readonly<EffectModifiers> = Object.freeze({
  dragFactor: 1,
  massFactor: 1,
  rollingFactor: 1,
  powerFactor: 1,
});

/** Modifiers from the factors that differ from 1. */
function mods(m: Partial<EffectModifiers>): EffectModifiers {
  return { ...NO_MODIFIERS, ...m };
}

/** What an effect may look at to decide how strongly it acts (and, armed, whether to start). */
export interface EffectContext {
  /** Gradient under the rider, percent. */
  gradePercent: number;
  speedMps: number;
}

export interface PowerUpDefinition {
  kind: PowerUpKind;
  /** How long the effect acts once started, seconds. */
  durationS: number;
  /**
   * Armed effects wait for their moment (`fires`) for at most this long, then expire unused.
   * Absent: the effect starts as soon as it is used.
   */
  armedS?: number;
  fires?(ctx: EffectContext): boolean;
  modifiers(ctx: EffectContext): EffectModifiers;
  /**
   * Who the effect acts on: 'self', or (Rumble attacks) the rider directly ahead ('ahead'), the
   * leader ('leader'), the rider directly behind ('chaser': the dropped chain), or whoever rides
   * over the spot behind this rider ('behind': the mud puddle, the tacks, a rough section). Hits
   * are applied by the rider hit, to itself (`receiveHit`); nobody changes another rider's
   * numbers.
   */
  target: 'self' | 'ahead' | 'leader' | 'chaser' | 'behind';
  /**
   * 'boost' helps this rider (its gain is the "+ m from items"), 'attack' slows whoever it hits
   * (the "− m from hits"), 'guard' is the rain cape (no modifiers; it keeps off the next hit),
   * 'repair' the mini tool (ends a flat tyre or a dropped chain early), 'supply' the team car
   * (fills the slots), 'terrain' the rough section (road that slows everyone else on it, not a
   * hit: no cape, no protection; see `setTerrain`).
   */
  role: 'boost' | 'attack' | 'guard' | 'repair' | 'supply' | 'terrain';
}

/** A descent for Downhill momentum: at least this steep downhill, percent. */
export const DESCENT_GRADE_PERCENT = -2;

/**
 * The four power-ups. Magnitudes are chosen to be noticeable but modest: tens of metres over
 * an effect, never a different race.
 */
export const POWER_UP_DEFINITIONS: Record<PowerUpKind, PowerUpDefinition> = {
  /** Strong and short: 40 % less air resistance for 15 s (a firm tailwind at race speed). */
  tailwind: {
    kind: 'tailwind',
    durationS: 15,
    target: 'self',
    role: 'boost',
    modifiers: () => mods({ dragFactor: 0.6 }),
  },
  /** 12 % less mass for 25 s, applied uphill only (downhill less mass would slow the bike). */
  lightLoad: {
    kind: 'lightLoad',
    durationS: 25,
    target: 'self',
    role: 'boost',
    modifiers: (c) => (c.gradePercent > 0.5 ? mods({ massFactor: 0.88 }) : NO_MODIFIERS),
  },
  /** Moderate and long: 25 % less air resistance for 30 s, like sitting in a wheel. */
  slipstream: {
    kind: 'slipstream',
    durationS: 30,
    target: 'self',
    role: 'boost',
    modifiers: () => mods({ dragFactor: 0.75 }),
  },
  /**
   * Armed for up to 3 min; on the next descent (≤ −2 %) it acts for 20 s with 30 % less air
   * resistance and half the rolling resistance, even if the road levels out meanwhile.
   */
  downhill: {
    kind: 'downhill',
    durationS: 20,
    armedS: 180,
    fires: (c) => c.gradePercent <= DESCENT_GRADE_PERCENT,
    target: 'self',
    role: 'boost',
    modifiers: () => mods({ dragFactor: 0.7, rollingFactor: 0.5 }),
  },
  /**
   * Rumble: thrown at the rider directly ahead (it homes in; only protection or a rain cape stops
   * it). Twice the air resistance for 10 s: at 200 W on the flat about 25 m of race position, as
   * much as a boost gains (Tailwind ≈ 19 m, Slipstream ≈ 24 m); on a climb much less.
   */
  bottle: {
    kind: 'bottle',
    durationS: 10,
    target: 'ahead',
    role: 'attack',
    modifiers: () => mods({ dragFactor: 2 }),
  },
  /**
   * Rumble: dropped on the road behind this rider; the next rider through it is slowed: 3× the
   * air resistance for 5 s (about 24 m at 200 W on the flat). It dries up after 60 s.
   */
  puddle: {
    kind: 'puddle',
    durationS: 5,
    target: 'behind',
    role: 'attack',
    modifiers: () => mods({ dragFactor: 3 }),
  },
  /**
   * Rumble: a swarm that chases the leader, however far ahead: 2.2× the air resistance for 8 s
   * (about 24 m at 200 W on the flat), and the leader's own screen shows the gaps as "?".
   */
  hornets: {
    kind: 'hornets',
    durationS: 8,
    target: 'leader',
    role: 'attack',
    modifiers: () => mods({ dragFactor: 2.2 }),
  },
  /** Rumble: raised when used, it keeps off the next hit within 60 s, then it is used up. */
  cape: {
    kind: 'cape',
    durationS: 60,
    target: 'self',
    role: 'guard',
    modifiers: () => NO_MODIFIERS,
  },
  /**
   * Rumble (v3): eaten at once, 45 % more power in the shadow bike for 15 s — about 22 m at
   * 200 W on the flat, between a Tailwind (≈ 19 m) and a Slipstream (≈ 24 m). The trainer and
   * the recording never see the extra watts.
   */
  energyBar: {
    kind: 'energyBar',
    durationS: 15,
    target: 'self',
    role: 'boost',
    modifiers: () => mods({ powerFactor: 1.45 }),
  },
  /**
   * Rumble (v3): scattered on the road behind this rider like a mud puddle (same placement and
   * claim protocol: one rider, never the dropper, gone after 60 s). Whoever rides over them has a
   * flat tyre: 3.5× the rolling resistance for 20 s (about 27 m at 200 W on the flat), unless a
   * mini tool fixes it sooner.
   */
  tacks: {
    kind: 'tacks',
    durationS: 20,
    target: 'behind',
    role: 'attack',
    modifiers: () => mods({ rollingFactor: 3.5 }),
  },
  /** Rumble (v3): used on a flat tyre (fixed 3 s later) or a dropped chain (back on in 1 s). */
  tool: {
    kind: 'tool',
    durationS: 3,
    target: 'self',
    role: 'repair',
    modifiers: () => NO_MODIFIERS,
  },
  /**
   * Rumble (v3): at the rider directly behind, however far: their chain comes off and they
   * pedal into nothing for 6 s (no power in the shadow bike, coasting with the usual drag) —
   * about 22 m at 200 W on the flat. The mini tool puts it back on in 1 s.
   */
  chain: {
    kind: 'chain',
    durationS: 6,
    target: 'chaser',
    role: 'attack',
    modifiers: () => mods({ powerFactor: 0 }),
  },
  /** Rumble (v3): the team car pulls up and fills this slot and the other one if it is empty. */
  teamCar: {
    kind: 'teamCar',
    durationS: 0,
    target: 'self',
    role: 'supply',
    modifiers: () => NO_MODIFIERS,
  },
  /**
   * Rumble (v3): 150 m of rough road laid behind this rider, there for 60 s. Every other rider
   * on it has 2.5× the rolling resistance while inside (about 12–14 m lost riding through at
   * 200 W on the flat). Road, not a hit: no rain cape keeps it off, no protection follows.
   */
  rough: {
    kind: 'rough',
    durationS: 60,
    target: 'behind',
    role: 'terrain',
    modifiers: () => mods({ rollingFactor: 2.5 }),
  },
};

/** How long the mini tool takes, per hit it fixes (s). */
export const REPAIR_S: Partial<Record<PowerUpKind, number>> = { tacks: 3, chain: 1 };

/** After any hit (or one a rain cape kept off) nothing lands on that rider for this long, s. */
export const PROTECTION_S = 15;
/** Items a Rumble rider holds: one per side button. */
export const RUMBLE_CAPACITY = 2;
/**
 * What a feed bag or a challenge gives in a Rumble: every item, a pool entry per chance (27 in
 * all). Boosts: the four power-ups and the energy bar × 2 each (10 of 27, about 37 %). Attacks:
 * water bottle, mud puddle, tacks, dropped chain, rough section × 2 each, hornets × 1 (11 of
 * 27). Help: rain cape × 2, mini tool × 3 (so a flat is now and then fixable), team car × 1.
 * Plain weights: every rider on a route meets the same item at the same feed bag.
 */
export const RUMBLE_POOL: readonly PowerUpKind[] = [
  'tailwind',
  'tailwind',
  'slipstream',
  'slipstream',
  'lightLoad',
  'lightLoad',
  'downhill',
  'downhill',
  'energyBar',
  'energyBar',
  'bottle',
  'bottle',
  'puddle',
  'puddle',
  'tacks',
  'tacks',
  'chain',
  'chain',
  'rough',
  'rough',
  'hornets',
  'cape',
  'cape',
  'tool',
  'tool',
  'tool',
  'teamCar',
];

/** Several effects at once multiply (only one at a time for now; see `maxEffects`). */
export function combineModifiers(list: readonly EffectModifiers[]): EffectModifiers {
  const out = { ...NO_MODIFIERS };
  for (const m of list) {
    out.dragFactor *= m.dragFactor;
    out.massFactor *= m.massFactor;
    out.rollingFactor *= m.rollingFactor;
    out.powerFactor *= m.powerFactor;
  }
  return out;
}

export function isNoModifier(m: EffectModifiers): boolean {
  return m.dragFactor === 1 && m.massFactor === 1 && m.rollingFactor === 1 && m.powerFactor === 1;
}

/** The shadow bike for the race position. */
export function modifiedBike(bike: BikeParams, m: EffectModifiers): BikeParams {
  return {
    ...bike,
    cdaM2: bike.cdaM2 * m.dragFactor,
    totalMassKg: bike.totalMassKg * m.massFactor,
    crr: bike.crr * m.rollingFactor,
  };
}

// ───────────── configuration ─────────────

/**
 * When an effort challenge is offered: the 3-min average power (`recentS`) is at least 12 %
 * below the 5-min average before it (`baselineS`), at least 5 min into the ride (in practice
 * 8 min: both windows must be full), while riding, never in ERG (no ERG second in either
 * window), not on a descent (now ≤ −2 % or the recent window averaging ≤ −1 %), not while
 * holding a power-up or one is in effect, and at most once per 10 min.
 */
export interface ChallengeRules {
  notBeforeS: number;
  recentS: number;
  baselineS: number;
  /** Recent average ≤ (1 − dropFraction) × baseline. */
  dropFraction: number;
  /** Seconds between two offers (counted from the earlier offer). */
  cooldownS: number;
  /** The recent average must be at least this (actually riding, not coasting). */
  minRecentW: number;
  /** Gradient now at or below which nothing is offered (a descent). */
  descentGradePercent: number;
  /** Average gradient of the recent window at or below which nothing is offered. */
  descentAverageGradePercent: number;
  /** Seconds to start the hold before the offer lapses. */
  offerS: number;
  /** Seconds to hold the target. */
  holdS: number;
  /** Target = recent average × targetFactor, at most ftpCap × FTP, at least minFactor × recent. */
  targetFactor: number;
  minFactor: number;
  ftpCap: number;
  /** 3 s power ≥ tolerance × target counts as holding. */
  tolerance: number;
  /** Below the target for longer than this (in one go) ends the hold as failed. */
  graceS: number;
}

export interface PowerUpConfig {
  /** Distance between pick-up spots, drawn uniformly from [minM, maxM]. */
  spacing: { minM: number; maxM: number };
  challenge: ChallengeRules;
  /** Items held at once (normal ride). */
  capacity: number;
  /** Effects at once. */
  maxEffects: number;
  /** Kinds a pick-up or challenge can give. */
  pool: readonly PowerUpKind[];
  /** The same in a Rumble (entries may repeat: weights). */
  itemPool: readonly PowerUpKind[];
  /**
   * Tests and the simulation only: the n-th item a feed bag gives is `itemOrder[n]` (the last
   * one from then on) instead of a draw from `itemPool`. Null: draw.
   */
  itemOrder: readonly PowerUpKind[] | null;
  /** Rumble: seconds of protection after a hit. */
  protectionS: number;
  /** Pick-up spots reported ahead (m). */
  lookAheadM: number;
}

export const DEFAULT_CHALLENGE_RULES: ChallengeRules = {
  notBeforeS: 300,
  recentS: 180,
  baselineS: 300,
  dropFraction: 0.12,
  cooldownS: 600,
  minRecentW: 40,
  descentGradePercent: -2,
  descentAverageGradePercent: -1,
  offerS: 20,
  holdS: 30,
  targetFactor: 1.15,
  minFactor: 1.05,
  ftpCap: 1.05,
  tolerance: 0.95,
  graceS: 3,
};

export const DEFAULT_POWER_UP_CONFIG: PowerUpConfig = {
  spacing: { minM: 2000, maxM: 4000 },
  challenge: DEFAULT_CHALLENGE_RULES,
  capacity: 1,
  maxEffects: 1,
  pool: POWER_UP_KINDS,
  itemPool: RUMBLE_POOL,
  itemOrder: null,
  protectionS: PROTECTION_S,
  lookAheadM: 600,
};

/**
 * Overrides for tests and the simulation (shorter spacing and windows). Untrusted: every value
 * is checked, anything odd keeps the default.
 */
export interface PowerUpTuning {
  spacingM?: [number, number];
  challenge?: Partial<ChallengeRules>;
  /** Only these kinds (e.g. to see one effect in a test). */
  pool?: PowerUpKind[];
  /** Rumble: only these items (any of RUMBLE_ITEM_KINDS). */
  itemPool?: PowerUpKind[];
  /** Rumble: these items in this order, one per feed bag, the last one repeating. */
  itemOrder?: PowerUpKind[];
}

export function powerUpConfig(tuning?: unknown): PowerUpConfig {
  const t = (typeof tuning === 'object' && tuning !== null ? tuning : {}) as Record<
    string,
    unknown
  >;
  const config: PowerUpConfig = {
    ...DEFAULT_POWER_UP_CONFIG,
    spacing: { ...DEFAULT_POWER_UP_CONFIG.spacing },
    challenge: { ...DEFAULT_CHALLENGE_RULES },
  };
  const s = t.spacingM;
  if (
    Array.isArray(s) &&
    typeof s[0] === 'number' &&
    typeof s[1] === 'number' &&
    s[0] >= 10 &&
    s[1] >= s[0] &&
    s[1] <= 100_000
  ) {
    config.spacing = { minM: s[0], maxM: s[1] };
  }
  const pool = t.pool;
  if (Array.isArray(pool)) {
    const kinds = POWER_UP_KINDS.filter((k) => pool.includes(k));
    if (kinds.length > 0) config.pool = kinds;
  }
  const itemPool = t.itemPool;
  if (Array.isArray(itemPool)) {
    const kinds = RUMBLE_ITEM_KINDS.filter((k) => itemPool.includes(k));
    if (kinds.length > 0) config.itemPool = kinds;
  }
  const order = t.itemOrder;
  if (Array.isArray(order) && order.length > 0 && order.length <= 32) {
    if (order.every((k) => RUMBLE_ITEM_KINDS.includes(k as PowerUpKind))) {
      config.itemOrder = order as PowerUpKind[];
    }
  }
  const c = t.challenge;
  if (typeof c === 'object' && c !== null) {
    for (const [key, value] of Object.entries(c as Record<string, unknown>)) {
      if (
        Object.prototype.hasOwnProperty.call(DEFAULT_CHALLENGE_RULES, key) &&
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= 100_000
      ) {
        config.challenge[key as keyof ChallengeRules] = value;
      }
    }
  }
  return config;
}

// ───────────── determinism ─────────────

/** FNV-1a, 32 bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, 0 ≤ x < 1. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The kind at pick-up spot `index` (or challenge reward `index`), from the seed. */
export function kindFor(
  seed: string,
  index: number,
  pool: readonly PowerUpKind[] = POWER_UP_KINDS,
  salt = 'spot',
): PowerUpKind {
  const r = seededRandom(hashString(`${seed}|${salt}|${index}`))();
  return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))] ?? 'tailwind';
}

/** The seed of a ride: the route's base id on a route (shared by everyone on it), else the ride. */
export function powerUpSeed(routeBaseId: string | null, rideId: string): string {
  return routeBaseId ? `route:${routeBaseId}` : `ride:${rideId}`;
}

/**
 * Pick-up spots along a route (m from its start). Fixed for a route id: the first spot one
 * spacing after the start, then one spacing after another. On a loop none sits within half
 * the minimum spacing of the finish line (so laps keep the spacing); on a route ridden once
 * none sits past its end.
 */
export function routeSpots(
  seed: string,
  lengthM: number,
  loop: boolean,
  spacing: PowerUpConfig['spacing'],
): number[] {
  if (!(lengthM > 0)) return [];
  const rnd = seededRandom(hashString(seed));
  const gap = (): number => spacing.minM + rnd() * (spacing.maxM - spacing.minM);
  const limit = loop ? lengthM - spacing.minM / 2 : lengthM - 1;
  const out: number[] = [];
  for (let at = gap(); at < limit && out.length < 10_000; at += gap()) out.push(Math.round(at));
  return out;
}

/** The first `count` spots of a free ride (m of ridden distance). */
export function freeRideSpots(
  seed: string,
  count: number,
  spacing: PowerUpConfig['spacing'],
): number[] {
  const rnd = seededRandom(hashString(seed));
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    at += spacing.minM + rnd() * (spacing.maxM - spacing.minM);
    out.push(Math.round(at));
  }
  return out;
}

// ───────────── the engine ─────────────

export interface PowerUpTrack {
  /** Base route id (routeBaseId): riders on copies of the same route share it. */
  id: string;
  lengthM: number;
  loop: boolean;
}

/** One tick of the ride, as the controller sees it. */
export interface PowerUpTick {
  state: 'idle' | 'riding' | 'paused';
  /** Ride time (s); advances only while riding. */
  elapsedS: number;
  /** Recorded (physics) distance, m. */
  distanceM: number;
  /** Position on the route (m, wrapped on a loop), null without a route. */
  routeM: number | null;
  speedMps: number;
  powerW: number;
  power3sW: number;
  gradePercent: number;
  /** Brake in effect, 0 … 1 (the shadow bike brakes like the real one). */
  brake: number;
  bike: BikeParams;
  ftpW: number;
  /** Null when power-ups apply now. */
  blocked: PowerUpBlock | null;
  /** Effort challenges switched on. */
  challenges: boolean;
}

export interface PowerUpEvent {
  type: PowerUpEventType;
  kind?: PowerUpKind;
  /** Ride time of the event, s. */
  atS: number;
}

interface Effect {
  kind: PowerUpKind;
  role: PowerUpDefinition['role'];
  phase: 'armed' | 'active';
  /** Armed: when it expires; active: when it ends (ride time, s). */
  untilS: number;
  durationS: number;
  /** Where it came from: 'self' (used an item) or, for a hit, the name of whose item it was. */
  source: string;
  /** The mini tool at work on it (flat tyre, dropped chain): started at, ends at (ride s). */
  repair?: { fromS: number; untilS: number };
}

interface Challenge {
  phase: 'offered' | 'holding';
  targetW: number;
  offerUntilS: number;
  heldS: number;
  belowS: number;
}

/** One second of riding, for the challenge windows. */
interface Bucket {
  powerW: number;
  gradePercent: number;
  erg: boolean;
}

export interface PowerUpEngineOptions {
  seed: string;
  /** The route ridden, or null/absent for a free ride. */
  track?: PowerUpTrack | null;
  config?: PowerUpConfig;
  /** 'normal' (default) or 'rumble'; can change during the ride (`setMode`). */
  mode?: GroupMode;
}

/** What `receiveHit` made of a hit (the target's answer). */
export type AttackOutcome = Extract<AttackResult, 'hit' | 'blocked' | 'protected' | 'unavailable'>;

/** How far a position may move in one tick and still count as riding through (not a jump). */
const MAX_STEP_M = 80;
/** Below this speed difference the shadow bike rejoins the real one (no drift). */
const REJOIN_MPS = 0.01;

/**
 * A copy of the virtual bike with modified parameters. The difference between its distance and
 * the recorded one is integrated into `offsetM`, kept on one side of zero (`sign`): a boost
 * shadow only gains, an attack shadow only loses.
 */
class Shadow {
  speedMps = 0;
  offsetM = 0;
  /** Away from the real bike: under an effect or still bleeding off its speed difference. */
  #away = false;
  readonly sign: 1 | -1;
  /**
   * `followIdle`: without an effect so far the shadow simply *is* the real bike (the attack
   * shadow: it must not pick up the start-up lag of the first tick, which nothing clamps away).
   * The boost shadow keeps the original behaviour of ADR 0006 (its lag is clamped at 0).
   */
  readonly #followIdle: boolean;
  constructor(sign: 1 | -1, followIdle = false) {
    this.sign = sign;
    this.#followIdle = followIdle;
  }

  step(t: PowerUpTick, dt: number, realDeltaM: number, mods: EffectModifiers): void {
    const none = isNoModifier(mods);
    if (!none) this.#away = true;
    if (none && !this.#away && this.#followIdle) {
      this.speedMps = t.speedMps;
      return;
    }
    if (none && Math.abs(this.speedMps - t.speedMps) < REJOIN_MPS) {
      this.speedMps = t.speedMps;
      this.#away = false;
      return;
    }
    const step = stepBike(
      this.speedMps,
      t.powerW * mods.powerFactor,
      t.gradePercent,
      modifiedBike(t.bike, mods),
      dt,
      t.brake,
    );
    this.speedMps = step.speedMps;
    const next = this.offsetM + step.distanceM - realDeltaM;
    this.offsetM = this.sign > 0 ? Math.max(0, next) : Math.min(0, next);
  }
}

export class PowerUpEngine {
  readonly seed: string;
  readonly config: PowerUpConfig;
  readonly #track: PowerUpTrack | null;
  /** Route spots (route m) or free-ride spots (ridden m), ascending. */
  #spots: number[];
  #mode: GroupMode;
  /** The hand as fixed slots (left first); a normal ride has one. */
  #slots: (PowerUpKind | null)[];
  #effects: Effect[] = [];
  #challenge: Challenge | null = null;
  #lastOfferS = Number.NEGATIVE_INFINITY;
  #challengeCount = 0;
  #buckets: Bucket[] = [];
  #bucket = { energyJ: 0, gradeS: 0, timeS: 0, erg: false };
  #lastElapsedS: number | null = null;
  #lastDistanceM = 0;
  #lastCoord: number | null = null;
  /** Own items (and, in a normal ride, all power-ups): the race gain, ≥ 0. */
  readonly #boost = new Shadow(1);
  /** Rumble hits on this rider: the race loss, ≤ 0. */
  readonly #attack = new Shadow(-1, true);
  /** Rumble: no hit lands before this ride time (s). */
  #protectedUntilS = Number.NEGATIVE_INFINITY;
  #incoming: IncomingHitLive | null = null;
  #outgoing: OutgoingAttackLive | null = null;
  #attackSeq = 0;
  #picked = 0;
  #used = 0;
  /** Rumble: the rough section this rider rides on (set by the controller each tick). */
  #terrain: { variant: RoughVariant; by: string } | null = null;
  /** Rumble: how often the team car came (seeds its items). */
  #supplies = 0;
  #supply: { seq: number; kinds: PowerUpKind[] } | null = null;
  /** Items handed out by feed bags so far (for `itemOrder`). */
  #ordered = 0;
  #seq = 0;
  #event: PowerUpEventLive | null = null;
  #last: PowerUpTick | null = null;
  #upcoming: number[] = [];

  constructor(options: PowerUpEngineOptions) {
    this.seed = options.seed;
    this.config = options.config ?? DEFAULT_POWER_UP_CONFIG;
    this.#track = options.track && options.track.lengthM > 0 ? options.track : null;
    this.#spots = this.#track
      ? routeSpots(this.seed, this.#track.lengthM, this.#track.loop, this.config.spacing)
      : freeRideSpots(this.seed, 64, this.config.spacing);
    this.#mode = options.mode ?? 'normal';
    this.#slots = Array.from({ length: this.#capacity() }, () => null);
  }

  /** Pick-up spots: route metres on a route, ridden metres in a free ride (the first few). */
  get spots(): readonly number[] {
    return this.#spots;
  }

  /** Held items, first (left) first. */
  get hand(): readonly PowerUpKind[] {
    return this.#slots.filter((k): k is PowerUpKind => k !== null);
  }

  /** The held items as slots (Rumble: [left, right]); null = empty. */
  get slots(): readonly (PowerUpKind | null)[] {
    return this.#slots;
  }

  get mode(): GroupMode {
    return this.#mode;
  }

  /** Race position − recorded position, m. Negative only in a Rumble (hits). */
  get raceOffsetM(): number {
    const total = this.#boost.offsetM + this.#attack.offsetM;
    // "Power-ups only help": a normal ride never places a rider behind their own legs.
    return this.#mode === 'normal' ? Math.max(0, total) : total;
  }

  /** Metres gained from own items / power-ups (≥ 0). */
  get gainM(): number {
    return this.#boost.offsetM;
  }

  /** Metres lost to hits (≤ 0; always 0 in a normal ride). */
  get lossM(): number {
    return this.#attack.offsetM;
  }

  /**
   * Switches between a normal ride and a Rumble (the host's choice; may change mid-ride).
   * To Rumble: a second slot. Back to normal: one slot, the first boost held stays (attack
   * items and the cape have no use there), hits and the cape end, the loss to hits is dropped
   * (a normal ride never places anyone behind their own riding).
   */
  setMode(mode: GroupMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    const held = this.hand;
    if (mode === 'normal') {
      // Only the power-ups of a normal ride stay (not the Rumble's energy bar).
      const keep = held.find((k) => POWER_UP_KINDS.includes(k)) ?? null;
      this.#slots = [keep];
      for (const e of this.#effects.filter((x) => x.role !== 'boost')) this.#removeEffect(e);
      this.#attack.offsetM = 0;
      this.#attack.speedMps = this.#boost.speedMps;
      this.#protectedUntilS = Number.NEGATIVE_INFINITY;
      this.#incoming = null;
      this.#outgoing = null;
      this.#terrain = null;
      this.#supply = null;
    } else {
      this.#slots = [...this.#slots, ...Array.from({ length: RUMBLE_CAPACITY }, () => null)].slice(
        0,
        RUMBLE_CAPACITY,
      );
    }
  }

  /** Advances the engine by one tick. Returns what happened in it (also kept for `toLive`). */
  update(t: PowerUpTick): PowerUpEvent[] {
    const events: PowerUpEvent[] = [];
    const emit = (type: PowerUpEventType, kind?: PowerUpKind): void => {
      events.push({ type, kind, atS: t.elapsedS });
      this.#seq += 1;
      this.#event = { seq: this.#seq, type, ...(kind ? { kind } : {}) };
    };
    const prevElapsed = this.#lastElapsedS ?? t.elapsedS;
    const dt = Math.max(0, Math.min(5, t.elapsedS - prevElapsed));
    this.#lastElapsedS = t.elapsedS;
    const realDeltaM = Math.max(0, t.distanceM - this.#lastDistanceM);
    this.#lastDistanceM = t.distanceM;
    this.#last = t;
    const riding = t.state === 'riding';
    const ctx: EffectContext = { gradePercent: t.gradePercent, speedMps: t.speedMps };

    // ── effects: an ERG step, an FTP test or switching off ends what acts; armed ones wait ──
    for (const e of [...this.#effects]) {
      const def = POWER_UP_DEFINITIONS[e.kind];
      if (e.phase === 'active' && (t.blocked !== null || t.elapsedS >= e.untilS)) {
        this.#removeEffect(e);
        emit('ended', e.kind);
      } else if (e.phase === 'armed') {
        if (t.elapsedS >= e.untilS) {
          this.#removeEffect(e);
          emit('expired', e.kind);
        } else if (riding && t.blocked === null && def.fires?.(ctx)) {
          e.phase = 'active';
          e.durationS = def.durationS;
          e.untilS = t.elapsedS + def.durationS;
          emit('started', e.kind);
        }
      }
    }

    // ── race position: shadow bikes with the effects, next to the real one ──
    if (riding && dt > 0) {
      const mods = (role: Effect['role']): EffectModifiers =>
        combineModifiers(
          this.#effects
            .filter((e) => e.phase === 'active' && e.role === role)
            .map((e) => POWER_UP_DEFINITIONS[e.kind].modifiers(ctx)),
        );
      this.#boost.step(t, dt, realDeltaM, mods('boost'));
      if (this.#mode === 'rumble') {
        const loss = [mods('attack')];
        // Rough road under this rider (not while out of the race: paused, ERG, items off).
        if (this.#terrain && t.blocked === null)
          loss.push(POWER_UP_DEFINITIONS.rough.modifiers(ctx));
        this.#attack.step(t, dt, realDeltaM, combineModifiers(loss));
      }
    } else if (!riding) {
      this.#boost.speedMps = 0;
      this.#attack.speedMps = 0;
    }

    // ── pick-ups ──
    const coord = this.#track ? t.routeM : t.distanceM;
    if (coord !== null && Number.isFinite(coord)) {
      if (!this.#track) this.#extendFreeSpots(coord);
      const prev = this.#lastCoord;
      if (prev !== null && riding && t.blocked === null) {
        for (const index of this.#crossed(prev, coord)) {
          const order = this.#mode === 'rumble' ? this.config.itemOrder : null;
          const kind = order
            ? order[Math.min(this.#ordered, order.length - 1)]!
            : kindFor(this.seed, index, this.#pool());
          if (this.#put(kind)) {
            if (order) this.#ordered += 1;
            this.#picked += 1;
            emit('picked', kind);
          } else emit('skipped', kind);
        }
      }
      this.#lastCoord = coord;
      this.#upcoming = t.blocked === null ? this.#ahead(coord) : [];
    } else this.#upcoming = [];

    // ── effort challenges ──
    if (riding && dt > 0) this.#collect(dt, t);
    if (this.#challenge) this.#runChallenge(t, dt, emit);
    else if (this.#mayOffer(t)) {
      const targetW = this.#target(t.ftpW);
      if (targetW !== null) {
        this.#challenge = {
          phase: 'offered',
          targetW,
          offerUntilS: t.elapsedS + this.config.challenge.offerS,
          heldS: 0,
          belowS: 0,
        };
        this.#lastOfferS = t.elapsedS;
        emit('challenge-offered');
      }
    }
    return events;
  }

  /** True when `activate()` would use an item now (Rumble: either slot). */
  get canActivate(): boolean {
    if (this.#mode === 'rumble') return this.#slots.some((_, i) => this.canPlay(i));
    const t = this.#last;
    return (
      this.hand.length > 0 &&
      t !== null &&
      t.state === 'riding' &&
      t.blocked === null &&
      this.#effects.length < this.config.maxEffects
    );
  }

  /**
   * Rumble: whether the item in `slot` can be used now, as far as this rider can tell (an aimed
   * item also needs a target, which the controller resolves).
   */
  canPlay(slot: number): boolean {
    return this.playNote(slot) === null;
  }

  /** Rumble: why the item in `slot` cannot be used now, in a few words (null: it can). */
  playNote(slot: number): string | null {
    const kind = this.#slots[slot];
    const t = this.#last;
    if (kind === undefined || kind === null) return 'Empty';
    if (!t || t.state !== 'riding') return 'Resume the ride to use it';
    if (t.blocked === 'erg') return 'Kept for later · not in ERG steps';
    if (t.blocked === 'ftpTest') return 'Kept for later · not in FTP tests';
    if (t.blocked !== null) return 'Items are off';
    const role = POWER_UP_DEFINITIONS[kind].role;
    if (role === 'boost' && this.#boostEffects().length > 0) return 'After your boost';
    if (role === 'guard' && this.#effects.some((e) => e.role === 'guard')) return 'Cape is up';
    if (role === 'repair') {
      const hit = this.#repairable();
      if (!hit) return 'Only with a flat or chain off';
      if (hit.repair) return 'Repairing';
    }
    return null;
  }

  /** The hit the mini tool could fix now (a flat tyre, a dropped chain), if any. */
  #repairable(): Effect | undefined {
    return this.#effects.find((e) => e.role === 'attack' && REPAIR_S[e.kind] !== undefined);
  }

  /**
   * Uses the item at `index` (the first by default): a power-up or (Rumble) a boost or the rain
   * cape. In a Rumble `index` is the slot (0 left, 1 right). Returns false (and keeps the item)
   * when none is held, the ride is not running, power-ups are blocked, an effect of the same
   * sort still acts, or the item is an attack (see `spendItem`).
   */
  activate(index = 0): boolean {
    if (this.#mode === 'rumble') {
      const kind = this.#slots[index];
      const role = kind ? POWER_UP_DEFINITIONS[kind].role : null;
      if (!kind || role === 'attack' || role === 'terrain' || !this.canPlay(index)) {
        return false;
      }
      this.#slots[index] = null;
      this.#used += 1;
      if (role === 'repair') return this.#repair();
      if (role === 'supply') return this.#teamCar(index);
      this.#emit('activated', kind);
      return this.applyEffect(kind, 'self');
    }
    const hand = this.hand;
    const kind = hand[index];
    if (kind === undefined || !this.canActivate) return false;
    this.#slots[this.#slots.indexOf(kind)] = null;
    this.#compact();
    this.#used += 1;
    this.#emit('activated', kind);
    this.applyEffect(kind, 'self');
    return true;
  }

  /**
   * Rumble: takes the attack item in `slot` out of its slot to use it — the controller has found
   * the target of a bottle or the hornets and sends them, or drops the puddle on the road. Null
   * when the slot holds no attack item or it cannot be used.
   */
  spendItem(slot: number): PowerUpKind | null {
    const kind = this.#slots[slot];
    const role = kind ? POWER_UP_DEFINITIONS[kind].role : null;
    if (this.#mode !== 'rumble' || !kind || (role !== 'attack' && role !== 'terrain')) {
      return null;
    }
    if (!this.canPlay(slot)) return null;
    this.#slots[slot] = null;
    this.#used += 1;
    this.#emit(POWER_UP_DEFINITIONS[kind].target === 'behind' ? 'dropped' : 'played', kind);
    return kind;
  }

  /**
   * Rumble: an item used by this rider could not land (target protected, gone, not in the race,
   * no answer; a puddle that could not be dropped): it goes back into a slot if there is room.
   */
  returnItem(kind: PowerUpKind): boolean {
    if (!this.#put(kind)) return false;
    this.#used = Math.max(0, this.#used - 1);
    this.#emit('returned', kind);
    return true;
  }

  /**
   * Rumble: the rough section this rider rides on now (null: none). The controller finds it from
   * the others' broadcast every tick; while set, the rolling resistance of the loss shadow is
   * 2.5× (only while riding in the race). Not a hit: no cape, no protection, nothing to claim.
   */
  setTerrain(terrain: { variant: RoughVariant; by: string } | null): void {
    this.#terrain = this.#mode === 'rumble' && terrain ? { ...terrain } : null;
  }

  /** Rumble: notes what became of an item this rider used on someone (for the notice). */
  noteOutgoing(
    kind: PowerUpKind,
    target: string,
    result: OutgoingAttackLive['result'],
    targetId?: string,
  ): void {
    this.#attackSeq += 1;
    this.#outgoing = {
      seq: this.#attackSeq,
      kind,
      target,
      ...(targetId ? { targetId } : {}),
      result,
    };
  }

  /**
   * Rumble: what a hit would meet now — 'unavailable' (not riding, blocked, not a Rumble),
   * 'protected' (slowed by a hit, or within the protection after one), or null (it would land,
   * or the rain cape would keep it off). A rider checks this before claiming a puddle: a
   * protected rider rolls through without using it up.
   */
  hitCheck(): 'unavailable' | 'protected' | null {
    const t = this.#last;
    if (!t || this.#mode !== 'rumble') return 'unavailable';
    if (t.state !== 'riding' || t.blocked !== null) return 'unavailable';
    if (this.#effects.some((e) => e.role === 'attack') || t.elapsedS < this.#protectedUntilS) {
      return 'protected';
    }
    return null;
  }

  /**
   * Rumble: a hit from another rider's item `kind` (a bottle or hornets aimed at this one, or a
   * puddle this rider rode through and was granted). Applied here, to this rider only, one hit
   * at a time:
   * - not riding, blocked (ERG, FTP test, off) or not in a Rumble → 'unavailable';
   * - slowed by a hit, or within the protection after one → 'protected';
   * - rain cape up → the cape is used up, protection starts → 'blocked' (the cape keeps off
   *   every kind of hit, the puddle included);
   * - otherwise the slowing starts, and protection runs until `protectionS` after it → 'hit'.
   * The caller (the group link) guarantees each hit arrives here once.
   */
  receiveHit(kind: PowerUpKind, by: string): AttackOutcome {
    const t = this.#last;
    const def = POWER_UP_DEFINITIONS[kind];
    let result: AttackOutcome;
    const check = this.hitCheck();
    if (!def || def.role !== 'attack' || check === 'unavailable') result = 'unavailable';
    else if (check === 'protected') result = 'protected';
    else {
      const now = t!.elapsedS;
      const cape = this.#effects.find((e) => e.role === 'guard');
      if (cape) {
        this.#removeEffect(cape);
        this.#protectedUntilS = now + this.config.protectionS;
        this.#emit('blocked', kind);
        result = 'blocked';
      } else {
        const untilS = now + def.durationS;
        this.#effects.push({
          kind,
          role: 'attack',
          phase: 'active',
          untilS,
          durationS: def.durationS,
          source: by,
        });
        this.#protectedUntilS = untilS + this.config.protectionS;
        this.#emit('hit', kind);
        result = 'hit';
      }
    }
    if (result !== 'unavailable') {
      this.#attackSeq += 1;
      this.#incoming = { seq: this.#attackSeq, kind, by, result };
    }
    return result;
  }

  /**
   * Starts an effect without an item (an effect from elsewhere). Armed kinds are armed; the rest
   * start at once. Returns false when no effect slot is free or power-ups are blocked. In a
   * Rumble boosts, the cape and hits each have their own slot; hits arrive through `receiveHit`
   * instead (protection, cape).
   */
  applyEffect(kind: PowerUpKind, source = 'self'): boolean {
    const t = this.#last;
    if (!t || t.blocked !== null) return false;
    const def = POWER_UP_DEFINITIONS[kind];
    if (this.#mode === 'rumble') {
      if (def.role === 'attack') return false;
      if (this.#effects.some((e) => e.role === def.role)) return false;
    } else if (this.#effects.length >= this.config.maxEffects) return false;
    if (def.armedS !== undefined) {
      this.#effects.push({
        kind,
        role: def.role,
        phase: 'armed',
        untilS: t.elapsedS + def.armedS,
        durationS: def.armedS,
        source,
      });
    } else {
      this.#effects.push({
        kind,
        role: def.role,
        phase: 'active',
        untilS: t.elapsedS + def.durationS,
        durationS: def.durationS,
        source,
      });
      this.#emit('started', kind);
    }
    return true;
  }

  /** Adds an item from elsewhere (a challenge here). */
  grant(kind: PowerUpKind): boolean {
    if (!this.#put(kind)) {
      this.#emit('skipped', kind);
      return false;
    }
    return true;
  }

  /** The rider waved the challenge away. */
  dismissChallenge(): boolean {
    if (!this.#challenge) return false;
    this.#challenge = null;
    this.#emit('challenge-ended');
    return true;
  }

  /** The mini tool: the flat tyre or dropped chain ends REPAIR_S later (never later than it would). */
  #repair(): boolean {
    const hit = this.#repairable()!;
    const now = this.#last!.elapsedS;
    const untilS = Math.min(hit.untilS, now + (REPAIR_S[hit.kind] ?? 0));
    hit.repair = { fromS: now, untilS };
    hit.untilS = untilS;
    // Protection runs on from when it is fixed, as after any hit.
    this.#protectedUntilS = untilS + this.config.protectionS;
    this.#emit('repairing', 'tool');
    return true;
  }

  /**
   * The team car: refills its own slot and the other one if empty, from the Rumble pool without
   * the team car (seeded by the ride and the visit, so the same ride gives the same items).
   */
  #teamCar(slot: number): boolean {
    const pool = this.config.itemPool.filter((k) => k !== 'teamCar');
    const from = pool.length > 0 ? pool : RUMBLE_POOL.filter((k) => k !== 'teamCar');
    const kinds: PowerUpKind[] = [];
    const visit = this.#supplies++;
    for (const i of [slot, ...this.#slots.keys()]) {
      if (this.#slots[i] !== null) continue;
      const kind = kindFor(this.seed, visit * 2 + kinds.length, from, 'teamCar');
      this.#slots[i] = kind;
      kinds.push(kind);
    }
    this.#picked += kinds.length;
    this.#supply = { seq: (this.#supply?.seq ?? 0) + 1, kinds };
    this.#emit('supplied', 'teamCar');
    return true;
  }

  /** Plain, serialisable state for the UI, the overlay and the network. */
  toLive(): PowerUpLive {
    const t = this.#last;
    const now = t?.elapsedS ?? 0;
    const effect = this.#mode === 'rumble' ? this.#boostEffects()[0] : this.#effects[0];
    const ch = this.#challenge;
    const rules = this.config.challenge;
    const effectLive: PowerUpEffectLive | null = effect
      ? {
          kind: effect.kind,
          phase: effect.phase,
          remainingS: Math.max(0, effect.untilS - now),
          durationS: effect.durationS,
        }
      : null;
    const challengeLive: PowerUpChallengeLive | null = ch
      ? {
          phase: ch.phase,
          targetW: ch.targetW,
          holdS: rules.holdS,
          heldS: ch.heldS,
          remainingS:
            ch.phase === 'offered'
              ? Math.max(0, ch.offerUntilS - now)
              : Math.max(0, rules.holdS - ch.heldS),
          powerW: Math.round(t?.power3sW ?? 0),
        }
      : null;
    const hand = this.hand;
    return {
      blocked: t?.blocked ?? null,
      held: hand[0] ?? null,
      hand: [...hand],
      capacity: this.#capacity(),
      canActivate: this.canActivate,
      effect: effectLive,
      challenge: challengeLive,
      upcoming: [...this.#upcoming],
      raceOffsetM: Math.round(this.raceOffsetM * 10) / 10,
      picked: this.#picked,
      used: this.#used,
      event: this.#event,
      ...(this.#mode === 'rumble' ? { rumble: this.#rumbleLive(now) } : {}),
    };
  }

  // ───── internals ─────

  #rumbleLive(now: number): RumbleLive {
    const attack = this.#effects.find((e) => e.role === 'attack');
    const cape = this.#effects.find((e) => e.role === 'guard');
    const protecting = !attack && now < this.#protectedUntilS;
    return {
      slots: [...this.#slots],
      slotNotes: this.#slots.map((k, i) => (k === null ? null : this.playNote(i))),
      slotTargets: this.#slots.map(() => null),
      hit: attack
        ? {
            kind: attack.kind,
            by: attack.source,
            remainingS: Math.max(0, attack.untilS - now),
            durationS: attack.durationS,
            ...(attack.repair
              ? {
                  repair: {
                    remainingS: Math.max(0, attack.repair.untilS - now),
                    durationS: attack.repair.untilS - attack.repair.fromS,
                  },
                }
              : {}),
          }
        : null,
      cape: cape ? { remainingS: Math.max(0, cape.untilS - now), durationS: cape.durationS } : null,
      protection: protecting
        ? {
            remainingS: Math.max(0, this.#protectedUntilS - now),
            durationS: this.config.protectionS,
          }
        : null,
      immuneS: Math.max(0, this.#protectedUntilS - now),
      gainM: Math.round(this.gainM * 10) / 10,
      lossM: Math.round(this.lossM * 10) / 10,
      incoming: this.#incoming,
      outgoing: this.#outgoing,
      puddles: [],
      rough: [],
      terrain: this.#terrain && this.#last?.blocked === null ? { ...this.#terrain } : null,
      supply: this.#supply,
    };
  }

  #capacity(): number {
    return this.#mode === 'rumble' ? RUMBLE_CAPACITY : this.config.capacity;
  }

  #pool(): readonly PowerUpKind[] {
    return this.#mode === 'rumble' ? this.config.itemPool : this.config.pool;
  }

  #handCount(): number {
    return this.#slots.reduce((n, k) => n + (k === null ? 0 : 1), 0);
  }

  #boostEffects(): Effect[] {
    return this.#effects.filter((e) => e.role === 'boost');
  }

  /** Puts an item into the first empty slot (left first). False when both are full. */
  #put(kind: PowerUpKind): boolean {
    const free = this.#slots.indexOf(null);
    if (free < 0) return false;
    this.#slots[free] = kind;
    return true;
  }

  /** A normal ride keeps its items packed to the front (index = order of pick-up). */
  #compact(): void {
    const held = this.hand;
    this.#slots = this.#slots.map((_, i) => held[i] ?? null);
  }

  #emit(type: PowerUpEventType, kind?: PowerUpKind): void {
    this.#seq += 1;
    this.#event = { seq: this.#seq, type, ...(kind ? { kind } : {}) };
  }

  #removeEffect(e: Effect): void {
    this.#effects = this.#effects.filter((x) => x !== e);
  }

  /** Indices of the spots passed between two positions; none across a jump. */
  #crossed(prev: number, cur: number): number[] {
    const track = this.#track;
    let delta = cur - prev;
    if (track?.loop && delta < -track.lengthM / 2) delta += track.lengthM;
    if (delta <= 0 || delta > MAX_STEP_M) return [];
    const out: number[] = [];
    if (track?.loop && prev + delta >= track.lengthM) {
      // Across the finish line of a loop: the end of this lap and the start of the next.
      this.#spots.forEach((s, i) => {
        if (s > prev || s <= cur) out.push(i);
      });
      return out;
    }
    this.#spots.forEach((s, i) => {
      if (s > prev && s <= cur) out.push(i);
    });
    return out;
  }

  #extendFreeSpots(cur: number): void {
    const last = this.#spots.at(-1) ?? 0;
    if (cur + this.config.lookAheadM * 2 < last) return;
    this.#spots = freeRideSpots(this.seed, this.#spots.length * 2, this.config.spacing);
  }

  /** Spots ahead of `coord` within lookAheadM, metres ahead, nearest first. */
  #ahead(coord: number): number[] {
    const look = this.config.lookAheadM;
    const track = this.#track;
    const out: number[] = [];
    for (const s of this.#spots) {
      let d = s - coord;
      if (track?.loop && d <= 0) d += track.lengthM;
      if (d > 0 && d <= look) out.push(Math.round(d * 10) / 10);
    }
    return out.sort((a, b) => a - b);
  }

  /** Whole seconds of riding into buckets (power and gradient averaged over the second). */
  #collect(dt: number, t: PowerUpTick): void {
    let left = dt;
    while (left > 1e-9) {
      const b = this.#bucket;
      const slice = Math.min(left, 1 - b.timeS);
      b.energyJ += t.powerW * slice;
      b.gradeS += t.gradePercent * slice;
      b.timeS += slice;
      b.erg = b.erg || t.blocked === 'erg' || t.blocked === 'ftpTest';
      left -= slice;
      if (b.timeS >= 1 - 1e-9) {
        this.#buckets.push({ powerW: b.energyJ, gradePercent: b.gradeS, erg: b.erg });
        this.#bucket = { energyJ: 0, gradeS: 0, timeS: 0, erg: false };
        const keep = this.config.challenge.recentS + this.config.challenge.baselineS + 2;
        if (this.#buckets.length > keep) this.#buckets.splice(0, this.#buckets.length - keep);
      }
    }
  }

  /** Averages of the two challenge windows, or null while they are not full. */
  windows(): { recentW: number; baselineW: number; recentGrade: number; erg: boolean } | null {
    const r = this.config.challenge;
    const n = this.#buckets.length;
    if (n < r.recentS + r.baselineS) return null;
    const recent = this.#buckets.slice(n - r.recentS);
    const base = this.#buckets.slice(n - r.recentS - r.baselineS, n - r.recentS);
    const avg = (xs: Bucket[], f: (b: Bucket) => number): number =>
      xs.reduce((a, b) => a + f(b), 0) / Math.max(1, xs.length);
    return {
      recentW: avg(recent, (b) => b.powerW),
      baselineW: avg(base, (b) => b.powerW),
      recentGrade: avg(recent, (b) => b.gradePercent),
      erg: recent.some((b) => b.erg) || base.some((b) => b.erg),
    };
  }

  #mayOffer(t: PowerUpTick): boolean {
    const r = this.config.challenge;
    if (!t.challenges || t.blocked !== null || t.state !== 'riding') return false;
    if (t.elapsedS < r.notBeforeS) return false;
    if (t.elapsedS - this.#lastOfferS < r.cooldownS) return false;
    if (this.#mode === 'normal') {
      if (this.#handCount() > 0 || this.#effects.length > 0) return false;
    } else if (this.#handCount() >= this.#capacity() || this.#boostEffects().length > 0) {
      return false;
    }
    if (t.gradePercent <= r.descentGradePercent) return false;
    const w = this.windows();
    if (!w || w.erg) return false;
    if (w.recentGrade <= r.descentAverageGradePercent) return false;
    if (w.recentW < r.minRecentW) return false;
    return w.recentW <= (1 - r.dropFraction) * w.baselineW;
  }

  /** The hold target (W, multiple of 5), from the recent average and the FTP. */
  #target(ftpW: number): number | null {
    const w = this.windows();
    if (!w) return null;
    const r = this.config.challenge;
    let target = w.recentW * r.targetFactor;
    if (ftpW > 0) target = Math.min(target, ftpW * r.ftpCap);
    target = Math.max(target, w.recentW * r.minFactor);
    return Math.max(5, Math.round(target / 5) * 5);
  }

  #runChallenge(
    t: PowerUpTick,
    dt: number,
    emit: (type: PowerUpEventType, kind?: PowerUpKind) => void,
  ): void {
    const ch = this.#challenge!;
    const r = this.config.challenge;
    if (t.blocked !== null || !t.challenges) {
      this.#challenge = null;
      emit('challenge-ended');
      return;
    }
    if (t.state !== 'riding' || dt <= 0) return;
    const holding = t.power3sW >= ch.targetW * r.tolerance;
    if (ch.phase === 'offered') {
      if (holding) {
        ch.phase = 'holding';
        ch.heldS = 0;
        ch.belowS = 0;
      } else if (t.elapsedS >= ch.offerUntilS) {
        this.#challenge = null;
        emit('challenge-ended');
      }
      return;
    }
    if (holding) {
      ch.heldS += dt;
      ch.belowS = 0;
    } else {
      ch.belowS += dt;
      if (ch.belowS > r.graceS) {
        this.#challenge = null;
        emit('challenge-failed');
        return;
      }
    }
    if (ch.heldS >= r.holdS) {
      this.#challenge = null;
      const kind = kindFor(this.seed, this.#challengeCount++, this.#pool(), 'challenge');
      if (this.grant(kind)) {
        this.#picked += 1;
        emit('challenge-won', kind);
      }
    }
  }
}
