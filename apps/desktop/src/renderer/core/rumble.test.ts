import type { GroupRider, RiderItems } from '@freilauf/p2p';
import { describe, expect, it } from 'vitest';
import type { PowerUpLive } from '../../shared/powerUps';
import {
  PUDDLE_BEHIND_M,
  attackPosition,
  checkAttack,
  incompatibleNote,
  incompatibleRiders,
  itemsWire,
  puddleDropAt,
  puddleRace,
  puddlesLive,
  resolveTarget,
  type LocalRace,
} from './rumble';

function rider(
  name: string,
  gapM: number,
  items: RiderItems | null = { v: 2 },
  over: Partial<GroupRider> = {},
): GroupRider {
  return {
    peerId: `peer-${name.toLowerCase()}`,
    name,
    distanceM: 1000 + gapM,
    speedMps: 9,
    powerW: 200,
    cadenceRpm: 90,
    heartRateBpm: null,
    gear: 11,
    gapM,
    stale: false,
    ...(items ? { items } : {}),
    ...over,
  };
}

describe('resolveTarget (attacker side)', () => {
  const riders = [rider('Cleo', 300), rider('Ben', 40), rider('Dora', -20)];

  it('the water bottle hits the rider directly ahead, the hornets the leader; a puddle aims at nobody', () => {
    expect(resolveTarget('bottle', riders)).toMatchObject({ ok: true, name: 'Ben', gapM: 40 });
    expect(resolveTarget('hornets', riders)).toMatchObject({ ok: true, name: 'Cleo' });
    // However far the leader is.
    expect(resolveTarget('hornets', [rider('Ben', 40), rider('Cleo', 4_000)])).toMatchObject({
      ok: true,
      name: 'Cleo',
    });
    expect(resolveTarget('puddle', riders)).toEqual({ ok: false, note: 'Not aimed' });
    expect(resolveTarget('cape', riders)).toEqual({ ok: false, note: 'Not aimed' });
  });

  it('passes over old apps, riders without signal and riders out of the race', () => {
    const list = [
      rider('Anna', 15, null), // old app (no items in its state)
      rider('Ben', 25, { v: 2 }, { stale: true }),
      rider('Cleo', 35, { v: 2, away: true }),
      rider('Dora', 60),
    ];
    expect(resolveTarget('bottle', list)).toMatchObject({ ok: true, name: 'Dora' });
    expect(resolveTarget('hornets', [...list.slice(0, 3)])).toMatchObject({ ok: false });
  });

  it('nobody ahead, leading, level riders, protected targets', () => {
    expect(resolveTarget('bottle', [rider('Ben', -50)])).toEqual({
      ok: false,
      note: 'Nobody ahead of you',
    });
    expect(resolveTarget('hornets', [rider('Ben', -50)])).toEqual({
      ok: false,
      note: 'You are leading',
    });
    expect(resolveTarget('bottle', [rider('Ben', 6)])).toMatchObject({ ok: false }); // level
    expect(resolveTarget('bottle', [rider('Ben', 40, { v: 2, protectedS: 7.2 })])).toEqual({
      ok: false,
      note: 'Ben is protected · 8 s',
    });
    expect(
      resolveTarget('bottle', [rider('Ben', 40, { v: 2, hit: { kind: 'hornets', s: 3 } })]),
    ).toMatchObject({
      ok: false,
    });
    // A rain cape does not stop the throw: that is what the cape is for.
    expect(resolveTarget('bottle', [rider('Ben', 40, { v: 2, capeS: 30 })])).toMatchObject({
      ok: true,
    });
  });
});

describe('checkAttack (target side)', () => {
  // This rider (Ben) at 1040 m ridden, Anna 40 m behind sent it.
  const me: LocalRace = { distanceM: 1040, offsetM: 0, route: null };
  const fromAnna = { from: 'peer-anna', kind: 'bottle', gapM: 40, raceM: 1000 };

  it('accepts a plausible attack', () => {
    expect(checkAttack(fromAnna, me, [rider('Anna', -40)])).toBeNull();
    expect(checkAttack({ ...fromAnna, kind: 'hornets' }, me, [rider('Anna', -40)])).toBeNull();
  });

  it('refuses an unknown or non-aimed kind (a puddle is never sent as an attack)', () => {
    for (const kind of ['meteor', 'tailwind', 'cape', 'puddle', 'headwind', 'fog', 'toString']) {
      expect(checkAttack({ ...fromAnna, kind }, me, [])).toBe('unknown-kind');
    }
  });

  it('refuses when the attacker is not behind, or its gap does not match', () => {
    expect(checkAttack({ ...fromAnna, raceM: 1100, gapM: 0 }, me, [])).toBe('not-ahead');
    expect(checkAttack({ ...fromAnna, raceM: 1050, gapM: 5 }, me, [])).toBeNull(); // within tolerance
    expect(checkAttack({ ...fromAnna, gapM: 400 }, me, [])).toBe('gap-mismatch');
  });

  it('bottle: refused when someone in the race rides between; hornets: when someone leads', () => {
    expect(checkAttack(fromAnna, me, [rider('Anna', -40), rider('Cleo', -20)])).toBe(
      'not-directly-ahead',
    );
    // An old app between does not count, nor does a level rider.
    expect(checkAttack(fromAnna, me, [rider('Cleo', -20, null)])).toBeNull();
    expect(checkAttack(fromAnna, me, [rider('Cleo', -5)])).toBeNull();
    expect(checkAttack({ ...fromAnna, kind: 'hornets' }, me, [rider('Cleo', 30)])).toBe(
      'not-leading',
    );
  });

  it('on a route: measured along it, with the attacker’s own position; another route is refused', () => {
    const onLoop: LocalRace = {
      distanceM: 500,
      offsetM: -10,
      route: { id: 'loop', m: 20, lengthM: 10_000, loop: true },
    };
    // Anna is at 9 990 m of the loop, just before the line: 20 m behind (Ben's −10 m counts).
    expect(
      checkAttack({ ...fromAnna, gapM: 20, raceM: 9_990, routeId: 'loop' }, onLoop, []),
    ).toBeNull();
    expect(checkAttack({ ...fromAnna, gapM: 20, raceM: 9_990, routeId: 'other' }, onLoop, [])).toBe(
      'other-route',
    );
    expect(attackPosition(onLoop, true)).toEqual({ raceM: 10, routeId: 'loop' });
    expect(attackPosition(onLoop, false)).toEqual({ raceM: 490 });
  });
});

