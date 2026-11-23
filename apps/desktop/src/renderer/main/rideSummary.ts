import type { BestEfforts, RideFacts } from '@freilauf/community';
import { BEST_EFFORT_KEYS } from '@freilauf/community';
import type { RecordedRide } from '@freilauf/session';

/** A best effort this ride improved on (over the rides the community ledger still holds). */
export interface RideBest {
  key: keyof BestEfforts;
  powerW: number;
  previousW: number;
}

/** What the ride just finished came to: the post-ride summary screen. */
export interface RideSummary {
  /** The saved ride; null when it was too short to keep (or could not be saved). */
  rideId: string | null;
  durationS: number;
  distanceM: number;
  /** Average over the recorded samples; null without samples. */
  avgPowerW: number | null;
  /** Points this ride earned; null when it was not scored. */
  points: number | null;
  /** Best efforts that beat every earlier ride's (none on the first ride). */
  bests: RideBest[];
  workoutName: string | null;
  routeName: string | null;
}

export interface SummarizeInput {
  /** The live ride just before it was finished (time and distance of an unsaved ride). */
  live: { elapsedS: number; distanceM: number } | null;
  /** The saved ride, or null when it was not kept. */
  ride: RecordedRide | null;
  /** The community facts of this ride, when it was scored. */
  facts: RideFacts | null;
  /** Facts of the other rides on record (for personal bests). */
  previous: readonly RideFacts[];
  workoutName: string | null;
  routeName: string | null;
}

/** Pure: builds the post-ride summary. */
export function summarizeRide(input: SummarizeInput): RideSummary {
  const { ride, facts } = input;
  const last = ride?.samples.at(-1);
  const durationS = last?.elapsedS ?? input.live?.elapsedS ?? 0;
  const distanceM = last?.distanceM ?? input.live?.distanceM ?? 0;
  const samples = ride?.samples ?? [];
  const avgPowerW =
    samples.length > 0
      ? Math.round(
          samples.reduce((a, s) => a + (Number.isFinite(s.powerW) ? s.powerW : 0), 0) /
            samples.length,
        )
      : null;
  const bests: RideBest[] = [];
  if (facts && input.previous.length > 0) {
    for (const key of BEST_EFFORT_KEYS) {
      const now = facts.best[key];
      if (now === null) continue;
      let prev: number | null = null;
      for (const f of input.previous) {
        if (f.rideId === facts.rideId) continue;
        const v = f.best[key];
        if (v !== null && (prev === null || v > prev)) prev = v;
      }
      if (prev !== null && now > prev) bests.push({ key, powerW: now, previousW: prev });
    }
  }
  return {
    rideId: ride?.id ?? null,
    durationS,
    distanceM,
    avgPowerW,
    points: facts ? facts.points : null,
    bests,
    workoutName: input.workoutName,
    routeName: input.routeName,
  };
}
