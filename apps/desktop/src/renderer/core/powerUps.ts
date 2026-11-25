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
 */
import type { BikeParams } from '@freilauf/sim';
import { stepBike } from '@freilauf/sim';
import type {
  PowerUpBlock,
  PowerUpChallengeLive,
  PowerUpEffectLive,
  PowerUpEventLive,
  PowerUpEventType,
  PowerUpKind,
  PowerUpLive,
} from '../../shared/powerUps';
import { POWER_UP_KINDS } from '../../shared/powerUps';

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
   * Who the effect acts on. Only 'self' exists so far; the battle mode adds kinds that act on
   * another rider (they would be sent over the group and arrive there via `applyEffect`).
   */
  target: 'self';
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
    modifiers: () => ({ dragFactor: 0.6, massFactor: 1, rollingFactor: 1 }),
  },
  /** 12 % less mass for 25 s, applied uphill only (downhill less mass would slow the bike). */
  lightLoad: {
    kind: 'lightLoad',
    durationS: 25,
    target: 'self',
    modifiers: (c) =>
      c.gradePercent > 0.5 ? { dragFactor: 1, massFactor: 0.88, rollingFactor: 1 } : NO_MODIFIERS,
  },
  /** Moderate and long: 25 % less air resistance for 30 s, like sitting in a wheel. */
  slipstream: {
    kind: 'slipstream',
    durationS: 30,
    target: 'self',
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
    modifiers: () => ({ dragFactor: 0.7, massFactor: 1, rollingFactor: 0.5 }),
  },
};

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
  phase: 'armed' | 'active';
  /** Armed: when it expires; active: when it ends (ride time, s). */
  untilS: number;
  durationS: number;
  /** Where it came from: 'self' (used a card) or e.g. a rider id in a battle. */
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
}

/** How far a position may move in one tick and still count as riding through (not a jump). */
const MAX_STEP_M = 80;
/** Below this speed difference the shadow bike rejoins the real one (no drift). */
const REJOIN_MPS = 0.01;

export class PowerUpEngine {
  readonly seed: string;
  readonly config: PowerUpConfig;
  readonly #track: PowerUpTrack | null;
  /** Route spots (route m) or free-ride spots (ridden m), ascending. */
  #spots: number[];
  #hand: PowerUpKind[] = [];
  #effects: Effect[] = [];
  #challenge: Challenge | null = null;
  #lastOfferS = Number.NEGATIVE_INFINITY;
  #challengeCount = 0;
  #buckets: Bucket[] = [];
  #bucket = { energyJ: 0, gradeS: 0, timeS: 0, erg: false };
  #lastElapsedS: number | null = null;
  #lastDistanceM = 0;
  #lastCoord: number | null = null;
  #shadowSpeedMps = 0;
  #raceOffsetM = 0;
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
  }

  /** Pick-up spots: route metres on a route, ridden metres in a free ride (the first few). */
  get spots(): readonly number[] {
    return this.#spots;
  }

  get hand(): readonly PowerUpKind[] {
    return this.#hand;
  }

  get raceOffsetM(): number {
    return this.#raceOffsetM;
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

    // ── race position: the shadow bike with the effects, next to the real one ──
    if (riding && dt > 0) {
      const mods = combineModifiers(
        this.#effects
          .filter((e) => e.phase === 'active')
          .map((e) => POWER_UP_DEFINITIONS[e.kind].modifiers(ctx)),
      );
      if (isNoModifier(mods) && Math.abs(this.#shadowSpeedMps - t.speedMps) < REJOIN_MPS) {
        this.#shadowSpeedMps = t.speedMps;
      } else {
        const step = stepBike(
          this.#shadowSpeedMps,
          t.powerW,
          t.gradePercent,
          modifiedBike(t.bike, mods),
          dt,
          t.brake,
        );
        this.#shadowSpeedMps = step.speedMps;
        this.#raceOffsetM = Math.max(0, this.#raceOffsetM + step.distanceM - realDeltaM);
      }
    } else if (!riding) {
      this.#shadowSpeedMps = 0;
    }

    // ── pick-ups ──
    const coord = this.#track ? t.routeM : t.distanceM;
    if (coord !== null && Number.isFinite(coord)) {
      if (!this.#track) this.#extendFreeSpots(coord);
      const prev = this.#lastCoord;
      if (prev !== null && riding && t.blocked === null) {
        for (const index of this.#crossed(prev, coord)) {
          const kind = kindFor(this.seed, index, this.config.pool);
          if (this.#hand.length < this.config.capacity) {
            this.#hand.push(kind);
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

  /** True when `activate()` would use a card now. */
  get canActivate(): boolean {
    const t = this.#last;
    return (
      this.#hand.length > 0 &&
      t !== null &&
      t.state === 'riding' &&
      t.blocked === null &&
      this.#effects.length < this.config.maxEffects
    );
  }

  /**
   * Uses the card at `index` (the first by default). Returns false (and keeps the card) when
   * none is held, the ride is not running, power-ups are blocked or an effect still acts.
   */
  activate(index = 0): boolean {
    const kind = this.#hand[index];
    if (kind === undefined || !this.canActivate) return false;
    this.#hand.splice(index, 1);
    this.#used += 1;
    this.#emit('activated', kind);
    this.applyEffect(kind, 'self');
    return true;
  }

  /**
   * Starts an effect without a card (extension point: an effect another rider sends in a
   * battle). Armed kinds are armed; the rest start at once. Returns false when no effect slot
   * is free or power-ups are blocked.
   */
  applyEffect(kind: PowerUpKind, source = 'self'): boolean {
    const t = this.#last;
    if (!t || t.blocked !== null || this.#effects.length >= this.config.maxEffects) return false;
    const def = POWER_UP_DEFINITIONS[kind];
    if (def.armedS !== undefined) {
      this.#effects.push({
        kind,
        phase: 'armed',
        untilS: t.elapsedS + def.armedS,
        durationS: def.armedS,
        source,
      });
    } else {
      this.#effects.push({
        kind,
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
    if (this.#hand.length >= this.config.capacity) {
      this.#emit('skipped', kind);
      return false;
    }
    this.#hand.push(kind);
    return true;
  }

  /** The rider waved the challenge away. */
  dismissChallenge(): boolean {
    if (!this.#challenge) return false;
    this.#challenge = null;
    this.#emit('challenge-ended');
    return true;
  }

  /** Plain, serialisable state for the UI, the overlay and (later) the network. */
  toLive(): PowerUpLive {
    const t = this.#last;
    const now = t?.elapsedS ?? 0;
    const effect = this.#effects[0];
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
    return {
      blocked: t?.blocked ?? null,
      held: this.#hand[0] ?? null,
      hand: [...this.#hand],
      capacity: this.config.capacity,
      canActivate: this.canActivate,
      effect: effectLive,
      challenge: challengeLive,
      upcoming: [...this.#upcoming],
      raceOffsetM: Math.round(this.#raceOffsetM * 10) / 10,
      picked: this.#picked,
      used: this.#used,
      event: this.#event,
    };
  }

  // ───── internals ─────

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
    if (this.#hand.length > 0 || this.#effects.length > 0) return false;
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
      const kind = kindFor(this.seed, this.#challengeCount++, this.config.pool, 'challenge');
      if (this.grant(kind)) {
        this.#picked += 1;
        emit('challenge-won', kind);
      }
    }
  }
}
