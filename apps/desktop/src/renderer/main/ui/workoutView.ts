/**
 * Pure presentation helpers for structured workouts: chart geometry, target
 * deviation, short texts. No React, no DOM — unit-tested directly.
 */
import type { Timeline, Workout, WorkoutStats, WorkoutStep } from '@freilauf/workouts';
import { POWER_ZONES, buildTimeline, zoneOf } from '@freilauf/workouts';
import type { WorkoutLive } from '../../../shared/contract';
import type { WorkoutEntry } from '../../core/workoutLibrary';

const MINUS = '−';

// ───────────── durations ─────────────

/** Compact duration for lists and "next" hints: `30 s`, `4 min`, `1:30 min`, `1 h 5 min`. */
export function formatStepDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s >= 3600) {
    const totalMin = Math.round(s / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} min` : `${m}:${String(rest).padStart(2, '0')} min`;
}

/** Rounded to whole minutes from a minute up: `45 s`, `23 min`, `1 h 4 min`. */
export function formatApproxDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return formatStepDuration(seconds);
  return formatStepDuration(Math.round(seconds / 60) * 60);
}

// ───────────── live texts ─────────────

/** "Next: 4 min @ 240 W", "Next: free ride", or "Last step". */
export function nextText(next: WorkoutLive['next'] | undefined): string {
  if (!next) return 'Last step';
  const duration = formatStepDuration(next.durationS);
  if (next.targetPowerW === null) return `Next: ${duration} free ride`;
  return `Next: ${duration} @ ${Math.round(next.targetPowerW)} W`;
}

/** The mode line of the running workout, in plain words. */
export function modeText(w: Pick<WorkoutLive, 'mode' | 'finished' | 'ftpTest'>): string {
  if (w.finished) return 'Keep riding or finish';
  if (w.mode === 'free') {
    return w.ftpTest === 'twentyMinute'
      ? 'All out for 20 minutes — pace yourself'
      : 'Free ride: the trainer is in free-ride mode, you set the pace';
  }
  return w.ftpTest === 'ramp'
    ? 'Hold the target as long as you can — the test ends when you cannot'
    : 'The trainer holds the target power';
}

export type DeviationLevel = 'calm' | 'warn' | 'alert';

export interface Deviation {
  /** Actual − target, whole watts. */
  deltaW: number;
  /** deltaW / target. */
  ratio: number;
  level: DeviationLevel;
  direction: 'over' | 'under' | 'on';
  text: string;
}

/** Within ±5 % is calm, up to ±10 % a nudge, beyond that insistent. */
export const DEVIATION_CALM = 0.05;
export const DEVIATION_WARN = 0.1;

export function classifyDeviation(actualW: number, targetW: number): Deviation {
  const actual = Number.isFinite(actualW) ? actualW : 0;
  if (!Number.isFinite(targetW) || targetW <= 0) {
    return { deltaW: 0, ratio: 0, level: 'calm', direction: 'on', text: 'On target' };
  }
  const deltaW = Math.round(actual - targetW);
  const ratio = (actual - targetW) / targetW;
  const abs = Math.abs(ratio);
  const level: DeviationLevel =
    abs <= DEVIATION_CALM ? 'calm' : abs <= DEVIATION_WARN ? 'warn' : 'alert';
  if (level === 'calm') return { deltaW, ratio, level, direction: 'on', text: 'On target' };
  const direction = deltaW > 0 ? 'over' : 'under';
  return {
    deltaW,
    ratio,
    level,
    direction,
    text: `${Math.abs(deltaW)} W ${direction}`,
  };
}

/**
 * Position of the deviation marker on a centred bar, as a percentage of
 * the bar width (50 = on target), clamped to the visible ±range.
 */
export function deviationPosition(ratio: number, range = 0.2): number {
  const r = Number.isFinite(ratio) ? Math.max(-range, Math.min(range, ratio)) : 0;
  return 50 + (r / range) * 50;
}

/** One 5 % intensity step up or down, within 50–150 %. */
export function nudgeIntensity(current: number, direction: 1 | -1): number {
  const base = Number.isFinite(current) ? current : 1;
  const next = Math.round(base * 20 + direction) / 20;
  return Math.min(1.5, Math.max(0.5, next));
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/** "+38 W (+19 %)", "−12 W (−5 %)", "no change". */
export function formatFtpChange(previousW: number, nextW: number): string {
  const delta = Math.round(nextW - previousW);
  if (delta === 0 || !Number.isFinite(delta)) return 'no change';
  const sign = delta > 0 ? '+' : MINUS;
  const pct = previousW > 0 ? Math.round((Math.abs(delta) / previousW) * 100) : null;
  return `${sign}${Math.abs(delta)} W${pct !== null ? ` (${sign}${pct} %)` : ''}`;
}

// ───────────── library ─────────────

/** Entries without duplicate ids (the 20-minute test is both a test and in the library). */
export function uniqueEntries(entries: readonly WorkoutEntry[]): WorkoutEntry[] {
  const seen = new Set<string>();
  const out: WorkoutEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.workout.id)) continue;
    seen.add(e.workout.id);
    out.push(e);
  }
  return out;
}

export interface StepRow {
  label: string;
  duration: string;
  target: string;
}

function pctWatts(fraction: number, ftpW: number): { pct: string; watts: string } {
  return { pct: `${Math.round(fraction * 100)} %`, watts: `${Math.round(fraction * ftpW)} W` };
}

function stepTarget(step: WorkoutStep, ftpW: number): string {
  switch (step.kind) {
    case 'steady': {
      const t = pctWatts(step.power, ftpW);
      return `${t.pct} FTP · ${t.watts}`;
    }
    case 'ramp': {
      const a = pctWatts(step.powerStart, ftpW);
      const b = pctWatts(step.powerEnd, ftpW);
      return `${a.pct} → ${b.pct} FTP · ${a.watts} → ${b.watts}`;
    }
    case 'intervals': {
      const on = pctWatts(step.onPower, ftpW);
      const off = pctWatts(step.offPower, ftpW);
      return `${on.pct} · ${on.watts} on / ${off.pct} · ${off.watts} off`;
    }
    case 'freeRide':
      return step.gradePercent !== undefined
        ? `Free ride · you pace · ${step.gradePercent} % gradient`
        : 'Free ride · you pace';
  }
}

/** The workout's steps as rows for the detail view. */
export function stepRows(workout: Workout, ftpW: number): StepRow[] {
  const timeline = buildTimeline(workout);
  return workout.steps.map((step, i) => {
    let label: string;
    let duration: string;
    if (step.kind === 'intervals') {
      label = step.label ?? 'Intervals';
      duration = `${step.repeat} × (${formatStepDuration(step.onDurationS)} + ${formatStepDuration(step.offDurationS)})`;
    } else {
      // The timeline knows the default names (Warm-up, Cool-down …).
      label = step.label ?? timeline.segments.find((s) => s.stepIndex === i)?.label ?? 'Step';
      duration = formatStepDuration(step.durationS);
    }
    return { label, duration, target: stepTarget(step, ftpW) };
  });
}

export interface ZoneRow {
  zone: number;
  name: string;
  seconds: number;
  /** Share of the whole workout, 0…1. */
  share: number;
}

/** Zones with time in them, plus free ride as zone 0. */
export function zoneRows(stats: WorkoutStats): ZoneRow[] {
  const total = stats.durationS > 0 ? stats.durationS : 1;
  const rows: ZoneRow[] = POWER_ZONES.map((z, i) => ({
    zone: z.zone,
    name: z.name,
    seconds: stats.timeInZonesS[i] ?? 0,
    share: (stats.timeInZonesS[i] ?? 0) / total,
  })).filter((r) => r.seconds > 0);
  if (stats.freeRideS > 0) {
    rows.push({
      zone: 0,
      name: 'Free ride',
      seconds: stats.freeRideS,
      share: stats.freeRideS / total,
    });
  }
  return rows;
}

// ───────────── chart ─────────────

export interface ChartShape {
  /** SVG polygon points in the chart's coordinate space. */
  points: string;
  /** Power zone 1–7; null = free ride (drawn neutral and hatched). */
  zone: number | null;
}

export interface ChartGeometry {
  width: number;
  height: number;
  shapes: ChartShape[];
  /** y of 100 % FTP. */
  ftpY: number;
  /** Seconds shown on the x axis. */
  horizonS: number;
}

export const CHART_WIDTH = 1000;
export const CHART_HEIGHT = 100;
/** Ramps are cut into slices of about this length so their colour follows the zones. */
const RAMP_SLICE_S = 30;
const MAX_RAMP_SLICES = 24;
const SEAM_OVERLAP = 2.5;

const r1 = (v: number): string => String(Math.round(v * 10) / 10);

/**
 * Bars per segment, coloured by zone: steady blocks are rectangles, ramps a
 * run of trapezoids, free ride a neutral block at its expected effort.
 * `horizonS` crops open-ended workouts (the ramp test) to the useful part.
 */
export function chartGeometry(
  source: Workout | Timeline,
  options: { horizonS?: number; width?: number; height?: number } = {},
): ChartGeometry {
  const timeline = 'segments' in source ? source : buildTimeline(source);
  const width = options.width ?? CHART_WIDTH;
  const height = options.height ?? CHART_HEIGHT;
  const total = timeline.totalDurationS;
  const horizonS =
    options.horizonS !== undefined && options.horizonS > 0
      ? Math.min(total, options.horizonS)
      : total;

  let maxFraction = 1.1;
  for (const seg of timeline.segments) {
    if (seg.startS >= horizonS) break;
    maxFraction = Math.max(maxFraction, seg.powerStart ?? 0, seg.powerEnd ?? 0);
  }
  // Headroom so the highest block does not touch the top.
  const top = maxFraction * 1.08;
  const x = (t: number): number => (horizonS > 0 ? (Math.min(t, horizonS) / horizonS) * width : 0);
  const y = (f: number): number => height - (Math.max(0, f) / top) * height;

  const shapes: ChartShape[] = [];
  const quad = (t0: number, t1: number, f0: number, f1: number, zone: number | null): void => {
    // Overlap the next shape slightly: abutting edges would show anti-aliasing seams.
    const x0 = r1(x(t0));
    const x1 = r1(Math.min(width, x(t1) + (x(t1) < width ? SEAM_OVERLAP : 0)));
    shapes.push({
      points: `${x0},${height} ${x0},${r1(y(f0))} ${x1},${r1(y(f1))} ${x1},${height}`,
      zone,
    });
  };

  for (const seg of timeline.segments) {
    if (seg.startS >= horizonS || horizonS <= 0) break;
    const end = Math.min(seg.endS, horizonS);
    if (seg.powerStart === null || seg.powerEnd === null) {
      const f = seg.expectedPower ?? 0.5;
      quad(seg.startS, end, f, f, null);
      continue;
    }
    if (seg.powerStart === seg.powerEnd) {
      quad(seg.startS, end, seg.powerStart, seg.powerEnd, zoneOf(seg.powerStart));
      continue;
    }
    const slices = Math.max(1, Math.min(MAX_RAMP_SLICES, Math.round(seg.durationS / RAMP_SLICE_S)));
    const step = seg.durationS / slices;
    const at = (t: number): number =>
      (seg.powerStart as number) +
      (((seg.powerEnd as number) - (seg.powerStart as number)) * (t - seg.startS)) / seg.durationS;
    for (let i = 0; i < slices; i++) {
      const t0 = seg.startS + i * step;
      if (t0 >= end) break;
      const t1 = Math.min(end, seg.startS + (i + 1) * step);
      quad(t0, t1, at(t0), at(t1), zoneOf(at((t0 + t1) / 2)));
    }
  }
  return { width, height, shapes, ftpY: y(1), horizonS };
}

/**
 * For open-ended tests: stop the chart where the target passes 160 % FTP,
 * which only the strongest efforts reach.
 */
export function openEndedHorizonS(workout: Workout, ceiling = 1.6): number {
  const timeline = buildTimeline(workout);
  const beyond = timeline.segments.find((s) => (s.powerStart ?? 0) > ceiling);
  return beyond ? beyond.startS : timeline.totalDurationS;
}

/** Text alternative for a power profile chart. */
export function chartSummary(workout: Workout, stats: WorkoutStats, openEnded = false): string {
  const parts: string[] = [];
  parts.push(
    openEnded
      ? `Power profile of ${workout.name}: warm-up, then a ramp rising every minute until you stop`
      : `Power profile of ${workout.name}, ${formatStepDuration(stats.durationS)}`,
  );
  const timeline = buildTimeline(workout);
  let peak = 0;
  for (const s of timeline.segments) peak = Math.max(peak, s.powerStart ?? 0, s.powerEnd ?? 0);
  if (!openEnded && peak > 0) parts.push(`peaks at ${Math.round(peak * 100)} % FTP`);
  const zones = zoneRows(stats).filter((z) => z.zone > 0);
  const main = zones.reduce<ZoneRow | null>((a, b) => (a && a.seconds >= b.seconds ? a : b), null);
  if (main && !openEnded) parts.push(`mostly zone ${main.zone} (${main.name.toLowerCase()})`);
  if (stats.freeRideS > 0)
    parts.push(`includes ${formatStepDuration(stats.freeRideS)} of free ride`);
  return `${parts.join(', ')}.`;
}

/** Position of a marker on the chart, 0…1 of the horizon. */
export function chartProgress(elapsedS: number, horizonS: number): number {
  if (!Number.isFinite(elapsedS) || horizonS <= 0) return 0;
  return Math.max(0, Math.min(1, elapsedS / horizonS));
}
