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
  roughLive,
  roughVariantFor,
  speaksV3,
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

  it('always tells the group it speaks Freilauf Rumble (v3); the details and puddles only in one', () => {
    expect(itemsWire(null, false, true)).toEqual({ v: 3 });
    expect(itemsWire(null, false, true, [{ id: 'abcd1234.1', m: 5, s: 9 }])).toEqual({ v: 3 });
    expect(itemsWire(null, true, false)).toEqual({ v: 3, away: true });
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
      v: 3,
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

describe('Rumble v3 (ADR 0009): dropped chain, tacks, rough sections', () => {
  const v3 = { v: 3 };

  it('the dropped chain goes to the nearest rider behind, however far; only to apps of v3', () => {
    const list = [rider('Ben', 40, v3), rider('Cleo', -30, v3), rider('Dora', -900, v3)];
    expect(resolveTarget('chain', list)).toMatchObject({ ok: true, name: 'Cleo', gapM: -30 });
    expect(resolveTarget('chain', [rider('Dora', -900, v3)])).toMatchObject({
      ok: true,
      name: 'Dora',
    });
    expect(resolveTarget('chain', [rider('Ben', 40, v3)])).toEqual({
      ok: false,
      note: 'Nobody behind you',
    });
    // An app of v2 does not know it: passed over (it would refuse an unknown kind).
    expect(resolveTarget('chain', [rider('Cleo', -30, { v: 2 })])).toMatchObject({ ok: false });
    expect(resolveTarget('chain', [rider('Cleo', -6, v3)])).toMatchObject({ ok: false }); // level
    expect(resolveTarget('chain', [rider('Cleo', -30, { v: 3, protectedS: 3 })])).toEqual({
      ok: false,
      note: 'Cleo is protected · 3 s',
    });
    // A flat tyre on the rider counts as a hit: they are protected.
    expect(
      resolveTarget('chain', [rider('Cleo', -30, { v: 3, hit: { kind: 'tacks', s: 9 } })]),
    ).toMatchObject({ ok: false, note: 'Cleo is protected · 9 s' });
    expect(speaksV3(rider('A', 0, v3))).toBe(true);
    expect(speaksV3(rider('A', 0, { v: 2 }))).toBe(false);
    expect(speaksV3(rider('A', 0, null))).toBe(false);
  });

  it('target side: the dropped chain must come from directly ahead', () => {
    // This rider (Cleo) at 1000 m; Ben, 40 m ahead, sent it.
    const me: LocalRace = { distanceM: 1000, offsetM: 0, route: null };
    const fromBen = { from: 'peer-ben', kind: 'chain', gapM: 40, raceM: 1040 };
    expect(checkAttack(fromBen, me, [rider('Ben', 40, v3)])).toBeNull();
    expect(checkAttack({ ...fromBen, raceM: 900 }, me, [])).toBe('not-behind');
    expect(checkAttack({ ...fromBen, gapM: 500 }, me, [])).toBe('gap-mismatch');
    expect(checkAttack(fromBen, me, [rider('Ben', 40, v3), rider('Anna', 20, v3)])).toBe(
      'not-directly-behind',
    );
    // A tool, a team car or tacks are never sent as an attack.
    for (const kind of ['tool', 'teamCar', 'tacks', 'rough', 'energyBar']) {
      expect(checkAttack({ ...fromBen, kind }, me, [])).toBe('unknown-kind');
    }
  });

  it('the broadcast carries tacks, rough sections and the repair (v3 fields, bounded)', () => {
    const pu = {
      blocked: null,
      raceOffsetM: -3,
      rumble: {
        slots: ['tool', null],
        hit: {
          kind: 'tacks',
          by: 'Anna',
          remainingS: 2.5,
          durationS: 20,
          repair: { remainingS: 2.5, durationS: 3 },
        },
        cape: null,
        protection: null,
        immuneS: 17.5,
      },
    } as unknown as PowerUpLive;
    const tacks = Array.from({ length: 5 }, (_, i) => ({ id: `abcd1234.${i + 1}`, m: i, s: 9 }));
    const rough = Array.from({ length: 3 }, (_, i) => ({
      id: `abcd1234.${i + 10}`,
      m: 500,
      len: 150,
      s: 50,
      variant: 'cobbles',
    }));
    const wire = itemsWire(pu, true, true, [], { tacks, rough });
    expect(wire).toMatchObject({ v: 3, hit: { kind: 'tacks', s: 2.5 }, repairS: 2.5 });
    expect(wire.tacks).toHaveLength(4);
    expect(wire.rough).toHaveLength(2);
    expect(itemsWire(pu, false, true, [], { tacks, rough })).toEqual({ v: 3 });
  });

  it('tacks near the rider are marked as tacks', () => {
    const me: LocalRace = { distanceM: 1000, offsetM: 0, route: null };
    const near = [
      {
        dropper: 'peer-ben',
        dropperName: 'Ben',
        puddle: { id: 'a1b2c3d4.1', m: 1040, s: 30 },
        gapM: 40,
      },
    ];
    expect(puddlesLive(near, [], me, 'Anna', 'tacks')).toEqual([
      { kind: 'tacks', id: 'peer-ben|a1b2c3d4.1', aheadM: 40, own: false, by: 'Ben' },
    ]);
    expect(puddlesLive(near, [], me, 'Anna')[0]).not.toHaveProperty('kind');
  });

  it('rough sections: where they lie, whether this rider is on one, never its own; unknown looks ignored', () => {
    const me: LocalRace = { distanceM: 1000, offsetM: -10, route: null };
    const section = (m: number, variant = 'gravel') => ({
      id: 'a1b2c3d4.1',
      m,
      len: 150,
      s: 40,
      variant,
    });
    const ben = (m: number, variant?: string) => ({
      peerId: 'peer-ben',
      name: 'Ben',
      items: { v: 3, rough: [section(m, variant)] },
    });
    // Ends at 1100 (race position): this rider is at 990, 110 m before its end, inside it.
    const inside = roughLive([ben(1100)], [], me, 'Anna');
    expect(inside.terrain).toEqual({ variant: 'gravel', by: 'Ben' });
    expect(inside.rough).toEqual([
      { id: 'peer-ben|a1b2c3d4.1', fromM: -40, toM: 110, variant: 'gravel', own: false, by: 'Ben' },
    ]);
    // Still ahead of this rider: drawn, not on it.
    const ahead = roughLive([ben(1300)], [], me, 'Anna');
    expect(ahead.terrain).toBeNull();
    expect(ahead.rough[0]).toMatchObject({ fromM: 160, toM: 310 });
    // Behind and far away: not in view.
    expect(roughLive([ben(100)], [], me, 'Anna').rough).toEqual([]);
    // An unknown look from a later app: left out entirely.
    expect(roughLive([ben(1100, 'lava')], [], me, 'Anna')).toEqual({ rough: [], terrain: null });
    // This rider's own section: drawn, never ridden on.
    const own = roughLive([], [section(1100)], me, 'Anna');
    expect(own.terrain).toBeNull();
    expect(own.rough[0]).toMatchObject({ own: true, by: 'Anna' });
    // On a loop route: measured along it.
    const loop: LocalRace = {
      distanceM: 50,
      offsetM: 0,
      route: { id: 'loop', m: 20, lengthM: 10_000, loop: true },
    };
    const onLoop = {
      peerId: 'peer-ben',
      name: 'Ben',
      items: { v: 3, rough: [{ ...section(80), routeId: 'loop' }] },
    };
    expect(roughLive([onLoop], [], loop, 'Anna').terrain).toEqual({ variant: 'gravel', by: 'Ben' });
  });

  it('the look of a rough section is chosen by who lays it and when, the same every time', () => {
    const looks = new Set(Array.from({ length: 40 }, (_, i) => roughVariantFor('peer-a', i)));
    expect([...looks].sort()).toEqual(['cobbles', 'debris', 'gravel', 'roots']);
    expect(roughVariantFor('peer-a', 3)).toBe(roughVariantFor('peer-a', 3));
  });
});
