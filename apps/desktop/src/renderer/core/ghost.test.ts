import { describe, expect, it } from 'vitest';
import type { RideListItem } from '../../shared/contract';
import type { GhostInput } from './ghost';
import {
  GhostRace,
  bestGhost,
  candidateDetail,
  formatGhostGap,
  formatSplit,
  ghostCandidates,
  ghostLabel,
  ghostTone,
  ghostVerdict,
  resolveGhostChoice,
  splitPoints,
} from './ghost';

/** A ghost at a constant 10 m/s from `fromM` to `toM`. */
function steady(fromM: number, toM: number, speed = 10, t0 = 0) {
  const timeS: number[] = [];
  const distanceM: number[] = [];
  for (let d = fromM; d <= toM + 1e-9; d += 5) {
    timeS.push(t0 + (d - fromM) / speed);
    distanceM.push(d);
  }
  return { timeS, distanceM };
}

const p2p = { lengthM: 1000, loop: false };
const loop = { lengthM: 1000, loop: true };

/** Feeds a rider at `speed` from `startM`; returns the last live state. */
function ride(
  race: GhostRace,
  {
    from = 0,
    speed = 10,
    seconds = 10,
    t0 = 0,
    jumps = 0,
    state = 'riding' as GhostInput['state'],
  } = {},
) {
  let live = race.update({ state, elapsedS: t0, routeM: from, jumps });
  for (let i = 1; i <= seconds * 4; i++) {
    const t = t0 + i / 4;
    live = race.update({ state, elapsedS: t, routeM: from + (t - t0) * speed, jumps });
  }
  return live;
}

describe('GhostRace: gaps in metres and seconds', () => {
  it('before the ride: ready, next to the rider', () => {
    const race = new GhostRace(steady(0, 1000), p2p, 'Best time · 1:40');
    expect(race.update({ state: 'idle', elapsedS: 0, routeM: 0, jumps: 0 })).toMatchObject({
      status: 'ready',
      aheadM: 0,
      gapS: null,
      label: 'Best time · 1:40',
    });
  });

  it('faster than the ghost: ahead by metres and seconds (interpolated)', () => {
    const race = new GhostRace(steady(0, 1000, 10), p2p, 'g');
    const live = ride(race, { speed: 12, seconds: 20 });
    // At 20 s: rider at 240 m, ghost at 200 m. The ghost reaches 240 m at 24 s.
    expect(live.status).toBe('racing');
    expect(live.gapM).toBeCloseTo(40, 6);
    expect(live.gapS).toBeCloseTo(4, 6);
    expect(live.aheadM).toBeCloseTo(-40, 6);
    expect(live.speedMps).toBeCloseTo(10, 6);
  });

  it('slower: behind (negative), and the ghost is ahead in the scene', () => {
    const race = new GhostRace(steady(0, 1000, 10), p2p, 'g');
    const live = ride(race, { speed: 8, seconds: 25 });
    expect(live.gapM).toBeCloseTo(-50, 6);
    expect(live.gapS).toBeCloseTo(-5, 6);
    expect(live.aheadM).toBeCloseTo(50, 6);
  });

  it('pauses with the ride: moving time stands still, so does the ghost', () => {
    const race = new GhostRace(steady(0, 1000, 10), p2p, 'g');
    const before = ride(race, { speed: 10, seconds: 10 });
    // Paused: the ride's moving time and place do not change.
    let live = before;
    for (let i = 0; i < 40; i++) {
      live = race.update({ state: 'paused', elapsedS: 10, routeM: 100, jumps: 0 });
    }
    expect(live.gapM).toBeCloseTo(before.gapM!, 9);
    expect(live.aheadM).toBeCloseTo(0, 6);
    expect(live.speedMps).toBe(0);
  });

  it('the ghost finishes first: it waits at the finish; the final gap is frozen when you cross', () => {
    const race = new GhostRace(steady(0, 1000, 10), p2p, 'g');
    const mid = ride(race, { speed: 8, seconds: 110 }); // ghost done at 100 s
    expect(mid.ghostDone).toBe(true);
    expect(mid.aheadM).toBeCloseTo(1000 - 880, 6);
    expect(mid.speedMps).toBe(0);
    const end = ride(race, { from: 880, t0: 110, speed: 8, seconds: 20 });
    expect(end.status).toBe('finished');
    // The rider reaches 1000 m at 125 s: 25 s slower.
    expect(end.gapS).toBeCloseTo(-25, 6);
    expect(race.result()).toMatchObject({ complete: true });
    expect(race.result().gapS).toBeCloseTo(-25, 6);
  });

  it('a lapped route compares by total route distance and splits at every lap', () => {
    const race = new GhostRace(steady(0, 3000, 10), loop, 'g');
    const live = ride(race, { speed: 12.5, seconds: 200 }); // 2500 m
    expect(live.splits.map((s) => s.label)).toEqual(['Lap 1', 'Lap 2']);
    expect(live.splits[0]!.gapS).toBeCloseTo(20, 1); // 80 s vs 100 s
    expect(live.splits[1]!.gapS).toBeCloseTo(40, 1);
    expect(live.gapS).toBeCloseTo(50, 6);
    expect(formatSplit(live.splits[0]!)).toBe('Lap 1 · +20.0 s');
  });

  it('a ride started part-way races the ghost from there', () => {
    const race = new GhostRace(steady(0, 1000, 10), p2p, 'g');
    const live = ride(race, { from: 400, speed: 10, seconds: 10 });
    expect(live.gapM).toBeCloseTo(0, 6);
    expect(live.gapS).toBeCloseTo(0, 6);
  });

  it('a ghost that covers only part of the route joins when the rider gets there', () => {
    const race = new GhostRace(steady(300, 800, 10, 31), p2p, 'g');
    expect(race.update({ state: 'idle', elapsedS: 0, routeM: 0, jumps: 0 })).toMatchObject({
      status: 'ready',
      note: 'Ghost joins at km 0.3',
    });
    const before = ride(race, { speed: 10, seconds: 20 });
    expect(before).toMatchObject({ status: 'waiting', aheadM: null, gapS: null });
    const after = ride(race, { from: 200, t0: 20, speed: 10, seconds: 20 });
    expect(after.status).toBe('racing');
    expect(after.gapS).toBeCloseTo(0, 1);
  });
});

