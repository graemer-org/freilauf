/**
 * What the ghost rider UI shows (docs/ghost.md), as pure functions: the start screen's source
 * picker, the HUD chip on the ride scene, the overlay pill and the summary lines.
 */
import type { GhostChoice, GhostLive } from '../../../shared/contract';
import type { GhostShape } from '../../core/ghost';
import {
  candidateDetail,
  clockTime,
  formatGhostGap,
  formatSplit,
  ghostTone,
  ghostVerdict,
  shortDate,
} from '../../core/ghost';
import type { GhostState, RideSummary } from '../appStore';

/** Free ride: why there is no ghost (shown in place of the picker). */
export const NO_ROUTE_GHOST_NOTE =
  'A ghost rider needs a route: it races you along the same road, by time and distance.';

export interface GhostOption {
  value: GhostChoice | 'import';
  label: string;
  group: 'main' | 'rides';
}

/** The choices of the picker, in order; the earlier rides come under their own heading. */
export function ghostOptions(g: GhostState, shape: GhostShape, now = Date.now()): GhostOption[] {
  const out: GhostOption[] = [];
  const best = g.candidates.find((c) => c.rideId === g.bestRideId) ?? null;
  const last = g.candidates[0] ?? null;
  if (best) {
    out.push({
      value: 'best',
      label: `My best time · ${clockTime(best.fullTimeS ?? 0)} (${shortDate(best.startedAt, now)})`,
      group: 'main',
    });
  }
  if (last) {
    out.push({
      value: 'last',
      label: `My last ride · ${shortDate(last.startedAt, now)} · ${candidateDetail(last, shape)}`,
      group: 'main',
    });
  }
  if (g.imported)
    out.push({ value: 'import', label: `Imported · ${g.imported.label}`, group: 'main' });
  for (const c of g.candidates) {
    out.push({
      value: `ride:${c.rideId}`,
      label: `${shortDate(c.startedAt, now)} · ${candidateDetail(c, shape)}`,
      group: 'rides',
    });
  }
  out.push({ value: 'none', label: 'No ghost', group: 'main' });
  return out;
}

/** The option the picker shows as chosen: what is raced, else the remembered choice. */
export function selectedGhostOption(g: GhostState): GhostChoice | 'import' {
  const a = g.active;
  if (!a) return 'none';
  if (a.kind === 'import') return 'import';
  if (a.kind === 'best' || a.kind === 'last') return a.kind;
  return `ride:${a.rideId ?? ''}`;
}

/** The line under the picker. */
export function ghostHint(g: GhostState, enabled: boolean): string {
  if (!enabled) return 'The ghost rider is off (Settings → Ride).';
  if (g.error) return g.error;
  if (g.loading) return 'Loading the ghost…';
  if (g.active?.kind === 'import' && g.imported?.note) return g.imported.note;
  if (g.active) return 'Starts when the countdown ends, pauses when you pause.';
  if (g.candidates.length === 0 && !g.imported) {
    return 'No earlier ride of this route yet: ride it once to race yourself next time, or import a ride file.';
  }
  return 'No ghost on this ride.';
}

export interface GhostChip {
  text: string;
  tone: 'ahead' | 'behind' | 'even' | 'quiet';
  /** "Ghost" plus status words: "Ghost · finished", "Ghost waits at the finish". */
  title: string;
  /** The latest split, while fresh (10 s). */
  split: string | null;
}

const SPLIT_SHOW_S = 10;

/** The HUD chip on the ride scene; null when there is nothing to show. */
export function ghostChip(g: GhostLive | null | undefined, elapsedS: number): GhostChip | null {
  if (!g) return null;
  const last = g.splits.at(-1) ?? null;
  const split = last && elapsedS - last.atS <= SPLIT_SHOW_S ? formatSplit(last) : null;
  switch (g.status) {
    case 'ready':
      return { text: g.label, tone: 'quiet', title: 'Ghost ready', split: null };
    case 'waiting':
    case 'stopped':
      return {
        text: g.note ?? 'Ghost waits',
        tone: 'quiet',
        title: g.status === 'stopped' ? 'Ghost stopped' : 'Ghost',
        split,
      };
    case 'finished':
      return {
        text: formatGhostGap(null, g.gapS),
        tone: toneOf(g.gapS),
        title: 'Ghost · final gap',
        split,
      };
    default:
      return {
        text: formatGhostGap(g.gapM, g.gapS),
        tone: toneOf(g.gapS),
        title: g.ghostDone ? 'Ghost waits at the finish' : 'Ghost',
        split,
      };
  }
}

function toneOf(gapS: number | null): GhostChip['tone'] {
  return ghostTone(gapS);
}

/** The overlay's ghost pill: text, gap and tone; null without a race to show. */
export function ghostPill(
  g: GhostLive | null | undefined,
): { text: string; detail: string; tone: 'ahead' | 'behind' | 'even' } | null {
  if (!g || g.status === 'ready') return null;
  if (g.status === 'waiting' || g.status === 'stopped') {
    return { text: 'Ghost', detail: g.status === 'stopped' ? 'stopped' : 'waiting', tone: 'even' };
  }
  return {
    text: g.status === 'finished' ? 'Ghost · final' : 'Ghost',
    detail: formatGhostGap(g.status === 'finished' ? null : g.gapM, g.gapS),
    tone: ghostTone(g.gapS),
  };
}

/** The summary's ghost lines; null without a ghost race. */
export function ghostSummary(s: Pick<RideSummary, 'ghost' | 'routeTime'>): {
  verdict: string | null;
  tone: 'ahead' | 'behind' | 'even';
  against: string | null;
  splits: string[];
  best: string | null;
} | null {
  const g = s.ghost ?? null;
  const rt = s.routeTime ?? null;
  const best = rt
    ? rt.previousS === null
      ? `Your first time for the whole route: ${clockTime(rt.timeS)}`
      : rt.timeS < rt.previousS
        ? `New best time on this route: ${clockTime(rt.timeS)} (was ${clockTime(rt.previousS)})`
        : null
    : null;
  if (!g && !best) return null;
  const verdict = g ? ghostVerdict(g.gapS) : null;
  return {
    verdict: verdict && g && !g.complete ? `${verdict} (as far as you both rode)` : verdict,
    tone: ghostTone(g?.gapS ?? null),
    against: g ? g.label : null,
    splits: g ? g.splits.map(formatSplit) : [],
    best,
  };
}
