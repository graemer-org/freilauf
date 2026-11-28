/**
 * Pure helpers for "Fit to an episode" (docs/workouts.md): the dialog's summary, the cue ahead
 * of each change and the episode progress line, shared by the main window and the overlay.
 * No React, no DOM.
 */
import type {
  EpisodeEffort,
  EpisodeOptions,
  EpisodePattern,
  EpisodePlan,
  WorkoutStats,
} from '@freilauf/workouts';
import {
  EPISODE_MAX_LENGTH_MIN,
  EPISODE_MIN_LENGTH_MIN,
  EPISODE_PROFILES,
  HARD_NOW_S,
  stepDurationS,
  workoutStats,
} from '@freilauf/workouts';
import type { WorkoutLive } from '../../../shared/contract';
import { formatDuration } from './format';
import { formatApproxDuration, formatStepDuration } from './workoutView';

/** The cue shows this many seconds before each change. */
export const AHEAD_CUE_S = 10;

export const EFFORT_TEXT: Record<EpisodeEffort, { title: string; text: string }> = {
  easy: { title: 'Easy', text: 'Tempo parts, mostly zone 2' },
  medium: { title: 'Medium', text: 'Threshold parts' },
  hard: { title: 'Hard', text: 'Short, hard VO2max parts' },
};

export const PATTERN_TEXT: Record<EpisodePattern, { title: string; text: string }> = {
  early: { title: 'Early', text: 'Hard parts in the first half' },
  spread: { title: 'Spread', text: 'Hard parts evenly' },
  finale: { title: 'Finale', text: 'Builds to the end' },
  steady: { title: 'Steady', text: 'All zone 2, no intervals' },
};

/** A custom length typed by the rider: whole minutes 10 … 180, else null. */
export function parseLengthMin(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= EPISODE_MIN_LENGTH_MIN && n <= EPISODE_MAX_LENGTH_MIN ? n : null;
}

export interface EpisodeSummary {
  /** "42 min · ends exactly with the episode" */
  duration: string;
  warmup: string;
  cooldown: string;
  /** "3 × 4 min at 95 % (190 W)", "No intervals". */
  hard: string;
  /** "≈ 40 TSS · 420 kJ · avg 152 W" */
  load: string;
  stats: WorkoutStats;
}

/** What the dialog says about a generated plan, at the rider's FTP. */
export function episodeSummary(plan: EpisodePlan, ftpW: number): EpisodeSummary {
  const stats = workoutStats(plan.workout, ftpW);
  const steps = plan.workout.steps;
  const hard = steps.filter((_, i) => plan.blocks[i] === 'hard');
  let hardText = 'No intervals';
  if (hard.length > 0) {
    const durations = new Set(hard.map((s) => stepDurationS(s)));
    const powers = hard.map((s) => (s.kind === 'steady' ? s.power : 0));
    const lo = Math.min(...powers);
    const hi = Math.max(...powers);
    const pct =
      lo === hi ? `${Math.round(lo * 100)} %` : `${Math.round(lo * 100)}–${Math.round(hi * 100)} %`;
    const watts =
      lo === hi
        ? `${Math.round(lo * ftpW)} W`
        : `${Math.round(lo * ftpW)}–${Math.round(hi * ftpW)} W`;
    const each =
      durations.size === 1 ? formatStepDuration(stepDurationS(hard[0]!)) : 'varied lengths';
    hardText = `${hard.length} × ${each} at ${pct} FTP (${watts})`;
  }
  return {
    duration: `${formatStepDuration(plan.totalDurationS)} · ends exactly with the episode`,
    warmup: formatApproxDuration(stepDurationS(steps[0]!)),
    cooldown: formatApproxDuration(stepDurationS(steps[steps.length - 1]!)),
    hard: hardText,
    load: `≈ ${Math.round(stats.tss)} TSS · ${Math.round(stats.workKj)} kJ · avg ${Math.round(stats.averagePowerW)} W`,
    stats,
  };
}

/** "2 min at 110 % (220 W)": what "hard now" inserts for this effort. */
export function hardNowText(options: EpisodeOptions, ftpW: number): string {
  const f = EPISODE_PROFILES[options.effort].hardNow;
  return `${formatStepDuration(HARD_NOW_S)} at ${Math.round(f * 100)} % (${Math.round(f * ftpW)} W)`;
}

/** "Hard 2/5" → "hard", "Cool-down" → "cool-down": the step's kind in a cue. */
export function cueWord(label: string): string {
  return label
    .replace(/\s+\d+\/\d+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * The cue ahead of the next change of an episode workout: "in 10 s: 3 min hard · 250 W", during
 * the last AHEAD_CUE_S seconds of a step (the seconds as the step countdown shows them); null
 * otherwise (and for other workouts).
 */
export function aheadCue(w: WorkoutLive | null | undefined): string | null {
  if (!w?.episode || !w.started || w.finished || !w.next) return null;
  const rem = w.segmentRemainingS;
  if (!Number.isFinite(rem) || rem <= 0 || rem > AHEAD_CUE_S) return null;
  const watts =
    w.next.targetPowerW === null || !Number.isFinite(w.next.targetPowerW)
      ? ''
      : ` · ${Math.round(w.next.targetPowerW)} W`;
  return `in ${Math.max(1, Math.floor(rem))} s: ${formatStepDuration(w.next.durationS)} ${cueWord(w.next.label)}${watts}`;
}

/** The thin progress line of an episode workout: share done and the time left. */
export function episodeProgress(
  w: WorkoutLive | null | undefined,
): { progress: number; left: string } | null {
  if (!w?.episode || !w.started) return null;
  const total = w.episode.lengthS;
  const progress = total > 0 ? Math.min(1, Math.max(0, w.elapsedS / total)) : 0;
  return {
    progress: w.finished ? 1 : progress,
    left: w.finished ? 'Episode done' : `${formatDuration(w.totalRemainingS)} left`,
  };
}
