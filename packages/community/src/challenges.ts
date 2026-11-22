/**
 * Rider-made challenges. Seven templates; definitions are authored by the creator, responses by
 * each participant; progress is always derived locally from standings, never taken from the wire.
 */

import {
  type Now,
  type WeekKey,
  addWeeks,
  isWeekKey,
  periodBounds,
  weekKey,
  weeksBetween,
} from './periods';
import {
  HISTORY_WEEKS,
  MAX_NAME_CODE_POINTS,
  type PublicStanding,
  sanitizeName,
  standingPeriod,
  weeklyRidesOf,
} from './profile';
import type { CommunityState } from './state';
import { isFiniteNumber, isId, isIntIn, isRecord, randomId, sanitizeText } from './util';

export type ChallengeType =
  | 'personal-goal'
  | 'group-goal'
  | 'duel'
  | 'streak'
  | 'consistency'
  | 'beat-your-best'
  | 'ride-together';

export const CHALLENGE_TYPES: readonly ChallengeType[] = [
  'personal-goal',
  'group-goal',
  'duel',
  'streak',
  'consistency',
  'beat-your-best',
  'ride-together',
];

export type GoalMetric = 'distanceM' | 'elevationGainM' | 'movingS' | 'points';
export type ChallengeMetric = GoalMetric | 'rides' | 'rideDays' | 'groupRides' | 'p5m' | 'p20m';

export type InvitationState = 'invited' | 'accepted' | 'declined' | 'left';

export interface ChallengeParticipant {
  riderId: string;
  name: string;
  state: InvitationState;
  /** Bumped by the participant on every own response (0 = as invited by the creator). */
  rev: number;
  updatedAt: number;
}

export interface Challenge {
  id: string;
  creator: string;
  title: string;
  type: ChallengeType;
  metric: ChallengeMetric;
  /** Goal value in the metric's unit; 0 for duel and beat-your-best (no fixed target). */
  target: number;
  /** The ISO week the challenge runs in; for streaks the first counted week (open-ended). */
  week: WeekKey;
  status: 'active' | 'cancelled';
  /** Definition revision, bumped by the creator (invites, cancel). */
  defRev: number;
  createdAt: number;
  updatedAt: number;
  participants: ChallengeParticipant[];
}

export const MAX_PARTICIPANTS = 16;
export const MAX_TITLE_CODE_POINTS = 60;
export const MAX_CHALLENGES = 64;
/** Challenges are no longer published this long after their week ended (or were cancelled). */
export const CHALLENGE_PUBLISH_GRACE_MS = 14 * 86_400_000;

interface Template {
  metrics: readonly ChallengeMetric[];
  /** Allowed target per metric, or null for "no target" (stored as 0). */
  target: (m: ChallengeMetric) => readonly [number, number] | null;
  maxParticipants: number;
}

const GOAL_METRICS: readonly GoalMetric[] = ['distanceM', 'elevationGainM', 'movingS', 'points'];
const GOAL_RANGE: Record<GoalMetric, readonly [number, number]> = {
  distanceM: [1, 2_000_000],
  elevationGainM: [1, 100_000],
  movingS: [60, 604_800],
  points: [1, 3_500],
};

export const TEMPLATES: Readonly<Record<ChallengeType, Template>> = {
  'personal-goal': {
    metrics: GOAL_METRICS,
    target: (m) => GOAL_RANGE[m as GoalMetric] ?? null,
    maxParticipants: MAX_PARTICIPANTS,
  },
  'group-goal': {
    metrics: GOAL_METRICS,
    target: (m) => {
      const r = GOAL_RANGE[m as GoalMetric];
      return r ? [r[0], r[1] * MAX_PARTICIPANTS] : null;
    },
    maxParticipants: MAX_PARTICIPANTS,
  },
  duel: { metrics: ['points'], target: () => null, maxParticipants: 2 },
  streak: { metrics: ['rides'], target: () => [1, 14], maxParticipants: MAX_PARTICIPANTS },
  consistency: { metrics: ['rideDays'], target: () => [1, 7], maxParticipants: MAX_PARTICIPANTS },
  'beat-your-best': {
    metrics: ['p5m', 'p20m'],
    target: () => null,
    maxParticipants: MAX_PARTICIPANTS,
  },
  'ride-together': {
    metrics: ['groupRides'],
    target: () => [1, 20],
    maxParticipants: MAX_PARTICIPANTS,
  },
};

