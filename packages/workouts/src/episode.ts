/**
 * "Workout fitted to the episode": a deterministic generator that fills an exact length of time
 * (an episode of a series, a film) with warm-up, a main part shaped by a pattern and an effort,
 * and a cool-down that ends with the episode, plus "hard now", which inserts a hard block at the
 * current position and re-fits the rest so the total length and the cool-down stay as they were.
 *
 * Pure: no clock, no randomness. The same options give the same workout, byte for byte.
 * Every step is a `steady` or `ramp` step (whole seconds), so the result runs through the normal
 * timeline / runner / ERG path like any other workout. All powers are FTP fractions.
 */
import type { RampStep, SteadyStep, Workout } from './model';

export type EpisodeEffort = 'easy' | 'medium' | 'hard';
/**
 * - `early`: the hard parts in the first half of the main part;
 * - `spread`: hard parts evenly over the main part;
 * - `finale`: endurance first, then hard parts that get harder up to the cool-down;
 * - `steady`: zone 2 only, no intervals.
 */
export type EpisodePattern = 'early' | 'spread' | 'finale' | 'steady';

export interface EpisodeOptions {
  /** Whole minutes, EPISODE_MIN_LENGTH_MIN … EPISODE_MAX_LENGTH_MIN. */
  lengthMin: number;
  effort: EpisodeEffort;
  pattern: EpisodePattern;
}

/** What a step of an episode workout is for (one entry per workout step). */
export type EpisodeBlockKind =
  | 'warmup'
  | 'endurance'
  | 'hard'
  | 'recovery'
  | 'cooldown'
  /** Inserted by "hard now". */
  | 'hardNow';

export interface EpisodePlan {
  options: EpisodeOptions;
  workout: Workout;
  /** Parallel to `workout.steps`. */
  blocks: EpisodeBlockKind[];
  /** = options.lengthMin × 60, always equal to the workout's total duration. */
  totalDurationS: number;
  /** How often "hard now" was applied. */
  hardNowCount: number;
}

export const EPISODE_MIN_LENGTH_MIN = 10;
export const EPISODE_MAX_LENGTH_MIN = 180;
/** Typical episode / film lengths offered as presets. */
export const EPISODE_PRESETS_MIN = [22, 42, 55, 90] as const;
export const EPISODE_EFFORTS: readonly EpisodeEffort[] = ['easy', 'medium', 'hard'];
export const EPISODE_PATTERNS: readonly EpisodePattern[] = ['early', 'spread', 'finale', 'steady'];
export const DEFAULT_EPISODE_OPTIONS: EpisodeOptions = {
  lengthMin: 42,
  effort: 'medium',
  pattern: 'spread',
};

/** Warm-up ≈ 10 % of the episode (whole 30 s), at least 3 min. */
export const EPISODE_WARMUP_SHARE = 0.1;
export const EPISODE_MIN_WARMUP_S = 180;
/** Cool-down ≈ 8 % of the episode (whole 30 s), at least 2 min: the easy spin falls on the credits. */
export const EPISODE_COOLDOWN_SHARE = 0.08;
export const EPISODE_MIN_COOLDOWN_S = 120;

/** "Hard now": this long at `hardNow` of the effort, then `HARD_NOW_RECOVERY_S` easy. */
export const HARD_NOW_S = 120;
export const HARD_NOW_RECOVERY_S = 90;
/** A later hard block shortened by "hard now" below this is removed instead. */
export const MIN_HARD_BLOCK_S = 60;
/** Shortest interval on / off when they are scaled down for a short episode. */
export const MIN_INTERVAL_ON_S = 60;
export const MIN_INTERVAL_OFF_S = 60;
/** Spread: endurance between hard parts shorter than this is moved before / after the set. */
export const MIN_SPREAD_GAP_S = 45;

export interface EffortProfile {
  /** Warm-up ramp 0.45 → warmupEnd. */
  warmupEnd: number;
  /** Endurance between the hard parts. */
  endurance: number;
  /** Hard part ("on") target and nominal length. */
  hard: number;
  hardS: number;
  /** Easy part after each hard one ("off"). */
  easy: number;
  easyS: number;
  /** At most this much hard time in one episode (long films do not become VO2max marathons). */
  maxHardTotalS: number;
  /** "Steady" pattern: zone 2 throughout. */
  steady: number;
  /** "Hard now" target. */
  hardNow: number;
  /** Cool-down ramp coolStart → 0.40. */
  coolStart: number;
}

