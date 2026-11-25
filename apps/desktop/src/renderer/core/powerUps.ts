/**
 * The power-up engine (docs/power-ups.md, docs/adr/0006-power-ups.md): pure and deterministic,
 * no timers and no DOM. The ride controller calls `update()` once per tick with the ride's
 * time, distance and power; everything else follows from that and from a seed.
 *
 * - **Pick-ups:** spots every `spacing` metres, drawn from a seeded generator — on a route at
 *   fixed route positions (seed = route id, so every rider on that route meets the same spots),
 *   in a free ride along the ridden distance (seed = ride id). Riding through a spot adds a card
 *   to the hand when there is room; otherwise it is skipped ("already holding").
 * - **Effort challenges:** when the power has clearly dropped (see `ChallengeRules`), a short
 *   hold is offered; holding it grants a card. Ignoring or failing it does nothing.
 * - **Effects** change only the *race position*: a shadow copy of the virtual bike is integrated
 *   with the effect's modifiers (less drag, less mass …) next to the real one, and the
 *   difference in distance is the race offset. The recorded ride (speed, distance, FIT, points,
 *   bests) never sees it; `stepBike` itself is unchanged.
 *
 * Extension points for a battle mode (ADR 0006): more kinds (POWER_UP_DEFINITIONS), a larger
 * hand (`capacity`), `activate(index)`, `grant()` from other sources, `applyEffect()` for
 * effects another rider sends, `target` on a definition, and `toLive()` as the wire format.
 *
 * **Card Race** (docs/card-race.md, ADR 0007) uses them: `setMode('cardRace')` gives a hand of
 * two fixed slots (left/right button), a pool with attacks and a shield, `receiveAttack()` for
 * an attack another rider aimed at this one (the effect is applied here, to this rider only),
 * a protection window after every hit, and a second shadow bike for attacks, so the race offset
 * splits into a gain from own cards (≥ 0) and a loss to attacks (≤ 0). Only in Card Race can the
 * offset be negative; a normal ride is exactly as before.
 */
import type { BikeParams } from '@freilauf/sim';
import { stepBike } from '@freilauf/sim';
import type {
  AttackResult,
  CardRaceLive,
  GroupMode,
  IncomingAttackLive,
  OutgoingAttackLive,
  PowerUpBlock,
  PowerUpChallengeLive,
  PowerUpEffectLive,
  PowerUpEventLive,
  PowerUpEventType,
  PowerUpKind,
  PowerUpLive,
} from '../../shared/powerUps';
import { CARD_KINDS, POWER_UP_KINDS } from '../../shared/powerUps';

// ───────────── effects ─────────────

/** Factors applied to the shadow bike while an effect acts (1 = unchanged). */
export interface EffectModifiers {
  /** × CdA: air resistance. */
  dragFactor: number;
  /** × total mass: gravity on climbs, rolling resistance and inertia. */
  massFactor: number;
  /** × Crr: rolling resistance. */
  rollingFactor: number;
}

export const NO_MODIFIERS: Readonly<EffectModifiers> = Object.freeze({
  dragFactor: 1,
  massFactor: 1,
  rollingFactor: 1,
});

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
   * Who the effect acts on: 'self', or (Card Race attacks) the rider directly ahead ('ahead')
   * or the leader ('leader'). Attacks are sent over the group and applied by the target to
   * itself (`receiveAttack`); nobody changes another rider's numbers.
   */
  target: 'self' | 'ahead' | 'leader';
  /**
   * 'boost' helps this rider (its gain is the "+ m from cards"), 'attack' slows the target (the
   * "− m from attacks"), 'guard' is the shield (no modifiers; it blocks the next attack).
   */
  role: 'boost' | 'attack' | 'guard';
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
    modifiers: () => ({ dragFactor: 0.6, massFactor: 1, rollingFactor: 1 }),
  },
  /** 12 % less mass for 25 s, applied uphill only (downhill less mass would slow the bike). */
  lightLoad: {
    kind: 'lightLoad',
    durationS: 25,
    target: 'self',
    role: 'boost',
    modifiers: (c) =>
      c.gradePercent > 0.5 ? { dragFactor: 1, massFactor: 0.88, rollingFactor: 1 } : NO_MODIFIERS,
  },
  /** Moderate and long: 25 % less air resistance for 30 s, like sitting in a wheel. */
  slipstream: {
    kind: 'slipstream',
    durationS: 30,
    target: 'self',
    role: 'boost',
    modifiers: () => ({ dragFactor: 0.75, massFactor: 1, rollingFactor: 1 }),
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
    modifiers: () => ({ dragFactor: 0.7, massFactor: 1, rollingFactor: 0.5 }),
  },
  /**
   * Card Race attack on the rider directly ahead: 60 % more air resistance for 10 s. At 200 W
   * on the flat that costs the target about 15 m of race position (less than a Tailwind gains);
   * on a climb, where air matters little, hardly anything.
   */
  headwind: {
    kind: 'headwind',
    durationS: 10,
    target: 'ahead',
    role: 'attack',
    modifiers: () => ({ dragFactor: 1.6, massFactor: 1, rollingFactor: 1 }),
  },
  /**
   * Card Race attack on the leader: for 12 s their gaps to the others show as "?" (their own
   * group list, overlay and scene labels). No physics at all.
   */
  fog: {
    kind: 'fog',
    durationS: 12,
    target: 'leader',
    role: 'attack',
    modifiers: () => NO_MODIFIERS,
  },
  /** Card Race: raised when played, it blocks the next attack within 60 s, then it is gone. */
  shield: {
    kind: 'shield',
    durationS: 60,
    target: 'self',
    role: 'guard',
    modifiers: () => NO_MODIFIERS,
  },
};