export type ChallengeResult =
  | { ok: true; challenge: Challenge }
  | {
      ok: false;
      reason:
        | 'invalid-template'
        | 'invalid-metric'
        | 'invalid-target'
        | 'invalid-week'
        | 'invalid-id'
        | 'not-creator'
        | 'not-participant'
        | 'already-invited'
        | 'full'
        | 'invalid-transition'
        | 'cancelled';
    };

export function newChallengeId(random: () => number): string {
  return randomId(random, 16);
}

function defaultTitle(type: ChallengeType, metric: ChallengeMetric, target: number): string {
  const amount = (() => {
    switch (metric) {
      case 'distanceM':
        return `${Math.round(target / 1000)} km`;
      case 'elevationGainM':
        return `${target} m climbing`;
      case 'movingS':
        return `${Math.round((target / 3600) * 10) / 10} h`;
      case 'points':
        return `${target} points`;
      default:
        return '';
    }
  })();
  switch (type) {
    case 'personal-goal':
      return `${amount} this week`;
    case 'group-goal':
      return `${amount} together this week`;
    case 'duel':
      return 'Duel: most points this week';
    case 'streak':
      return `Streak: ${target}+ rides every week`;
    case 'consistency':
      return `Ride on ${target} days this week`;
    case 'beat-your-best':
      return `Beat your best ${metric === 'p5m' ? '5' : '20'}-minute power`;
    case 'ride-together':
      return `${target} group rides this week`;
  }
}

export interface ChallengeInput {
  id: string;
  type: ChallengeType;
  week: WeekKey;
  metric?: ChallengeMetric;
  target?: number;
  title?: string;
}

/** Creates a challenge from a template; the creator is its first (accepted) participant. */
export function createChallenge(
  input: ChallengeInput,
  creator: { riderId: string; name: string },
  nowMs: number,
): ChallengeResult {
  const tpl = TEMPLATES[input.type];
  if (!tpl || !(CHALLENGE_TYPES as readonly string[]).includes(input.type)) {
    return { ok: false, reason: 'invalid-template' };
  }
  if (!isId(input.id) || !isId(creator.riderId)) return { ok: false, reason: 'invalid-id' };
  const metric = input.metric ?? tpl.metrics[0];
  if (metric === undefined || !tpl.metrics.includes(metric)) {
    return { ok: false, reason: 'invalid-metric' };
  }
  const range = tpl.target(metric);
  let target = 0;
  if (range) {
    const t = input.target;
    if (!isIntIn(t, range[0], range[1])) return { ok: false, reason: 'invalid-target' };
    target = t;
  }
  if (!isWeekKey(input.week)) return { ok: false, reason: 'invalid-week' };
  const title =
    sanitizeText(input.title, MAX_TITLE_CODE_POINTS) || defaultTitle(input.type, metric, target);
  return {
    ok: true,
    challenge: {
      id: input.id,
      creator: creator.riderId,
      title,
      type: input.type,
      metric,
      target,
      week: input.week,
      status: 'active',
      defRev: 1,
      createdAt: nowMs,
      updatedAt: nowMs,
      participants: [
        {
          riderId: creator.riderId,
          name: sanitizeName(creator.name) || 'Rider',
          state: 'accepted',
          rev: 1,
          updatedAt: nowMs,
        },
      ],
    },
  };
}