/**
 * The targets per effort (FTP fractions). Easy = tempo, medium = threshold, hard = VO2max-style
 * hard parts; endurance and easy parts in zones 1–2.
 */
export const EPISODE_PROFILES: Record<EpisodeEffort, EffortProfile> = {
  easy: {
    warmupEnd: 0.65,
    endurance: 0.62,
    hard: 0.85,
    hardS: 300,
    easy: 0.55,
    easyS: 180,
    maxHardTotalS: 40 * 60,
    steady: 0.62,
    hardNow: 1.0,
    coolStart: 0.55,
  },
  medium: {
    warmupEnd: 0.7,
    endurance: 0.65,
    hard: 0.95,
    hardS: 240,
    easy: 0.52,
    easyS: 180,
    maxHardTotalS: 32 * 60,
    steady: 0.68,
    hardNow: 1.1,
    coolStart: 0.6,
  },
  hard: {
    warmupEnd: 0.75,
    endurance: 0.68,
    hard: 1.1,
    hardS: 180,
    easy: 0.5,
    easyS: 180,
    maxHardTotalS: 24 * 60,
    steady: 0.72,
    hardNow: 1.2,
    coolStart: 0.6,
  },
};

const WARMUP_START = 0.45;
const COOL_END = 0.4;
/** Finale: the hard parts climb from hard − 0.05 to hard + 0.05. */
const FINALE_SPREAD = 0.05;

const EFFORT_LABEL: Record<EpisodeEffort, string> = {
  easy: 'easy',
  medium: 'medium',
  hard: 'hard',
};
const PATTERN_LABEL: Record<EpisodePattern, string> = {
  early: 'Early',
  spread: 'Spread',
  finale: 'Finale',
  steady: 'Steady',
};

export const EPISODE_ID_PREFIX = 'episode-';

export function isEpisodeWorkoutId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(EPISODE_ID_PREFIX);
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Valid options from anything (missing / invalid parts from `fallback`); never throws. */
export function normalizeEpisodeOptions(
  raw: unknown,
  fallback: EpisodeOptions = DEFAULT_EPISODE_OPTIONS,
): EpisodeOptions {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const len = r['lengthMin'];
  const lengthMin =
    typeof len === 'number' && Number.isFinite(len)
      ? Math.min(EPISODE_MAX_LENGTH_MIN, Math.max(EPISODE_MIN_LENGTH_MIN, Math.round(len)))
      : fallback.lengthMin;
  return {
    lengthMin,
    effort: isOneOf(EPISODE_EFFORTS, r['effort']) ? r['effort'] : fallback.effort,
    pattern: isOneOf(EPISODE_PATTERNS, r['pattern']) ? r['pattern'] : fallback.pattern,
  };
}

const round30 = (s: number): number => Math.round(s / 30) * 30;
const floor15 = (s: number): number => Math.floor(s / 15) * 15;
const round3 = (f: number): number => Math.round(f * 1000) / 1000;

export function episodeWarmupS(totalS: number): number {
  return Math.max(EPISODE_MIN_WARMUP_S, round30(totalS * EPISODE_WARMUP_SHARE));
}

export function episodeCooldownS(totalS: number): number {
  return Math.max(EPISODE_MIN_COOLDOWN_S, round30(totalS * EPISODE_COOLDOWN_SHARE));
}

interface Item {
  kind: EpisodeBlockKind;
  step: SteadyStep | RampStep;
}

const steady = (kind: EpisodeBlockKind, durationS: number, power: number, label: string): Item => ({
  kind,
  step: { kind: 'steady', durationS, power: round3(power), label },
});

const durOf = (i: Item): number => i.step.durationS;

interface Sizing {
  reps: number;
  onS: number;
  offS: number;
}

/**
 * How many hard parts of which length fit into `areaS`. `density` > 1 leaves endurance between
 * them (spread). Below `minReps` at the nominal length, lengths are scaled down (whole 15 s, at
 * least MIN_INTERVAL_ON_S / MIN_INTERVAL_OFF_S) so short episodes still get several.
 */