/** After any hit (or a blocked attack) no attack lands on that rider for this long, s. */
export const PROTECTION_S = 15;
/** Cards a Card Race hand holds: one per side button. */
export const CARD_RACE_CAPACITY = 2;
/**
 * What a pick-up or challenge gives in a Card Race: every card, boosts most often (a pool entry
 * per chance). Four boosts × 2, Headwind × 2, Shield × 2, Fog × 1: 8 of 13 help yourself.
 */
export const CARD_RACE_POOL: readonly PowerUpKind[] = [
  'tailwind',
  'tailwind',
  'slipstream',
  'slipstream',
  'lightLoad',
  'lightLoad',
  'downhill',
  'downhill',
  'headwind',
  'headwind',
  'shield',
  'shield',
  'fog',
];

/** Several effects at once multiply (only one at a time for now; see `maxEffects`). */
export function combineModifiers(list: readonly EffectModifiers[]): EffectModifiers {
  const out = { ...NO_MODIFIERS };
  for (const m of list) {
    out.dragFactor *= m.dragFactor;
    out.massFactor *= m.massFactor;
    out.rollingFactor *= m.rollingFactor;
  }
  return out;
}

export function isNoModifier(m: EffectModifiers): boolean {
  return m.dragFactor === 1 && m.massFactor === 1 && m.rollingFactor === 1;
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
  /** Cards the hand holds. */
  capacity: number;
  /** Effects at once. */
  maxEffects: number;
  /** Kinds a pick-up or challenge can give. */
  pool: readonly PowerUpKind[];
  /** The same in a Card Race (entries may repeat: weights). */
  cardPool: readonly PowerUpKind[];
  /** Card Race: seconds of protection after a hit. */
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
  cardPool: CARD_RACE_POOL,
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
  /** Card Race: only these cards (any of CARD_KINDS). */
  cardPool?: PowerUpKind[];
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
  const cardPool = t.cardPool;
  if (Array.isArray(cardPool)) {
    const kinds = CARD_KINDS.filter((k) => cardPool.includes(k));
    if (kinds.length > 0) config.cardPool = kinds;
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
  /** Where it came from: 'self' (used a card) or, for an attack, the attacker's name. */
  source: string;
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
  /** 'normal' (default) or 'cardRace'; can change during the ride (`setMode`). */
  mode?: GroupMode;
}

/** What `receiveAttack` made of an attack (the target's answer). */
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
      t.powerW,
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
  /** Own cards (and, in a normal ride, all power-ups): the race gain, ≥ 0. */
  readonly #boost = new Shadow(1);
  /** Card Race attacks on this rider: the race loss, ≤ 0. */
  readonly #attack = new Shadow(-1, true);
  /** Card Race: no attack lands before this ride time (s). */
  #protectedUntilS = Number.NEGATIVE_INFINITY;
  #incoming: IncomingAttackLive | null = null;
  #outgoing: OutgoingAttackLive | null = null;
  #attackSeq = 0;
  #picked = 0;
  #used = 0;
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

  /** Held cards, first (left) first. */
  get hand(): readonly PowerUpKind[] {
    return this.#slots.filter((k): k is PowerUpKind => k !== null);
  }

  /** The hand as slots (Card Race: [left, right]); null = empty. */
  get slots(): readonly (PowerUpKind | null)[] {
    return this.#slots;
  }

  get mode(): GroupMode {
    return this.#mode;
  }

  /** Race position − recorded position, m. Negative only in a Card Race (attacks). */
  get raceOffsetM(): number {
    const total = this.#boost.offsetM + this.#attack.offsetM;
    // "Power-ups only help": a normal ride never places a rider behind their own legs.
    return this.#mode === 'normal' ? Math.max(0, total) : total;
  }

  /** Metres gained from own cards / power-ups (≥ 0). */
  get gainM(): number {
    return this.#boost.offsetM;
  }

  /** Metres lost to attacks (≤ 0; always 0 in a normal ride). */
  get lossM(): number {
    return this.#attack.offsetM;
  }

  /**
   * Switches between a normal ride and a Card Race (the host's choice; may change mid-ride).
   * To Card Race: a second slot. Back to normal: one slot, the first boost held stays (attack
   * cards and the shield have no use there), attacks and the shield end, the loss to attacks
   * is dropped (a normal ride never places anyone behind their own riding).
   */
  setMode(mode: GroupMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    const held = this.hand;
    if (mode === 'normal') {
      const keep = held.find((k) => POWER_UP_DEFINITIONS[k].role === 'boost') ?? null;
      this.#slots = [keep];
      for (const e of this.#effects.filter((x) => x.role !== 'boost')) this.#removeEffect(e);
      this.#attack.offsetM = 0;
      this.#attack.speedMps = this.#boost.speedMps;
      this.#protectedUntilS = Number.NEGATIVE_INFINITY;
      this.#incoming = null;
      this.#outgoing = null;
    } else {
      this.#slots = [
        ...this.#slots,
        ...Array.from({ length: CARD_RACE_CAPACITY }, () => null),
      ].slice(0, CARD_RACE_CAPACITY);
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
      if (this.#mode === 'cardRace') this.#attack.step(t, dt, realDeltaM, mods('attack'));
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
          const kind = kindFor(this.seed, index, this.#pool());
          if (this.#put(kind)) {
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

  /** True when `activate()` would use a card now (Card Race: any card of the hand). */
  get canActivate(): boolean {
    if (this.#mode === 'cardRace') return this.#slots.some((_, i) => this.canPlay(i));
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
   * Card Race: whether the card in `slot` can be played now, as far as this rider can tell (an
   * attack also needs a target, which the controller resolves).
   */
  canPlay(slot: number): boolean {
    return this.playNote(slot) === null;
  }

  /** Card Race: why the card in `slot` cannot be played now, in a few words (null: it can). */
  playNote(slot: number): string | null {
    const kind = this.#slots[slot];
    const t = this.#last;
    if (kind === undefined || kind === null) return 'Empty';
    if (!t || t.state !== 'riding') return 'Resume the ride to play it';
    if (t.blocked === 'erg') return 'Kept for later · not in ERG steps';
    if (t.blocked === 'ftpTest') return 'Kept for later · not in FTP tests';
    if (t.blocked !== null) return 'Cards are off';
    const role = POWER_UP_DEFINITIONS[kind].role;
    if (role === 'boost' && this.#boostEffects().length > 0) return 'After your boost';
    if (role === 'guard' && this.#effects.some((e) => e.role === 'guard')) return 'Shield is up';
    return null;
  }

  /**
   * Uses the card at `index` (the first by default): a power-up or (Card Race) a boost or the
   * shield. In a Card Race `index` is the slot (0 left, 1 right). Returns false (and keeps the
   * card) when none is held, the ride is not running, power-ups are blocked, an effect of the
   * same sort still acts, or the card is an attack (see `spendCard`).
   */
  activate(index = 0): boolean {
    if (this.#mode === 'cardRace') {
      const kind = this.#slots[index];
      if (!kind || POWER_UP_DEFINITIONS[kind].role === 'attack' || !this.canPlay(index)) {
        return false;
      }
      this.#slots[index] = null;
      this.#used += 1;
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
   * Card Race: takes the attack card in `slot` out of the hand to play it (the controller has
   * found its target and sends it). Null when the slot holds no attack or it cannot be played.
   */
  spendCard(slot: number): PowerUpKind | null {
    const kind = this.#slots[slot];
    if (this.#mode !== 'cardRace' || !kind || POWER_UP_DEFINITIONS[kind].role !== 'attack') {
      return null;
    }
    if (!this.canPlay(slot)) return null;
    this.#slots[slot] = null;
    this.#used += 1;
    this.#emit('played', kind);
    return kind;
  }

  /**
   * Card Race: an attack card played by this rider could not land (target protected, gone, not
   * in the race, no answer): it goes back into the hand if there is room.
   */
  returnCard(kind: PowerUpKind): boolean {
    if (!this.#put(kind)) return false;
    this.#used = Math.max(0, this.#used - 1);
    this.#emit('returned', kind);
    return true;
  }

  /** Card Race: notes what became of an attack this rider played (for the notice). */
  noteOutgoing(kind: PowerUpKind, target: string, result: OutgoingAttackLive['result']): void {
    this.#attackSeq += 1;
    this.#outgoing = { seq: this.#attackSeq, kind, target, result };
  }

  /**
   * Card Race: another rider aimed attack `kind` at this one. Applied here, to this rider only,
   * at most one attack at a time:
   * - not riding, blocked (ERG, FTP test, off) or not in a Card Race → 'unavailable';
   * - under an attack, or within the protection after one → 'protected';
   * - shield up → the shield is used up, protection starts → 'blocked';
   * - otherwise the effect starts, and protection runs until `protectionS` after it ends → 'hit'.
   * The caller (the group link) guarantees each attack arrives here once.
   */
  receiveAttack(kind: PowerUpKind, by: string): AttackOutcome {
    const t = this.#last;
    const def = POWER_UP_DEFINITIONS[kind];
    let result: AttackOutcome;
    if (!t || this.#mode !== 'cardRace' || !def || def.role !== 'attack') result = 'unavailable';
    else if (t.state !== 'riding' || t.blocked !== null) result = 'unavailable';
    else if (this.#effects.some((e) => e.role === 'attack') || t.elapsedS < this.#protectedUntilS) {
      result = 'protected';
    } else {
      const shield = this.#effects.find((e) => e.role === 'guard');
      if (shield) {
        this.#removeEffect(shield);
        this.#protectedUntilS = t.elapsedS + this.config.protectionS;
        this.#emit('blocked', kind);
        result = 'blocked';
      } else {
        const untilS = t.elapsedS + def.durationS;
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
   * Starts an effect without a card (an effect from elsewhere). Armed kinds are armed; the rest
   * start at once. Returns false when no effect slot is free or power-ups are blocked. In a
   * Card Race boosts, the shield and attacks each have their own slot; attacks arrive through
   * `receiveAttack` instead (protection, shield).
   */
  applyEffect(kind: PowerUpKind, source = 'self'): boolean {
    const t = this.#last;
    if (!t || t.blocked !== null) return false;
    const def = POWER_UP_DEFINITIONS[kind];
    if (this.#mode === 'cardRace') {
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

  /** Adds a card from elsewhere (a challenge here; e.g. a battle reward later). */
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

  /** Plain, serialisable state for the UI, the overlay and the network. */
  toLive(): PowerUpLive {
    const t = this.#last;
    const now = t?.elapsedS ?? 0;
    const effect = this.#mode === 'cardRace' ? this.#boostEffects()[0] : this.#effects[0];
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
      ...(this.#mode === 'cardRace' ? { cards: this.#cardsLive(now) } : {}),
    };
  }

  // ───── internals ─────

  #cardsLive(now: number): CardRaceLive {
    const attack = this.#effects.find((e) => e.role === 'attack');
    const shield = this.#effects.find((e) => e.role === 'guard');
    const protecting = !attack && now < this.#protectedUntilS;
    return {
      slots: [...this.#slots],
      slotNotes: this.#slots.map((k, i) => (k === null ? null : this.playNote(i))),
      slotTargets: this.#slots.map(() => null),
      attack: attack
        ? {
            kind: attack.kind,
            by: attack.source,
            remainingS: Math.max(0, attack.untilS - now),
            durationS: attack.durationS,
          }
        : null,
      shield: shield
        ? { remainingS: Math.max(0, shield.untilS - now), durationS: shield.durationS }
        : null,
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
    };
  }

  #capacity(): number {
    return this.#mode === 'cardRace' ? CARD_RACE_CAPACITY : this.config.capacity;
  }

  #pool(): readonly PowerUpKind[] {
    return this.#mode === 'cardRace' ? this.config.cardPool : this.config.pool;
  }

  #handCount(): number {
    return this.#slots.reduce((n, k) => n + (k === null ? 0 : 1), 0);
  }

  #boostEffects(): Effect[] {
    return this.#effects.filter((e) => e.role === 'boost');
  }

  /** Puts a card into the first empty slot (left first). False when the hand is full. */
  #put(kind: PowerUpKind): boolean {
    const free = this.#slots.indexOf(null);
    if (free < 0) return false;
    this.#slots[free] = kind;
    return true;
  }

  /** A normal ride keeps its cards packed to the front (index = order of pick-up). */
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
