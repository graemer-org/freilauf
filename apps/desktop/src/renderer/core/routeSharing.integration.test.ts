/**
 * Route sharing end to end over the real GroupRide (via the app's adaptGroupRide), next to a
 * shared workout and the community sync, which has to make room for it.
 */
import { KIND_STANDING } from '@freilauf/community';
import { GroupRide } from '@freilauf/p2p';
import { createTestNetwork, FakeClock, TEST_TRANSPORTS } from '@freilauf/p2p/testing';
import { buildRoute, getBuiltinRoute, gradeAt, unproject } from '@freilauf/routes';
import { encodeWorkout, getBuiltinWorkout } from '@freilauf/workouts';
import { describe, expect, it } from 'vitest';
import { adaptGroupRide } from '../main/groupConnector';
import { CommunityService } from './communityService';
import {
  ROUTE_KIND,
  decodeSharedRoutes,
  routeShareBudget,
  shareRouteInGroup,
} from './routeSharing';
import { CET, T0, memoryStorage, syntheticRide, DAY } from './testing/communityFixtures';

function longRoute(km: number) {
  const points = [];
  let x = 0;
  let y = 0;
  let h = 0;
  for (let s = 0; s <= km * 1000; s += 10) {
    h += 0.02 * Math.sin(s / 400) + 0.01 * Math.sin(s / 97);
    x += 10 * Math.sin(h);
    y += 10 * Math.cos(h);
    points.push({ ...unproject({ lat0: 47, lon0: 11 }, x, y), ele: 600 + 80 * Math.sin(s / 3000) });
  }
  return buildRoute({ name: `${km} km`, hasElevation: true, points });
}

describe.each(TEST_TRANSPORTS)('route sharing over GroupRide (%s)', (kind) => {
  async function world() {
    const clock = new FakeClock(T0);
    const network = createTestNetwork(kind, { clock, seed: 5 });
    let seed = 17;
    const rider = async (name: string, peerId: string, host: GroupRide | null) => {
      let state = (seed += 7919);
      const random = () => {
        state = (state * 1103515245 + 12345) % 2 ** 31;
        return state / 2 ** 31;
      };
      const svc = new CommunityService({
        storage: memoryStorage(),
        now: clock.now,
        utcOffsetMin: () => CET,
        random,
        timers: clock.timers,
        saveDelayMs: 1_000,
        yieldToUi: async () => {},
      });
      svc.setDisplayName(name);
      svc.recordRide(syntheticRide(`${name}-1`, T0 - DAY, 3600, 200), {
        ftpW: 250,
        groupRide: false,
      });
      const ride = host
        ? await network.join(host, name, peerId, { documentMessageMaxBytes: 1100 })
        : await network.create(name, peerId, { documentMessageMaxBytes: 1100 });
      const group = adaptGroupRide(ride);
      svc.attach(group);
      return { svc, ride, group };
    };
    const anna = await rider('Anna', 'p01-anna', null);
    const ben = await rider('Ben', 'p02-ben', anna.ride);
    const settle = (ms = 8_000) => clock.advanceAsync(ms);
    await settle();
    return { anna, ben, settle };
  }

  it('a route shared next to a workout reaches the other rider; the community makes room', async () => {
    const { anna, ben, settle } = await world();
    // Anna shares a workout first, the way the app does.
    const workout = encodeWorkout(getBuiltinWorkout('builtin-sweet-spot-3x12')!);
    anna.svc.makeRoom(workout.length, 1);
    expect(anna.group.shareWorkout(workout)).toBeNull();
    anna.svc.resync();

    const track = getBuiltinRoute('builtin-rolling-loop')!;
    const shared = shareRouteInGroup(anna.group, anna.svc, track);
    expect(shared.ok).toBe(true);
    const local = anna.group.getLocalDocuments();
    expect(local.length).toBeLessThanOrEqual(4);
    expect(local.map((d) => d.kind)).toEqual(
      expect.arrayContaining(['workout', ROUTE_KIND, KIND_STANDING]),
    );
    expect(
      local.reduce((n, d) => n + new TextEncoder().encode(d.text).length, 0),
    ).toBeLessThanOrEqual(32_768);

    await settle();
    const offered = decodeSharedRoutes(ben.group.getSharedRoutes!());
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ peerId: 'p01-anna', peerName: 'Anna' });
    const got = offered[0]!.track;
    expect(got.id).toBe(track.id); // full resolution: same route
    expect(got.totalDistanceM).toBeCloseTo(track.totalDistanceM, 3);
    for (let d = 100; d < track.totalDistanceM; d += 500) {
      expect(gradeAt(got, d)).toBeCloseTo(gradeAt(track, d), 0);
    }
    // Ben still gets the workout and Anna's standing.
    expect(ben.group.getSharedWorkouts()).toHaveLength(1);
    expect(ben.svc.view.contacts.map((c) => c.name)).toEqual(['Anna']);

    // Withdrawing removes it on the other side.
    anna.group.stopSharingRoute!();
    anna.svc.resync();
    await settle();
    expect(ben.group.getSharedRoutes!()).toHaveLength(0);
    anna.ride.leave();
    ben.ride.leave();
  });

  it('a 150 km route is shared at a coarser step within the budget', async () => {
    const { anna, ben, settle } = await world();
    const track = longRoute(150);
    expect(routeShareBudget(anna.group.getLocalDocuments())).toBeGreaterThan(15_000);
    const shared = shareRouteInGroup(anna.group, anna.svc, track);
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.stepM).toBeCloseTo(30, 0);
    await settle(20_000);
    const got = decodeSharedRoutes(ben.group.getSharedRoutes!())[0]!.track;
    expect(got.stepM).toBeCloseTo(30, 0);
    expect(got.totalDistanceM).toBeCloseTo(track.totalDistanceM, 0);
    anna.ride.leave();
    ben.ride.leave();
  });

  it('refuses honestly when there is no room for a usable resolution', async () => {
    const { anna } = await world();
    const big = longRoute(400);
    const r = shareRouteInGroup(anna.group, anna.svc, big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long to share/);
    expect(anna.group.getLocalDocuments().some((d) => d.kind === ROUTE_KIND)).toBe(false);
    anna.ride.leave();
  });
});