function sizeIntervals(areaS: number, p: EffortProfile, density: number, minReps: number): Sizing {
  let onS = p.hardS;
  let offS = p.easyS;
  let reps = Math.floor(areaS / ((onS + offS) * density));
  if (reps < minReps) {
    const scale = areaS / (minReps * (onS + offS) * density);
    onS = Math.max(MIN_INTERVAL_ON_S, floor15(p.hardS * scale));
    offS = Math.max(MIN_INTERVAL_OFF_S, floor15(p.easyS * scale));
    reps = Math.floor(areaS / ((onS + offS) * density));
    if (reps < 1 && areaS >= onS + offS) reps = 1;
  }
  reps = Math.max(0, Math.min(reps, Math.floor(p.maxHardTotalS / onS)));
  return { reps, onS, offS };
}

function relabelHard(items: Item[]): void {
  const hard = items.filter((i) => i.kind === 'hard');
  hard.forEach((item, n) => {
    item.step.label = `Hard ${n + 1}/${hard.length}`;
  });
}

function mainPart(options: EpisodeOptions, mainS: number): Item[] {
  const p = EPISODE_PROFILES[options.effort];
  if (options.pattern === 'steady') return [steady('endurance', mainS, p.steady, 'Zone 2')];

  const items: Item[] = [];
  const base = (s: number): void => {
    if (s > 0) items.push(steady('endurance', s, p.endurance, 'Endurance'));
  };
  const hard = (s: number, power: number): void => {
    items.push(steady('hard', s, power, 'Hard'));
  };
  const easy = (s: number): void => {
    items.push(steady('recovery', s, p.easy, 'Easy'));
  };

  if (options.pattern === 'spread') {
    const { reps, onS, offS } = sizeIntervals(mainS, p, 1.25, 3);
    if (reps === 0) {
      base(mainS);
      return items;
    }
    // Endurance evenly before, between and after the hard parts.
    const filler = mainS - reps * (onS + offS);
    let gap = Math.floor(filler / (reps + 1));
    // Too little for a real endurance part between them: half before the set, half after.
    const lead = gap < MIN_SPREAD_GAP_S ? Math.floor(filler / 2) : gap;
    if (gap < MIN_SPREAD_GAP_S) gap = 0;
    for (let r = 0; r < reps; r++) {
      base(r === 0 ? lead : gap);
      hard(onS, p.hard);
      easy(offS);
    }
    base(filler - lead - gap * (reps - 1));
    return items;
  }

  // early / finale: the hard parts are packed into one half of the main part.
  const halfS = Math.floor(mainS / 2);
  const { reps, onS, offS } = sizeIntervals(halfS, p, 1, 2);
  if (reps === 0) {
    base(mainS);
    return items;
  }
  if (options.pattern === 'early') {
    const setS = reps * (onS + offS);
    const lead = Math.min(60, halfS - setS);
    base(lead);
    for (let r = 0; r < reps; r++) {
      hard(onS, p.hard);
      easy(offS);
    }
    base(mainS - lead - setS);
    return items;
  }
  // finale: endurance, then hard parts climbing in power; the last one runs into the cool-down.
  const setS = reps * (onS + offS) - offS;
  base(mainS - setS);
  for (let r = 0; r < reps; r++) {
    const f = reps === 1 ? 1 : r / (reps - 1);
    hard(onS, p.hard - FINALE_SPREAD + 2 * FINALE_SPREAD * f);
    if (r < reps - 1) easy(offS);
  }
  return items;
}

function episodeName(o: EpisodeOptions): string {
  return `Episode ${o.lengthMin} min · ${PATTERN_LABEL[o.pattern]}, ${EFFORT_LABEL[o.effort]}`;
}

function episodeDescription(o: EpisodeOptions): string {
  const shape: Record<EpisodePattern, string> = {
    early: 'the hard parts early on',
    spread: 'the hard parts spread out evenly',
    finale: 'building up to a hard finale',
    steady: 'steady zone 2, no intervals',
  };
  return `Fitted to a ${o.lengthMin}-minute episode: warm-up, ${shape[o.pattern]}, and a cool-down that ends with the credits.`;
}

function toPlan(options: EpisodeOptions, items: Item[], hardNowCount: number): EpisodePlan {
  relabelHard(items);
  const workout: Workout = {
    id: `${EPISODE_ID_PREFIX}${options.lengthMin}-${options.effort}-${options.pattern}`,
    name: episodeName(options),
    description: episodeDescription(options),
    author: 'Freilauf',
    tags: ['episode', options.effort, options.pattern],
    steps: items.map((i) => i.step),
  };
  return {
    options,
    workout,
    blocks: items.map((i) => i.kind),
    totalDurationS: options.lengthMin * 60,
    hardNowCount,
  };
}

