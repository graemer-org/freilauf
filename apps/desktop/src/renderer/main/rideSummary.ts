import type { BestEfforts, RideFacts } from '@freilauf/community';
import { BEST_EFFORT_KEYS } from '@freilauf/community';
import type { RecordedRide } from '@freilauf/session';
import { rideEnergy } from '@freilauf/session';
import type { LiveEnergy } from '../../shared/contract';
import type { GhostResult } from '../core/ghost';

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
  /**
   * Metres the race position gained from power-ups (0 without). Shown on its own line: time,
   * distance, power, points and bests above never include it.
   */
  powerUpGainM?: number;
  /**
   * Freilauf Rumble only: the race offset split into metres gained from own items (≥ 0) and lost
   * to hits (≤ 0), each shown on its own line ("+38 m from items", "−24 m from hits").
   */
  rumble?: { gainM: number; lossM: number } | null;
  /**
   * Energy estimates (docs/energy.md): kcal from power, the heart-rate cross-check and the
   * fat/carbohydrate split. null when the ride was not kept or has neither power nor a
   * heart-rate estimate (nothing is shown then).
   */
  energy?: LiveEnergy | null;
  /** The race against the ghost (docs/ghost.md); null/absent without one. */
  ghost?: GhostResult | null;
  /**
   * This ride's time for the whole route (start to finish, or a full lap) and the best one
   * before it; null when it did not ride the whole route in one go.
   */
  routeTime?: { timeS: number; previousS: number | null } | null;
  /**
   * Ridden with the historical wind of a day (docs/adr/0012-historical-wind.md): its label,
   * "14 June 2025"; null/absent without wind. The route time above is then compared only
   * with rides of the same wind.
   */
  windLabel?: string | null;
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
  /** Race offset from power-ups at the finish (m); absent = 0. */
  powerUpGainM?: number;
  /** Rumble: gain from items and loss to hits at the finish (m). */
  rumble?: { gainM: number; lossM: number } | null;
  /** The ghost race at the finish; absent = none. */
  ghost?: GhostResult | null;
  /** See RideSummary.routeTime. */
  routeTime?: { timeS: number; previousS: number | null } | null;
  /** See RideSummary.windLabel. */
  windLabel?: string | null;
  /** Age and sex for the heart-rate estimate (Settings.rider); absent = none. */
  rider?: { ageYears?: number | null; sex?: string | null; ftpW?: number | null } | null;
}

/** Pure: builds the post-ride summary. */
export function summarizeRide(input: SummarizeInput): RideSummary {
  const { ride, facts } = input;
  const gain = input.powerUpGainM ?? 0;
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
  const e = ride ? rideEnergy(ride, input.rider ?? {}) : null;
  const energy: LiveEnergy | null =
    e && e.kcal !== null
      ? {
          kcal: e.kcal,
          source: e.source,
          kcalPower: e.kcalPower,
          kcalHr: e.kcalHr,
          fatG: e.fatG,
          carbG: e.carbG,
        }
      : null;
  return {
    rideId: ride?.id ?? null,
    durationS,
    distanceM,
    avgPowerW,
    points: facts ? facts.points : null,
    bests,
    workoutName: input.workoutName,
    routeName: input.routeName,
    powerUpGainM: gain > 0 && Number.isFinite(gain) ? Math.round(gain) : 0,
    ...(input.rumble
      ? {
          rumble: {
            gainM: Number.isFinite(input.rumble.gainM)
              ? Math.max(0, Math.round(input.rumble.gainM))
              : 0,
            lossM: Number.isFinite(input.rumble.lossM)
              ? Math.min(0, Math.round(input.rumble.lossM))
              : 0,
          },
        }
      : {}),
    energy,
    ...(ride && input.ghost ? { ghost: input.ghost } : {}),
    ...(ride && input.routeTime ? { routeTime: input.routeTime } : {}),
    ...(ride && input.windLabel ? { windLabel: input.windLabel } : {}),
  };
}