describe('compatibility and the broadcast', () => {
  it('names riders whose app has no Freilauf Rumble', () => {
    const list = [rider('Anna', 5, null), rider('Ben', 6), rider('Cleo', 7, null)];
    expect(incompatibleRiders(list).map((r) => r.name)).toEqual(['Anna', 'Cleo']);
    expect(incompatibleNote(['Anna'])).toBe('Anna’s app does not support Freilauf Rumble');
    expect(incompatibleNote(['Anna', 'Cleo'])).toBe(
      'Anna’s and Cleo’s apps do not support Freilauf Rumble',
    );
    expect(incompatibleNote([])).toBeNull();
  });

  it('always tells the group it speaks Freilauf Rumble (v2); the details and puddles only in one', () => {
    expect(itemsWire(null, false, true)).toEqual({ v: 2 });
    expect(itemsWire(null, false, true, [{ id: 'abcd1234.1', m: 5, s: 9 }])).toEqual({ v: 2 });
    expect(itemsWire(null, true, false)).toEqual({ v: 2, away: true });
    const pu = {
      blocked: null,
      raceOffsetM: -12.34,
      rumble: {
        slots: ['hornets', null],
        hit: { kind: 'bottle', by: 'Anna', remainingS: 4.44, durationS: 10 },
        cape: null,
        protection: null,
        immuneS: 19.44,
      },
    } as unknown as PowerUpLive;
    const puddles = [{ id: 'abcd1234.1', m: 990, s: 42 }];
    expect(itemsWire(pu, true, true, puddles)).toEqual({
      v: 2,
      offsetM: -12.3,
      hit: { kind: 'bottle', s: 4.4 },
      protectedS: 19.4,
      held: 1,
      puddles,
    });
  });
});

describe('mud puddles: where they land and who sees them', () => {
  it('lands just behind the rider’s race position, on the route (wrapped round a loop) or along the ridden distance', () => {
    expect(puddleDropAt({ distanceM: 1000, offsetM: -20, route: null })).toEqual({
      m: 980 - PUDDLE_BEHIND_M,
    });
    const loop: LocalRace = {
      distanceM: 500,
      offsetM: 0.5,
      route: { id: 'loop', m: 1, lengthM: 1000, loop: true },
    };
    expect(puddleDropAt(loop)).toEqual({ routeId: 'loop', m: 1000 + 1.5 - PUDDLE_BEHIND_M });
    expect(puddleRace(loop)).toEqual({
      raceM: 500.5,
      route: { id: 'loop', m: 1.5, lengthM: 1000, loop: true },
    });
  });

  it('riders behind see it ahead of them; the dropper sees its own behind; far ones are left out', () => {
    const me: LocalRace = { distanceM: 1000, offsetM: 0, route: null };
    const near = [
      {
        dropper: 'peer-anna',
        dropperName: 'Anna',
        puddle: { id: 'aaaa1111.1', m: 1040, s: 30 },
        gapM: 40,
      },
      {
        dropper: 'peer-anna',
        dropperName: 'Anna',
        puddle: { id: 'aaaa1111.2', m: 3000, s: 30 },
        gapM: 2000,
      },
    ];
    const own = [
      { id: 'bbbb2222.1', m: 997, s: 50 },
      { id: 'bbbb2222.2', m: 990, s: 0, used: true as const },
    ];
    expect(puddlesLive(near, own, me, 'Ben')).toEqual([
      { id: 'self|bbbb2222.1', aheadM: -3, own: true, by: 'Ben' },
      { id: 'peer-anna|aaaa1111.1', aheadM: 40, own: false, by: 'Anna' },
    ]);
  });
});
