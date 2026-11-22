/**
 * Pure presentation helpers for the Community tab: units, deltas, ages, challenge texts and the
 * "new challenge" form (defaults, ranges, validation). No React, no DOM — unit-tested directly.
 */
import type {
  ChallengeMetric,
  ChallengeType,
  SessionLevel,
  TotalsMetric,
  Visibility,
} from '@freilauf/community';
import { addWeeks, periodBounds, weekKey } from '@freilauf/community';
import type {
  ChallengeTemplateInfo,
  ChallengeView,
  CreateChallengeInput,
  LeaderboardPeriod,
} from '../../core/communityService';

const MINUS = '−';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ───────────── metrics ─────────────

export type AnyMetric = TotalsMetric | ChallengeMetric;

/** The metrics the leaderboard offers (in this order). */
export const LEADERBOARD_METRICS: readonly TotalsMetric[] = [
  'points',
  'distanceM',
  'movingS',
  'elevationGainM',
  'energyKj',
  'rides',
];

export const METRIC_LABEL: Record<AnyMetric, string> = {
  points: 'Points',
  distanceM: 'Distance',
  movingS: 'Time',
  elevationGainM: 'Elevation',
  energyKj: 'Energy',
  rides: 'Rides',
  groupRides: 'Group rides',
  rideDays: 'Ride days',
  p5m: '5-minute power',
  p20m: '20-minute power',
};

export const PERIOD_LABEL: Record<LeaderboardPeriod, string> = {
  thisWeek: 'This week',
  lastWeek: 'Last week',
  thisMonth: 'This month',
  lastMonth: 'Last month',
};

const grouped = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

function signed(n: number, text: string): string {
  return n < 0 ? `${MINUS}${text}` : text;
}

/** A value split into number and unit, for typographic display. */
export interface MetricParts {
  number: string;
  unit: string;
}

/** Hours and minutes: `0 min`, `45 min`, `2 h 05`, `12 h`. */
function hoursMinutes(seconds: number): MetricParts {
  const totalMin = Math.round(Math.abs(seconds) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return { number: `${m}`, unit: 'min' };
  if (m === 0) return { number: `${h}`, unit: 'h' };
  return { number: `${h}:${String(m).padStart(2, '0')}`, unit: 'h' };
}

/** `metricParts('distanceM', 12_340)` → `{ number: '12.3', unit: 'km' }`. Sign-less. */
export function metricParts(metric: AnyMetric, value: number): MetricParts {
  const v = Number.isFinite(value) ? Math.abs(value) : 0;
  switch (metric) {
    case 'points':
      return { number: grouped.format(v), unit: v === 1 ? 'point' : 'points' };
    case 'distanceM': {
      const km = v / 1000;
      return { number: km >= 100 ? grouped.format(km) : km.toFixed(1), unit: 'km' };
    }
    case 'movingS':
      return hoursMinutes(v);
    case 'elevationGainM':
      return { number: grouped.format(v), unit: 'm' };
    case 'energyKj':
      return { number: grouped.format(v), unit: 'kJ' };
    case 'rides':
      return { number: grouped.format(v), unit: v === 1 ? 'ride' : 'rides' };
    case 'groupRides':
      return { number: grouped.format(v), unit: v === 1 ? 'group ride' : 'group rides' };
    case 'rideDays':
      return { number: grouped.format(v), unit: v === 1 ? 'day' : 'days' };
    case 'p5m':
    case 'p20m':
      return { number: grouped.format(v), unit: 'W' };
  }
}

/** `12.3 km`, `2:05 h`, `140 points`. */
export function formatMetric(metric: AnyMetric, value: number): string {
  const p = metricParts(metric, value);
  return signed(value, `${p.number} ${p.unit}`);
}

/** Difference to you: `+12.3 km`, `−4 points`, `level`. */
export function formatDelta(metric: AnyMetric, delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return 'level';
  const p = metricParts(metric, delta);
  // A difference that rounds to nothing is shown as level, not "+0.0 km".
  if (Number(p.number.replace(/[^0-9.]/g, '')) === 0) return 'level';
  return `${delta > 0 ? '+' : MINUS}${p.number} ${p.unit}`;
}

// ───────────── time ─────────────

/** `just now`, `5 h ago`, `3 d ago`. */
export function formatAgeHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1) return 'just now';
  if (hours < 48) return `${Math.floor(hours)} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function formatSince(nowMs: number, thenMs: number): string {
  return formatAgeHours((nowMs - thenMs) / HOUR_MS);
}

/** `2 d 5 h left`, `5 h left`, `40 min left`, `ends now`. */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'ends now';
  if (ms >= DAY_MS) {
    const d = Math.floor(ms / DAY_MS);
    const h = Math.floor((ms % DAY_MS) / HOUR_MS);
    return h > 0 ? `${d} d ${h} h left` : `${d} d left`;
  }
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h left`;
  return `${Math.max(1, Math.round(ms / 60_000))} min left`;
}