/** Creator invites a friend (bumps the definition revision). */
export function inviteToChallenge(
  ch: Challenge,
  actorId: string,
  invitee: { riderId: string; name: string },
  nowMs: number,
): ChallengeResult {
  if (ch.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (actorId !== ch.creator) return { ok: false, reason: 'not-creator' };
  if (!isId(invitee.riderId)) return { ok: false, reason: 'invalid-id' };
  if (ch.participants.some((p) => p.riderId === invitee.riderId)) {
    return { ok: false, reason: 'already-invited' };
  }
  if (ch.participants.length >= TEMPLATES[ch.type].maxParticipants) {
    return { ok: false, reason: 'full' };
  }
  return {
    ok: true,
    challenge: {
      ...ch,
      defRev: ch.defRev + 1,
      updatedAt: Math.max(ch.updatedAt, nowMs),
      participants: [
        ...ch.participants,
        {
          riderId: invitee.riderId,
          name: sanitizeName(invitee.name) || 'Rider',
          state: 'invited',
          rev: 0,
          updatedAt: nowMs,
        },
      ],
    },
  };
}

const TRANSITIONS: Record<InvitationState, readonly InvitationState[]> = {
  invited: ['accepted', 'declined'],
  declined: ['accepted'],
  accepted: ['left'],
  left: ['accepted'],
};

function setOwnState(
  ch: Challenge,
  actorId: string,
  next: InvitationState,
  nowMs: number,
): ChallengeResult {
  if (ch.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  const p = ch.participants.find((x) => x.riderId === actorId);
  if (!p) return { ok: false, reason: 'not-participant' };
  if (!TRANSITIONS[p.state].includes(next)) return { ok: false, reason: 'invalid-transition' };
  return {
    ok: true,
    challenge: {
      ...ch,
      updatedAt: Math.max(ch.updatedAt, nowMs),
      participants: ch.participants.map((x) =>
        x.riderId === actorId ? { ...x, state: next, rev: x.rev + 1, updatedAt: nowMs } : x,
      ),
    },
  };
}

/** An invited (or previously declined/left) participant accepts or declines. */
export function respondToChallenge(
  ch: Challenge,
  actorId: string,
  response: 'accepted' | 'declined',
  nowMs: number,
): ChallengeResult {
  return setOwnState(ch, actorId, response, nowMs);
}

export function leaveChallenge(ch: Challenge, actorId: string, nowMs: number): ChallengeResult {
  return setOwnState(ch, actorId, 'left', nowMs);
}

/** Creator cancels; final (a cancelled challenge never becomes active again). */
export function cancelChallenge(ch: Challenge, actorId: string, nowMs: number): ChallengeResult {
  if (actorId !== ch.creator) return { ok: false, reason: 'not-creator' };
  if (ch.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  return {
    ok: true,
    challenge: {
      ...ch,
      status: 'cancelled',
      defRev: ch.defRev + 1,
      updatedAt: Math.max(ch.updatedAt, nowMs),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Merge (conflict rules, see docs/community.md)

function sameDefinition(a: Challenge, b: Challenge): boolean {
  return (
    a.title === b.title &&
    a.metric === b.metric &&
    a.target === b.target &&
    a.week === b.week &&
    a.status === b.status
  );
}

/**
 * Merges an incoming copy into the local one.
 * - Unknown challenges are only taken if they list me as a participant.
 * - `id`, `creator`, `type`, `createdAt` are immutable: a copy that disagrees is ignored.
 * - Definition (title, metric, target, week, status): higher `defRev` wins; on equal `defRev`
 *   with different content the copy received directly from the creator wins, otherwise the
 *   local one stays. Cancellation is sticky.
 * - Participants: union by rider id (capped by the template); per participant the entry with
 *   the higher `rev` wins (equal → local). My own entry is never changed from outside.
 */
export function mergeChallenge(
  local: Challenge | undefined,
  incoming: Challenge,
  meId: string,
  fromRiderId: string,
): { challenge: Challenge; changed: boolean } | null {
  if (!local) {
    if (!incoming.participants.some((p) => p.riderId === meId)) return null;
    return { challenge: incoming, changed: true };
  }
  if (
    local.id !== incoming.id ||
    local.creator !== incoming.creator ||
    local.type !== incoming.type ||
    local.createdAt !== incoming.createdAt
  ) {
    return { challenge: local, changed: false };
  }
  let def: Challenge = local;
  if (incoming.defRev > local.defRev) def = incoming;
  else if (
    incoming.defRev === local.defRev &&
    fromRiderId === local.creator &&
    !sameDefinition(local, incoming)
  ) {
    def = incoming;
  }
  const status = local.status === 'cancelled' ? 'cancelled' : def.status;

  const max = TEMPLATES[local.type].maxParticipants;
  const participants = local.participants.map((p) => ({ ...p }));
  for (const inc of incoming.participants) {
    const i = participants.findIndex((p) => p.riderId === inc.riderId);
    if (i < 0) {
      if (participants.length < max) participants.push({ ...inc });
      continue;
    }
    const cur = participants[i];
    if (!cur || inc.riderId === meId) continue;
    if (inc.rev > cur.rev) participants[i] = { ...inc };
  }
  const merged: Challenge = {
    ...local,
    title: def.title,
    metric: def.metric,
    target: def.target,
    week: def.week,
    status,
    defRev: Math.max(local.defRev, incoming.defRev),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    participants,
  };
  const changed = JSON.stringify(merged) !== JSON.stringify(local);
  return { challenge: changed ? merged : local, changed };
}

/** Stores a challenge in the state, evicting the least recently updated beyond the cap. */
export function putChallenge(state: CommunityState, ch: Challenge): CommunityState {
  const challenges = { ...state.challenges, [ch.id]: ch };
  const all = Object.values(challenges);
  if (all.length <= MAX_CHALLENGES) return { ...state, challenges };
  all.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  return {
    ...state,
    challenges: Object.fromEntries(all.slice(0, MAX_CHALLENGES).map((c) => [c.id, c])),
  };
}

// ---------------------------------------------------------------------------------------------
// Wire format

export function encodeChallenge(ch: Challenge): Record<string, unknown> {
  return {
    id: ch.id,
    creator: ch.creator,
    title: ch.title,
    type: ch.type,
    metric: ch.metric,
    target: ch.target,
    week: ch.week,
    status: ch.status,
    defRev: ch.defRev,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
    participants: ch.participants.map((p) => [p.riderId, p.name, p.state, p.rev, p.updatedAt]),
  };
}

const STATES: readonly InvitationState[] = ['invited', 'accepted', 'declined', 'left'];
const MIN_TS = Date.UTC(2020, 0, 1);

/** Validates a challenge from the wire or storage; null when anything is off. */
export function decodeChallenge(v: unknown, nowMs: number, toleranceMs: number): Challenge | null {
  if (!isRecord(v)) return null;
  const { id, creator, title, type, metric, target, week, status, defRev } = v;
  const { createdAt, updatedAt, participants } = v;
  const latest = nowMs + toleranceMs;
  const ts = (x: unknown): x is number => isFiniteNumber(x) && x >= MIN_TS && x <= latest;
  if (!isId(id) || !isId(creator)) return null;
  if (typeof title !== 'string' || title.length > MAX_TITLE_CODE_POINTS * 4) return null;
  if (typeof type !== 'string' || !(CHALLENGE_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  const tpl = TEMPLATES[type as ChallengeType];
  if (typeof metric !== 'string' || !(tpl.metrics as readonly string[]).includes(metric)) {
    return null;
  }
  const range = tpl.target(metric as ChallengeMetric);
  if (range ? !isIntIn(target, range[0], range[1]) : target !== 0) return null;
  if (typeof week !== 'string' || !isWeekKey(week)) return null;
  if (status !== 'active' && status !== 'cancelled') return null;
  if (!isIntIn(defRev, 1, 1_000_000)) return null;
  if (!ts(createdAt) || !ts(updatedAt) || updatedAt < createdAt) return null;
  if (!Array.isArray(participants) || participants.length < 1) return null;
  if (participants.length > tpl.maxParticipants) return null;
  const list: ChallengeParticipant[] = [];
  for (const p of participants) {
    if (!Array.isArray(p) || p.length !== 5) return null;
    const [rid, name, st, rev, at] = p as unknown[];
    if (!isId(rid) || list.some((x) => x.riderId === rid)) return null;
    if (typeof name !== 'string' || name.length > MAX_NAME_CODE_POINTS * 4) return null;
    if (typeof st !== 'string' || !(STATES as readonly string[]).includes(st)) return null;
    if (!isIntIn(rev, 0, 1_000_000) || !ts(at)) return null;
    list.push({
      riderId: rid,
      name: sanitizeName(name) || 'Rider',
      state: st as InvitationState,
      rev,
      updatedAt: at,
    });
  }
  if (!list.some((p) => p.riderId === creator)) return null;
  return {
    id,
    creator,
    title: sanitizeText(title, MAX_TITLE_CODE_POINTS) || 'Challenge',
    type: type as ChallengeType,
    metric: metric as ChallengeMetric,
    target: target as number,
    week,
    status,
    defRev,
    createdAt,
    updatedAt,
    participants: list,
  };
}

// ---------------------------------------------------------------------------------------------
// Progress (derived locally from standings)

export interface ParticipantProgress {
  riderId: string;
  name: string;
  state: InvitationState;
  /** Current value in the metric's unit (streak: weeks); null = unknown / not shared. */
  value: number | null;
  /** Per-participant target (goal types; beat-your-best: the baseline); null otherwise. */
  target: number | null;
  /** value / target, null without a target. */
  fraction: number | null;
  complete: boolean;
  /** True once the rider's standing was produced after the challenge week ended. */
  final: boolean;
  /** Streak only: the history window (52 weeks) was exhausted, the streak may be longer. */
  capped?: boolean;
}

export type DuelResult =
  | { outcome: 'winner'; riderId: string; provisional: boolean }
  | { outcome: 'draw'; provisional: boolean };

export interface ChallengeProgress {
  challengeId: string;
  type: ChallengeType;
  metric: ChallengeMetric;
  status: 'upcoming' | 'running' | 'finished' | 'cancelled';
  startsAt: number;
  /** null for streaks (open-ended). */
  endsAt: number | null;
  remainingMs: number | null;
  participants: ParticipantProgress[];
  /** Group goal only: everyone's contributions summed. `partial` if some are unknown. */
  combined: {
    value: number;
    target: number;
    fraction: number;
    complete: boolean;
    partial: boolean;
  } | null;
  /** Rider with the highest value (fraction for goals); null if none or tied. */
  leader: string | null;
  /** Duel only, once the week is over: winner or draw; `provisional` until data is final. */
  result: DuelResult | null;
}

export type StandingsByRider = Readonly<Record<string, PublicStanding | undefined>>;

/** Streak: consecutive weeks with ≥ `perWeek` rides from `start`; the latest week never breaks it. */
export function streakWeeks(
  standing: PublicStanding,
  start: WeekKey,
  perWeek: number,
  currentWeek: WeekKey,
): { weeks: number; capped: boolean } {
  const last = standing.asOfWeek < currentWeek ? standing.asOfWeek : currentWeek;
  if (last < start) return { weeks: 0, capped: false };
  const oldest = addWeeks(standing.asOfWeek, -(HISTORY_WEEKS - 1));
  const from = start < oldest ? oldest : start;
  const capped = start < oldest;
  let count = 0;
  const n = weeksBetween(from, last);
  for (let i = 0; i <= n; i++) {
    const wk = addWeeks(from, i);
    const rides = weeklyRidesOf(standing, wk) ?? 0;
    if (rides >= perWeek) count++;
    else if (wk !== last) count = 0;
  }
  return { weeks: count, capped: capped && count === n + 1 };
}

function participantValue(
  ch: Challenge,
  standing: PublicStanding | undefined,
  now: Now,
): { value: number | null; target: number | null; final: boolean; capped?: boolean } {
  if (!standing) return { value: null, target: null, final: false };
  if (ch.type === 'streak') {
    const s = streakWeeks(standing, ch.week, ch.target, weekKey(now.ms, now.utcOffsetMin));
    return { value: s.weeks, target: null, final: false, capped: s.capped };
  }
  const sp = standingPeriod(standing, ch.week);
  if (!sp) return { value: null, target: null, final: false };
  if (ch.type === 'beat-your-best') {
    if (standing.level !== 'everything') return { value: null, target: null, final: sp.complete };
    const k = ch.metric === 'p5m' ? 'p5m' : 'p20m';
    let baseline = 0;
    for (let i = 1; i <= 4; i++) {
      const prev = standing.weeks.find((w) => w.key === addWeeks(ch.week, -i));
      const b = prev?.best?.[k];
      if (b !== null && b !== undefined && b > baseline) baseline = b;
    }
    return { value: sp.totals.best?.[k] ?? 0, target: baseline, final: sp.complete };
  }
  const key = ch.metric as Exclude<ChallengeMetric, 'p5m' | 'p20m'>;
  const target = ch.type === 'duel' || ch.type === 'group-goal' ? null : ch.target;
  return { value: sp.totals[key], target, final: sp.complete };
}

/**
 * Progress of a challenge from the standings at hand (include your own, e.g. from
 * `allStandings(state, now)`). Only accepted participants count towards results; invited,
 * declined and left participants are listed with their state.
 */
export function challengeProgress(
  ch: Challenge,
  standingsByRider: StandingsByRider,
  now: Now,
): ChallengeProgress {
  const bounds = periodBounds(ch.week, now.utcOffsetMin) ?? { startMs: 0, endMs: 0 };
  const isStreak = ch.type === 'streak';
  const endsAt = isStreak ? null : bounds.endMs;
  const status: ChallengeProgress['status'] =
    ch.status === 'cancelled'
      ? 'cancelled'
      : now.ms < bounds.startMs
        ? 'upcoming'
        : endsAt !== null && now.ms >= endsAt
          ? 'finished'
          : 'running';

  const participants: ParticipantProgress[] = ch.participants.map((p) => {
    const base = { riderId: p.riderId, name: p.name, state: p.state };
    if (p.state !== 'accepted') {
      return { ...base, value: null, target: null, fraction: null, complete: false, final: false };
    }
    const v = participantValue(ch, standingsByRider[p.riderId], now);
    let fraction: number | null = null;
    let complete = false;
    if (v.value !== null && v.target !== null) {
      if (ch.type === 'beat-your-best') {
        fraction = v.target > 0 ? v.value / v.target : v.value > 0 ? 1 : 0;
        complete = v.value > v.target;
      } else {
        fraction = v.target > 0 ? v.value / v.target : 0;
        complete = v.value >= v.target;
      }
    }
    const out: ParticipantProgress = { ...base, ...v, fraction, complete };
    if (v.capped === undefined) delete out.capped;
    return out;
  });

  const accepted = participants.filter((p) => p.state === 'accepted');
  let combined: ChallengeProgress['combined'] = null;
  if (ch.type === 'group-goal') {
    const value = accepted.reduce((a, p) => a + (p.value ?? 0), 0);
    combined = {
      value,
      target: ch.target,
      fraction: ch.target > 0 ? value / ch.target : 0,
      complete: value >= ch.target,
      partial: accepted.some((p) => p.value === null),
    };
  }

  const score = (p: ParticipantProgress) => (p.fraction !== null ? p.fraction : p.value);
  const ranked = accepted
    .filter((p) => score(p) !== null)
    .sort((a, b) => (score(b) ?? 0) - (score(a) ?? 0));
  const top = ranked[0];
  const second = ranked[1];
  const leader = top && (!second || score(second) !== score(top)) ? top.riderId : null;

  let result: DuelResult | null = null;
  if (ch.type === 'duel' && status === 'finished' && accepted.length === 2) {
    const [a, b] = accepted;
    if (a && b && a.value !== null && b.value !== null) {
      const provisional = !(a.final && b.final);
      result =
        a.value === b.value
          ? { outcome: 'draw', provisional }
          : { outcome: 'winner', riderId: a.value > b.value ? a.riderId : b.riderId, provisional };
    }
  }

  return {
    challengeId: ch.id,
    type: ch.type,
    metric: ch.metric,
    status,
    startsAt: bounds.startMs,
    endsAt,
    remainingMs: endsAt === null ? null : Math.max(0, endsAt - now.ms),
    participants,
    combined,
    leader,
    result,
  };
}

/** Whether a challenge is still worth publishing at `nowMs` (viewer offset `offsetMin`). */
export function challengeIsCurrent(ch: Challenge, now: Now): boolean {
  if (ch.type === 'streak') {
    return ch.status === 'active' || now.ms - ch.updatedAt < CHALLENGE_PUBLISH_GRACE_MS;
  }
  const b = periodBounds(ch.week, now.utcOffsetMin);
  if (!b) return false;
  const end = ch.status === 'cancelled' ? Math.min(b.endMs, ch.updatedAt) : b.endMs;
  return now.ms < end + CHALLENGE_PUBLISH_GRACE_MS;
}
