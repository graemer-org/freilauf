import type { GroupRider, RiderCards } from '@freilauf/p2p';
import { describe, expect, it } from 'vitest';
import type { PowerUpLive } from '../../shared/powerUps';
import {
  attackPosition,
  cardsWire,
  checkAttack,
  incompatibleNote,
  incompatibleRiders,
  resolveTarget,
  type LocalRace,
} from './cardRace';

function rider(
  name: string,
  gapM: number,
  cards: RiderCards | null = { v: 1 },
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
    ...(cards ? { cards } : {}),
    ...over,
  };
}

describe('resolveTarget (attacker side)', () => {
  const riders = [rider('Cleo', 300), rider('Ben', 40), rider('Dora', -20)];

  it('Headwind hits the rider directly ahead, Fog the leader', () => {
    expect(resolveTarget('headwind', riders)).toMatchObject({ ok: true, name: 'Ben', gapM: 40 });
    expect(resolveTarget('fog', riders)).toMatchObject({ ok: true, name: 'Cleo' });
  });

  it('passes over old apps, riders without signal and riders out of the race', () => {
    const list = [
      rider('Anna', 15, null), // old app
      rider('Ben', 25, { v: 1 }, { stale: true }),
      rider('Cleo', 35, { v: 1, away: true }),
      rider('Dora', 60),
    ];
    expect(resolveTarget('headwind', list)).toMatchObject({ ok: true, name: 'Dora' });
  });

  it('nobody ahead, leading, level riders, protected targets', () => {
    expect(resolveTarget('headwind', [rider('Ben', -50)])).toEqual({
      ok: false,
      note: 'Nobody ahead of you',
    });
    expect(resolveTarget('fog', [rider('Ben', -50)])).toEqual({
      ok: false,
      note: 'You are leading',
    });
    expect(resolveTarget('headwind', [rider('Ben', 6)])).toMatchObject({ ok: false }); // level
    expect(resolveTarget('headwind', [rider('Ben', 40, { v: 1, protectedS: 7.2 })])).toEqual({
      ok: false,
      note: 'Ben is protected · 8 s',
    });
    expect(
      resolveTarget('headwind', [rider('Ben', 40, { v: 1, attack: { kind: 'fog', s: 3 } })]),
    ).toMatchObject({
      ok: false,
    });
    // A shield does not stop the card: that is what it is for.
    expect(resolveTarget('headwind', [rider('Ben', 40, { v: 1, shieldS: 30 })])).toMatchObject({
      ok: true,
    });
  });
});

describe('checkAttack (target side)', () => {
  // This rider (Ben) at 1040 m ridden, Anna 40 m behind sent it.
  const me: LocalRace = { distanceM: 1040, offsetM: 0, route: null };
  const fromAnna = { from: 'peer-anna', kind: 'headwind', gapM: 40, raceM: 1000 };

  it('accepts a plausible attack', () => {
    expect(checkAttack(fromAnna, me, [rider('Anna', -40)])).toBeNull();
    expect(checkAttack({ ...fromAnna, kind: 'fog' }, me, [rider('Anna', -40)])).toBeNull();
  });

  it('refuses an unknown or non-attack kind', () => {
    expect(checkAttack({ ...fromAnna, kind: 'meteor' }, me, [])).toBe('unknown-kind');
    expect(checkAttack({ ...fromAnna, kind: 'tailwind' }, me, [])).toBe('unknown-kind');
    expect(checkAttack({ ...fromAnna, kind: 'shield' }, me, [])).toBe('unknown-kind');
  });

  it('refuses when the attacker is not behind, or its gap does not match', () => {
    expect(checkAttack({ ...fromAnna, raceM: 1100, gapM: 0 }, me, [])).toBe('not-ahead');
    expect(checkAttack({ ...fromAnna, raceM: 1050, gapM: 5 }, me, [])).toBeNull(); // within tolerance
    expect(checkAttack({ ...fromAnna, gapM: 400 }, me, [])).toBe('gap-mismatch');
  });

  it('Headwind: refused when someone in the race rides between; Fog: when someone leads', () => {
    expect(checkAttack(fromAnna, me, [rider('Anna', -40), rider('Cleo', -20)])).toBe(
      'not-directly-ahead',
    );
    // An old app between does not count, nor does a level rider.
    expect(checkAttack(fromAnna, me, [rider('Cleo', -20, null)])).toBeNull();
    expect(checkAttack(fromAnna, me, [rider('Cleo', -5)])).toBeNull();
    expect(checkAttack({ ...fromAnna, kind: 'fog' }, me, [rider('Cleo', 30)])).toBe('not-leading');
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
  it('names riders whose app has no Card Race', () => {
    const list = [rider('Anna', 5, null), rider('Ben', 6), rider('Cleo', 7, null)];
    expect(incompatibleRiders(list).map((r) => r.name)).toEqual(['Anna', 'Cleo']);
    expect(incompatibleNote(['Anna'])).toBe('Anna’s app does not support Card Race');
    expect(incompatibleNote(['Anna', 'Cleo'])).toBe(
      'Anna’s and Cleo’s apps do not support Card Race',
    );
    expect(incompatibleNote([])).toBeNull();
  });

  it('always tells the group it speaks the Card Race; the details only in one', () => {
    expect(cardsWire(null, false, true)).toEqual({ v: 1 });
    expect(cardsWire(null, true, false)).toEqual({ v: 1, away: true });
    const pu = {
      blocked: null,
      raceOffsetM: -12.34,
      cards: {
        slots: ['fog', null],
        attack: { kind: 'headwind', by: 'Anna', remainingS: 4.44, durationS: 10 },
        shield: null,
        protection: null,
      },
    } as unknown as PowerUpLive;
    expect(cardsWire(pu, true, true)).toEqual({
      v: 1,
      offsetM: -12.3,
      attack: { kind: 'headwind', s: 4.4 },
      held: 1,
    });
  });
});