const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const weekdayDay = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** `23–29 Nov`, `30 Nov – 6 Dec` for a week given by its local bounds (end exclusive). */
export function formatWeekRange(startMs: number, endMs: number): string {
  const a = new Date(startMs);
  const b = new Date(endMs - 1);
  if (a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${dayMonth.format(b)}`;
  }
  return `${dayMonth.format(a)} – ${dayMonth.format(b)}`;
}

export function formatDay(ms: number): string {
  return weekdayDay.format(new Date(ms));
}

/** `2026-W48` → `Week 48`. */
export function weekNumber(weekKey: string): string {
  const m = /^\d{4}-W(\d{2})$/.exec(weekKey);
  return m ? `Week ${Number(m[1])}` : weekKey;
}

const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long' });

/** The month of a local timestamp: `November`. */
export function monthName(ms: number): string {
  return monthFormat.format(new Date(ms));
}

export interface WeekOption {
  /** `thisWeek`, `nextWeek` or a week key, as `createChallenge` accepts it. */
  value: string;
  label: string;
}

/** This week and the next `count − 1` weeks, labelled with their dates. */
export function weekOptions(nowMs: number, offsetMin: number, count = 5): WeekOption[] {
  const current = weekKey(nowMs, offsetMin);
  const out: WeekOption[] = [];
  for (let i = 0; i < count; i++) {
    const key = addWeeks(current, i);
    const b = periodBounds(key, offsetMin);
    const range = b ? formatWeekRange(b.startMs, b.endMs) : '';
    const name = i === 0 ? 'This week' : i === 1 ? 'Next week' : weekNumber(key);
    out.push({
      value: i === 0 ? 'thisWeek' : i === 1 ? 'nextWeek' : key,
      label: range ? `${name} · ${range}` : name,
    });
  }
  return out;
}

// ───────────── leaderboard ─────────────

/** Ranks shared by more than one row (competition ranking: 1, 1, 3). */
export function tiedRanks(rows: readonly { rank: number }[]): Set<number> {
  const seen = new Map<number, number>();
  for (const r of rows) seen.set(r.rank, (seen.get(r.rank) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([rank]) => rank));
}

// ───────────── visibility & session ─────────────

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  none: 'Nothing',
  totals: 'Totals & points',
  everything: 'Everything (incl. best efforts)',
};

/** One line on what this session receives from you. */
export function sessionText(level: SessionLevel | null): string {
  switch (level) {
    case 'everything':
      return 'Sharing totals, points and best efforts with this session.';
    case 'totals':
      return 'Sharing totals with this session.';
    case 'silent':
      return 'Sharing nothing: a rider you removed is in this session.';
    default:
      return 'Sharing nothing: someone here is set to Nothing or is not yet identified.';
  }
}

// ───────────── challenges ─────────────

export const CHALLENGE_TYPE_LABEL: Record<ChallengeType, string> = {
  'personal-goal': 'Personal goal',
  'group-goal': 'Group goal',
  duel: 'Duel',
  streak: 'Streak',
  consistency: 'Consistency',
  'beat-your-best': 'Beat your best',
  'ride-together': 'Ride together',
};

/** One-line explanation of each template, for the picker. */
export const CHALLENGE_TYPE_TEXT: Record<ChallengeType, string> = {
  'personal-goal': 'Everyone rides towards the same target on their own, within one week.',
  'group-goal': 'One shared target for the week; everyone’s rides add up.',
  duel: 'You against one friend: most points in the week wins.',
  streak: 'Ride at least a number of times every week, week after week.',
  consistency: 'Ride on a number of different days within one week.',
  'beat-your-best': 'Beat your best 5- or 20-minute power of the four weeks before.',
  'ride-together': 'Ride a number of group rides with others within one week.',
};

/** "Personal goal · 300 km", "Streak · 2+ rides a week". */
export function challengeSummary(c: Pick<ChallengeView, 'type' | 'metric' | 'target'>): string {
  const label = CHALLENGE_TYPE_LABEL[c.type];
  switch (c.type) {
    case 'personal-goal':
      return `${label} · ${formatMetric(c.metric, c.target)} each`;
    case 'group-goal':
      return `${label} · ${formatMetric(c.metric, c.target)} together`;
    case 'duel':
      return `${label} · most points`;
    case 'streak':
      return `${label} · ${c.target}+ ${c.target === 1 ? 'ride' : 'rides'} every week`;
    case 'consistency':
      return `${label} · ${c.target} ${c.target === 1 ? 'day' : 'days'} with a ride`;
    case 'beat-your-best':
      return `${label} · ${METRIC_LABEL[c.metric].toLowerCase()}`;
    case 'ride-together':
      return `${label} · ${formatMetric('groupRides', c.target)}`;
  }
}

/** Where a challenge belongs in the list. */
export type ChallengeGroup = 'running' | 'upcoming' | 'finished';

export function challengeGroup(c: Pick<ChallengeView, 'progress' | 'status'>): ChallengeGroup {
  if (c.status === 'cancelled' || c.progress.status === 'cancelled') return 'finished';
  if (c.progress.status === 'upcoming') return 'upcoming';
  if (c.progress.status === 'finished') return 'finished';
  return 'running';
}

/** Fraction clamped to 0…1 for bars (a goal can be exceeded). */
export function barFraction(fraction: number | null | undefined): number {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(1, fraction));
}

// ───────────── create form ─────────────

/** How the target is entered: in a friendly unit, converted to the stored unit on submit. */
export interface TargetSpec {
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Suggested value in the input unit. */
  suggested: number;
  /** Input unit → stored unit (metres, seconds, …). */
  factor: number;
}

const SUGGESTED: Partial<Record<ChallengeType, Partial<Record<ChallengeMetric, number>>>> = {
  'personal-goal': { distanceM: 100, elevationGainM: 1000, movingS: 4, points: 250 },
  'group-goal': { distanceM: 500, elevationGainM: 5000, movingS: 20, points: 1000 },
  streak: { rides: 2 },
  consistency: { rideDays: 3 },
  'ride-together': { groupRides: 2 },
};

const INPUT_UNIT: Partial<Record<ChallengeMetric, { unit: string; factor: number; step: number }>> =
  {
    distanceM: { unit: 'km', factor: 1000, step: 10 },
    elevationGainM: { unit: 'm', factor: 1, step: 100 },
    movingS: { unit: 'h', factor: 3600, step: 0.5 },
    points: { unit: 'points', factor: 1, step: 10 },
    rides: { unit: 'rides a week', factor: 1, step: 1 },
    rideDays: { unit: 'days', factor: 1, step: 1 },
    groupRides: { unit: 'group rides', factor: 1, step: 1 },
  };

/** The target input for a template and metric, or null when the template has no target. */
export function targetSpec(
  template: ChallengeTemplateInfo,
  metric: ChallengeMetric,
): TargetSpec | null {
  const m = template.metrics.find((x) => x.metric === metric);
  if (!m?.target) return null;
  const u = INPUT_UNIT[metric] ?? { unit: '', factor: 1, step: 1 };
  // Whole units (half hours for time) that stay inside the stored range.
  const grain = u.step < 1 ? u.step : 1;
  const min = Math.max(grain, Math.ceil(m.target.min / u.factor / grain) * grain);
  const max = Math.floor(m.target.max / u.factor / grain) * grain;
  const suggested = SUGGESTED[template.type]?.[metric] ?? min;
  return {
    unit: u.unit,
    min,
    max,
    step: u.step,
    suggested: Math.min(max, Math.max(min, suggested)),
    factor: u.factor,
  };
}

export interface ChallengeDraft {
  type: ChallengeType;
  metric: ChallengeMetric;
  /** As typed, in the spec's unit. */
  target: string;
  week: string;
  title: string;
  invite: readonly string[];
}

export const MAX_TITLE_LENGTH = 60;

export function draftFor(template: ChallengeTemplateInfo, week: string): ChallengeDraft {
  const metric = template.metrics[0]?.metric ?? 'points';
  const spec = targetSpec(template, metric);
  return {
    type: template.type,
    metric,
    target: spec ? String(spec.suggested) : '',
    week,
    title: '',
    invite: [],
  };
}

export type DraftResult =
  | { ok: true; input: CreateChallengeInput }
  | { ok: false; errors: { target?: string; title?: string; invite?: string } };

/** Checks the draft against the template and turns it into `createChallenge` input. */
export function validateDraft(template: ChallengeTemplateInfo, draft: ChallengeDraft): DraftResult {
  const errors: { target?: string; title?: string; invite?: string } = {};
  const input: CreateChallengeInput = {
    type: draft.type,
    metric: draft.metric,
    week: draft.week,
    invite: [...draft.invite],
  };
  const spec = targetSpec(template, draft.metric);
  if (spec) {
    const n = Number(draft.target.trim().replace(',', '.'));
    if (draft.target.trim() === '' || !Number.isFinite(n) || n < spec.min || n > spec.max) {
      errors.target = `Enter a number from ${grouped.format(spec.min)} to ${grouped.format(spec.max)} ${spec.unit}.`;
    } else {
      const stored = Math.round(n * spec.factor);
      input.target = Math.min(
        Math.round(spec.max * spec.factor),
        Math.max(Math.round(spec.min * spec.factor), stored),
      );
    }
  }
  const title = draft.title.trim();
  if ([...title].length > MAX_TITLE_LENGTH) {
    errors.title = `Keep the title to ${MAX_TITLE_LENGTH} characters.`;
  } else if (title) {
    input.title = title;
  }
  const room = template.maxParticipants - 1;
  if (draft.invite.length > room) {
    errors.invite =
      room === 1
        ? 'A duel is between two riders: invite one friend.'
        : `Invite at most ${room} friends.`;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, input };
}
