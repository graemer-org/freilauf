/**
 * Like with like (docs/adr/0012-historical-wind.md): a ride with a day's wind is never the best
 * time of rides without wind, and the other way round; racing a ghost of other conditions is
 * allowed but said.
 */
import type { RecordedRide } from '@freilauf/session';
import { rideRouteInfo, validRideRoute } from '@freilauf/session';
import { describe, expect, it } from 'vitest';
import type { GhostState } from '../main/appStore';
import { ghostOptions, ghostSummary } from '../main/ui/ghostView';
import { summarizeRide } from '../main/rideSummary';
import type { GhostCandidate } from './ghost';
import { bestGhost, conditionsNote, ghostLabel, resolveGhostChoice } from './ghost';

const WIND = '2025-06-14T10:00';
const shape = { lengthM: 10_000, loop: false };
const c = (
  id: string,
  t: number,
  conditions: string | null,
  startedAt: number,
): GhostCandidate => ({
  rideId: id,
  name: 'r',
  startedAt,
  fullTimeS: t,
  fromM: 0,
  toM: 10_000,
  continuous: true,
  conditions,
  conditionsLabel: conditions ? '14 June 2025' : null,
});
// Newest first: a fast tailwind ride, a calm ride, a slower calm ride.
const rides = [
  c('tail', 900, WIND, 3),
  c('calm', 1100, null, 2),
  c('calm-slow', 1200, null, 1),
  c('other-day', 800, '2024-03-01T10:00', 0),
];

describe('best time and ghost: like with like', () => {
  it('picks the best time only among rides of the same conditions', () => {
    expect(bestGhost(rides)?.rideId).toBe('calm');
    expect(bestGhost(rides, null)?.rideId).toBe('calm');
    expect(bestGhost(rides, WIND)?.rideId).toBe('tail');
    expect(bestGhost(rides, '2023-01-01T10:00')).toBeNull();
    // Rides recorded before the weather existed count as without wind.
    const old = { ...c('old', 1000, null, 5) };
    delete (old as Partial<GhostCandidate>).conditions;
    expect(bestGhost([old, ...rides], null)?.rideId).toBe('old');
  });

  it('resolves "best" in the current conditions, "last" regardless, and labels the difference', () => {
    expect(resolveGhostChoice('best', rides, true, null).ride?.rideId).toBe('calm');
    expect(resolveGhostChoice('best', rides, true, WIND).ride?.rideId).toBe('tail');
    const last = resolveGhostChoice('last', rides, true, null);
    expect(last.ride?.rideId).toBe('tail');
    expect(ghostLabel(last, shape, 10, null)).toMatch(/with wind of 14 June 2025$/);
    expect(ghostLabel(resolveGhostChoice('ride:calm', rides, true, WIND), shape, 10, WIND)).toMatch(
      / · without wind$/,
    );
    expect(conditionsNote(rides[1]!, null)).toBe('');
  });

  it('the start screen offers all rides, saying which had other conditions', () => {
    const g: GhostState = {
      routeId: 'route-x',
      candidates: rides,
      bestRideId: 'tail',
      conditions: WIND,
      choice: 'best',
      active: null,
      imported: null,
      loading: false,
      error: null,
    };
    const opts = ghostOptions(g, shape, 10);
    expect(opts[0]!.label).toMatch(/^My best time with this wind · 15:00/);
    expect(opts.find((o) => o.value === 'ride:calm')!.label).toMatch(/without wind$/);
    expect(opts.find((o) => o.value === 'ride:tail')!.label).not.toMatch(/wind/);
  });
});

describe('the ride’s conditions are recorded and shown', () => {
  const ride = (weather?: { key: string; label: string }): RecordedRide => ({
    id: 'ride-1',
    name: 'North road',
    startedAt: Date.UTC(2026, 10, 1),
    riderMassKg: 75,
    route: {
      id: 'route-x',
      lengthM: 1000,
      loop: false,
      offsetsM: [0],
      ...(weather ? { weather } : {}),
    },
    samples: Array.from({ length: 200 }, (_, i) => ({
      timestamp: i * 1000,
      elapsedS: i + 1,
      powerW: 200,
      cadenceRpm: 90,
      heartRateBpm: null,
      speedMps: 8,
      distanceM: (i + 1) * 8,
      gradePercent: 0,
      gear: 12,
    })),
  });

  it('keeps the flag in the ride’s route info; a broken flag counts as no wind', () => {
    const w = { key: WIND, label: '14 June 2025' };
    expect(validRideRoute(ride(w).route)?.weather).toEqual(w);
    expect(rideRouteInfo(ride(w))?.weather).toEqual(w);
    expect(rideRouteInfo(ride())?.weather).toBeUndefined();
    expect(validRideRoute({ ...ride().route, weather: { key: 3 } })?.weather).toBeUndefined();
  });

  it('the summary says "With wind of …" and compares the route time within that wind', () => {
    const s = summarizeRide({
      live: null,
      ride: ride({ key: WIND, label: '14 June 2025' }),
      facts: null,
      previous: [],
      workoutName: null,
      routeName: 'North road',
      routeTime: { timeS: 125, previousS: 130 },
      windLabel: '14 June 2025',
    });
    expect(s.windLabel).toBe('14 June 2025');
    expect(ghostSummary(s)?.best).toBe(
      'New best time on this route with the wind of 14 June 2025: 2:05 (was 2:10)',
    );
    const calm = summarizeRide({
      live: null,
      ride: ride(),
      facts: null,
      previous: [],
      workoutName: null,
      routeName: 'North road',
    });
    expect(calm.windLabel).toBeUndefined();
  });
});