describe('GhostRace: jumps', () => {
  it('a jump keeps the time gap and compares at the new place', () => {
    const race = new GhostRace(steady(0, 1000, 10), p2p, 'g');
    const before = ride(race, { speed: 12, seconds: 10 }); // +2 s at 120 m
    expect(before.gapS).toBeCloseTo(2, 6);
    const after = ride(race, { from: 600, t0: 10, speed: 10, seconds: 5, jumps: 1 });
    // Same speed as the ghost since the jump: still +2 s, i.e. +20 m at 10 m/s.
    expect(after.status).toBe('racing');
    expect(after.gapS).toBeCloseTo(2, 6);
    expect(after.gapM).toBeCloseTo(20, 6);
  });

  it('a jump to where the ghost never rode stops it, clearly; a jump back resumes', () => {
    const race = new GhostRace(steady(0, 500, 10), { lengthM: 1000, loop: false }, 'g');
    ride(race, { speed: 11, seconds: 10 });
    const stopped = ride(race, { from: 700, t0: 10, speed: 10, seconds: 2, jumps: 1 });
    expect(stopped).toMatchObject({ status: 'stopped', aheadM: null });
    expect(stopped.note).toBe('Ghost stopped: it never rode km 0.7');
    expect(stopped.gapS).toBeCloseTo(1, 6);
    const back = ride(race, { from: 200, t0: 12, speed: 10, seconds: 2, jumps: 2 });
    expect(back.status).toBe('racing');
    expect(back.gapS).toBeCloseTo(1, 6);
  });

  it('on a loop a jump stays in the same lap of the race', () => {
    const race = new GhostRace(steady(0, 3000, 10), loop, 'g');
    ride(race, { speed: 10, seconds: 120 }); // lap 2, 1200 m, level
    const after = ride(race, { from: 1800, t0: 120, speed: 10, seconds: 4, jumps: 1 });
    expect(after.gapS).toBeCloseTo(0, 6);
    expect(after.gapM).toBeCloseTo(0, 6);
  });
});

describe('split points', () => {
  it('quarters on a point-to-point route, laps on a loop', () => {
    expect(splitPoints(p2p, 0, 1000).map((s) => s.label)).toEqual([
      'km 0.3',
      'km 0.5',
      'km 0.8',
      'Finish',
    ]);
    expect(splitPoints(p2p, 400, 1000).map((s) => s.atM)).toEqual([500, 750, 1000]);
    expect(splitPoints(loop, 0, 2500).map((s) => s.label)).toEqual(['Lap 1', 'Lap 2']);
  });
});