/** The workout for one episode; exactly `lengthMin × 60` seconds long. Deterministic. */
export function generateEpisodeWorkout(input: EpisodeOptions): EpisodePlan {
  const options = normalizeEpisodeOptions(input);
  const p = EPISODE_PROFILES[options.effort];
  const totalS = options.lengthMin * 60;
  const warmS = episodeWarmupS(totalS);
  const coolS = episodeCooldownS(totalS);
  const warmEnd = options.pattern === 'steady' ? Math.min(p.warmupEnd, p.steady) : p.warmupEnd;
  const items: Item[] = [
    {
      kind: 'warmup',
      step: {
        kind: 'ramp',
        durationS: warmS,
        powerStart: WARMUP_START,
        powerEnd: warmEnd,
        label: 'Warm-up',
      },
    },
    ...mainPart(options, totalS - warmS - coolS),
    {
      kind: 'cooldown',
      step: {
        kind: 'ramp',
        durationS: coolS,
        powerStart: options.pattern === 'steady' ? Math.min(p.coolStart, 0.55) : p.coolStart,
        powerEnd: COOL_END,
        label: 'Cool-down',
      },
    },
  ];
  return toPlan(options, items, 0);
}

// ---------------------------------------------------------------------------------------------
// Hard now
// ---------------------------------------------------------------------------------------------

export type HardNowRefusal = 'in-hard' | 'too-close';

export type HardNowResult =
  | {
      ok: true;
      plan: EpisodePlan;
      /** Workout time (whole seconds) where the hard block starts. */
      startS: number;
      /** FTP fraction of the hard block. */
      power: number;
      /** Seconds of later hard blocks that were removed or shortened to make room. */
      removedHardS: number;
    }
  | { ok: false; reason: HardNowRefusal; message: string };

export const HARD_NOW_MESSAGES: Record<HardNowRefusal, string> = {
  'in-hard': 'Already in a hard block.',
  'too-close': 'Too close to the end for a hard block.',
};

function startsOf(plan: EpisodePlan): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of plan.workout.steps) {
    out.push(t);
    t += 'durationS' in s ? s.durationS : 0;
  }
  return out;
}

function indexAt(starts: number[], t: number): number {
  for (let i = starts.length - 1; i >= 0; i--) if ((starts[i] as number) <= t) return i;
  return 0;
}

/** Whether "hard now" would be accepted at this workout time (without building anything). */
export function hardNowAvailability(
  plan: EpisodePlan,
  positionS: number,
): { ok: true } | { ok: false; reason: HardNowRefusal; message: string } {
  const P = Math.max(0, Math.floor(Number.isFinite(positionS) ? positionS : 0));
  const starts = startsOf(plan);
  const coolStart = starts[starts.length - 1] ?? 0;
  const i = indexAt(starts, P);
  const kind = plan.blocks[i];
  if (kind === 'hard' || kind === 'hardNow') {
    return { ok: false, reason: 'in-hard', message: HARD_NOW_MESSAGES['in-hard'] };
  }
  if (
    P >= plan.totalDurationS ||
    kind === 'cooldown' ||
    coolStart - P < HARD_NOW_S + HARD_NOW_RECOVERY_S
  ) {
    return { ok: false, reason: 'too-close', message: HARD_NOW_MESSAGES['too-close'] };
  }
  return { ok: true };
}

function cloneItem(item: Item, durationS: number): Item {
  return { kind: item.kind, step: { ...item.step, durationS } };
}

function rampAt(step: RampStep, atS: number): number {
  return round3(step.powerStart + ((step.powerEnd - step.powerStart) * atS) / step.durationS);
}

/** Joins neighbouring endurance / recovery steps with the same target. */
function mergeEasy(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === item.kind &&
      (item.kind === 'endurance' || item.kind === 'recovery') &&
      prev.step.kind === 'steady' &&
      item.step.kind === 'steady' &&
      prev.step.power === item.step.power
    ) {
      prev.step = { ...prev.step, durationS: prev.step.durationS + item.step.durationS };
    } else out.push(item);
  }
  return out;
}

/**
 * Inserts a hard block (HARD_NOW_S at the effort's `hardNow` target, then HARD_NOW_RECOVERY_S easy)
 * at `positionS` (workout time, floored to whole seconds) and re-fits what follows so the total
 * stays exactly the episode length and the cool-down is untouched:
 * 1. pressed during the warm-up, the rest of the warm-up goes (the hard block warms up enough);
 * 2. later hard blocks are removed, the last first (with the easy part after them), or the
 *    last one needed is shortened (to no less than MIN_HARD_BLOCK_S, else removed);
 * 3. only then endurance / easy parts are shortened, from the end.
 * Time freed beyond what is needed becomes endurance where it was freed.
 * Refused inside a hard block and when the cool-down is less than the block + recovery away.
 */
export function applyHardNow(plan: EpisodePlan, positionS: number): HardNowResult {
  const available = hardNowAvailability(plan, positionS);
  if (!available.ok) return available;
  const p = EPISODE_PROFILES[plan.options.effort];
  const P = Math.max(0, Math.floor(Number.isFinite(positionS) ? positionS : 0));
  const starts = startsOf(plan);
  const items: Item[] = plan.workout.steps.map((step, n) => ({
    kind: plan.blocks[n] as EpisodeBlockKind,
    step: step as SteadyStep | RampStep,
  }));
  const i = indexAt(starts, P);
  const current = items[i] as Item;
  const offset = P - (starts[i] as number);
  const cooldown = items[items.length - 1] as Item;

  // Before: everything up to P (the current step cut at P).
  const before: Item[] = items.slice(0, i).map((it) => cloneItem(it, durOf(it)));
  if (offset > 0) {
    const cut = cloneItem(current, offset);
    if (current.step.kind === 'ramp' && cut.step.kind === 'ramp') {
      cut.step.powerEnd = rampAt(current.step, offset);
    }
    before.push(cut);
  }

  // After: the rest of the current step and everything up to the cool-down.
  let after: Item[] = [];
  let deficit = HARD_NOW_S + HARD_NOW_RECOVERY_S;
  let surplusAt = 0;
  const restS = durOf(current) - offset;
  if (current.kind === 'warmup') {
    deficit -= restS;
  } else if (restS > 0) {
    const rest = cloneItem(current, restS);
    if (current.step.kind === 'ramp' && rest.step.kind === 'ramp') {
      rest.step.powerStart = rampAt(current.step, offset);
    }
    after.push(rest);
  }
  after.push(...items.slice(i + 1, items.length - 1).map((it) => cloneItem(it, durOf(it))));

  // Later hard blocks first, the last one first.
  let removedHardS = 0;
  for (let j = after.length - 1; j >= 0 && deficit > 0; j--) {
    const item = after[j] as Item;
    if (item.kind !== 'hard' && item.kind !== 'hardNow') continue;
    const d = durOf(item);
    if (d - deficit >= MIN_HARD_BLOCK_S) {
      item.step = { ...item.step, durationS: d - deficit };
      removedHardS += deficit;
      deficit = 0;
      break;
    }
    // Remove it, and the easy part that belongs to it.
    let freed = d;
    const next = after[j + 1];
    const removeNext = next !== undefined && next.kind === 'recovery' ? 1 : 0;
    if (removeNext) freed += durOf(next as Item);
    after.splice(j, 1 + removeNext);
    removedHardS += d;
    deficit -= freed;
    surplusAt = j;
  }
  // Then endurance / easy parts, from the end.
  for (let j = after.length - 1; j >= 0 && deficit > 0; j--) {
    const item = after[j] as Item;
    const d = durOf(item);
    const take = Math.min(d, deficit);
    deficit -= take;
    if (take === d) after.splice(j, 1);
    else item.step = { ...item.step, durationS: d - take };
  }
  if (deficit < 0) {
    after.splice(
      Math.min(surplusAt, after.length),
      0,
      steady('endurance', -deficit, p.endurance, 'Endurance'),
    );
  }
  after = after.filter((it) => durOf(it) > 0);

  const out = mergeEasy([
    ...before,
    steady('hardNow', HARD_NOW_S, p.hardNow, 'Hard now'),
    steady('recovery', HARD_NOW_RECOVERY_S, p.easy, 'Recovery'),
    ...after,
    cloneItem(cooldown, durOf(cooldown)),
  ]);
  return {
    ok: true,
    plan: toPlan(plan.options, out, plan.hardNowCount + 1),
    startS: P,
    power: p.hardNow,
    removedHardS,
  };
}