describe('ghost sources', () => {
  const item = (
    id: string,
    startedAt: number,
    route: RideListItem['route'] | undefined,
    finished = true,
  ): RideListItem => ({
    id,
    name: 'Rolling loop',
    startedAt,
    durationS: 600,
    distanceM: 5000,
    avgPowerW: 200,
    finished,
    ...(route ? { route } : {}),
  });
  const full = (s: number) => ({
    id: 'r1',
    fromM: 0,
    toM: 1000,
    fullTimeS: s,
    continuous: true,
    ghost: true,
  });
  const rides = [
    item('a', 1, full(130)),
    item('b', 3, full(120)),
    item('c', 4, {
      id: 'r1',
      fromM: 200,
      toM: 700,
      fullTimeS: null,
      continuous: false,
      ghost: true,
    }),
    item('d', 5, full(100), false), // an unfinished autosave
    item('e', 6, { ...full(90), id: 'other' }),
    item('f', 7, undefined),
    item('g', 2, { ...full(120) }),
  ];
  const c = ghostCandidates(rides, 'r1');

  it('lists finished rides of this route, newest first', () => {
    expect(c.map((x) => x.rideId)).toEqual(['c', 'b', 'g', 'a']);
  });

  it('best: the fastest full ride, the newer one on a tie; jumped rides never count', () => {
    expect(bestGhost(c)?.rideId).toBe('b');
    expect(bestGhost(c.filter((x) => x.rideId === 'c'))).toBeNull();
  });

  it('resolves remembered choices, with sensible fallbacks', () => {
    expect(resolveGhostChoice(undefined, c)).toMatchObject({ kind: 'best', ride: { rideId: 'b' } });
    expect(resolveGhostChoice('last', c)).toMatchObject({ kind: 'last', ride: { rideId: 'c' } });
    expect(resolveGhostChoice('ride:a', c)).toMatchObject({ kind: 'ride', ride: { rideId: 'a' } });
    expect(resolveGhostChoice('ride:gone', c)).toMatchObject({ kind: 'best' });
    expect(resolveGhostChoice('none', c)).toEqual({ kind: 'none', ride: null });
    expect(resolveGhostChoice('best', c, false)).toEqual({ kind: 'none', ride: null });
    expect(
      resolveGhostChoice(
        undefined,
        c.filter((x) => x.rideId === 'c'),
      ),
    ).toMatchObject({
      kind: 'last',
    });
    expect(resolveGhostChoice(undefined, [])).toEqual({ kind: 'none', ride: null });
  });

  it('labels', () => {
    const now = new Date(2026, 10, 26).getTime();
    const best = resolveGhostChoice(undefined, c);
    expect(ghostLabel(best, p2p, now)).toBe('Best time · 2:00');
    const jumped = c.find((x) => x.rideId === 'c')!;
    expect(candidateDetail(jumped, p2p)).toBe('jumped · km 0.2–km 0.7');
    expect(
      ghostLabel(
        { kind: 'last', ride: { ...jumped, startedAt: new Date(2026, 10, 2).getTime() } },
        p2p,
        now,
      ),
    ).toBe('Last ride · 2 Nov · jumped · km 0.2–km 0.7');
  });
});

describe('words', () => {
  it('formats the gap chip with signs', () => {
    expect(formatGhostGap(12.2, 2.06)).toBe('+12 m · +2.1 s');
    expect(formatGhostGap(-8, -1.44)).toBe('−8 m · −1.4 s');
    expect(formatGhostGap(0.2, 0.01)).toBe('±0 m · ±0.0 s');
    expect(formatGhostGap(null, 3)).toBe('+3.0 s');
  });
  it('tone and verdict', () => {
    expect(ghostTone(2)).toBe('ahead');
    expect(ghostTone(-0.5)).toBe('behind');
    expect(ghostTone(0.01)).toBe('even');
    expect(ghostVerdict(12.44)).toBe('You beat your ghost by 12.4 s');
    expect(ghostVerdict(-3)).toBe('Your ghost was 3.0 s faster');
    expect(ghostVerdict(null)).toBeNull();
  });
});
