/** The scene's Freilauf Rumble bookkeeping (docs/rumble.md): flights, splashes, puddles. */
import { describe, expect, it } from 'vitest';
import type { PowerUpLive, RumbleLive } from '../../../../shared/powerUps';
import {
  FLIGHT_MS,
  INCOMING_FLIGHT_MS,
  PULSE_MS,
  PowerUpSceneState,
  SUPPLY_MS,
  powerUpAttributes,
  riderFx,
  rumbleKey,
} from './powerUpScene';

function live(r: Partial<RumbleLive> | null, upcoming: number[] = []): PowerUpLive {
  return {
    blocked: null,
    held: null,
    hand: [],
    capacity: 2,
    canActivate: false,
    effect: null,
    challenge: null,
    upcoming,
    raceOffsetM: 0,
    picked: 0,
    used: 0,
    event: null,
    ...(r
      ? {
          rumble: {
            slots: [null, null],
            slotNotes: [null, null],
            slotTargets: [null, null],
            hit: null,
            cape: null,
            protection: null,
            immuneS: 0,
            gainM: 0,
            lossM: 0,
            incoming: null,
            outgoing: null,
            puddles: [],
            ...r,
          },
        }
      : {}),
  };
}

describe('PowerUpSceneState in a Rumble', () => {
  it('draws feed bags instead of gates, and puddles that move with the scene', () => {
    const s = new PowerUpSceneState();
    s.setLive(live({ puddles: [{ id: 'p', aheadM: 40, own: false, by: 'Anna' }] }, [120]), 0, 0);
    const f = s.update(10, 1000);
    expect(f.feedBags).toBe(true);
    expect(f.gates).toEqual([110]);
    expect(f.rumble?.puddles).toEqual([{ aheadM: 30, own: false, kind: 'puddle' }]);
    expect(powerUpAttributes(f)).toMatchObject({ puddleAhead: '30', gateAhead: '110' });
    s.setLive(live(null, [120]), 0, 0);
    expect(s.update(0, 0)).toMatchObject({ feedBags: false, rumble: null });
  });

  it('our bottle flies to its target, then splashes when the target says hit', () => {
    const s = new PowerUpSceneState();
    s.setLive(live({}), 0, 0);
    const out = { kind: 'bottle' as const, target: 'Ben', targetId: 'peer-b' };
    s.setLive(live({ outgoing: { seq: 1, ...out, result: 'sent' } }), 0, 1000);
    const mid = s.update(0, 1000 + FLIGHT_MS.bottle / 2).rumble!.throw!;
    expect(mid).toMatchObject({ kind: 'bottle', targetId: 'peer-b', splash: -1 });
    expect(mid.t).toBeCloseTo(0.5, 2);
    expect(powerUpAttributes(s.frame).flying).toBe('throw:bottle');
    s.setLive(live({ outgoing: { seq: 2, ...out, result: 'hit' } }), 0, 1300);
    const landed = s.update(0, 1000 + FLIGHT_MS.bottle + 100).rumble!.throw!;
    expect(landed.splashKind).toBe('hit');
    expect(landed.splash).toBeGreaterThan(0);
    expect(s.update(0, 1000 + FLIGHT_MS.bottle + PULSE_MS + 50).rumble!.throw).toBeNull();
  });

  it('an answer that arrives before a sample showed the throw still draws the whole flight', () => {
    const s = new PowerUpSceneState();
    s.setLive(live({}), 0, 0);
    s.setLive(
      live({
        outgoing: { seq: 2, kind: 'hornets', target: 'Ben', targetId: 'peer-b', result: 'hit' },
      }),
      0,
      1000,
    );
    const t = s.update(0, 1000 + FLIGHT_MS.hornets / 4).rumble!.throw!;
    expect(t).toMatchObject({ kind: 'hornets', splash: -1 });
    expect(s.update(0, 1000 + FLIGHT_MS.hornets + 10).rumble!.throw!.splashKind).toBe('hit');
    // A throw that did not land (protected, refused) is not drawn at all when seen late.
    s.setLive(
      live({
        outgoing: {
          seq: 4,
          kind: 'bottle',
          target: 'Ben',
          targetId: 'peer-b',
          result: 'protected',
        },
      }),
      0,
      9000,
    );
    expect(s.update(0, 9100).rumble!.throw).toBeNull();
  });

  it('a hit from behind flies in first, then splashes; a puddle splashes at once', () => {
    const s = new PowerUpSceneState();
    s.setLive(live({}), 0, 0);
    s.setLive(live({ incoming: { seq: 1, kind: 'hornets', by: 'Cleo', result: 'hit' } }), 0, 0);
    const flying = s.update(0, 300).rumble!;
    expect(flying.incoming?.kind).toBe('hornets');
    expect(flying.pulse).toBe(-1);
    const landed = s.update(0, INCOMING_FLIGHT_MS.hornets + 100).rumble!;
    expect(landed.incoming).toBeNull();
    expect(landed).toMatchObject({ pulseKind: 'hit', pulseItem: 'hornets' });
    s.setLive(
      live({ incoming: { seq: 2, kind: 'puddle', by: 'Anna', result: 'blocked' } }),
      0,
      5000,
    );
    expect(s.update(0, 5100).rumble).toMatchObject({
      incoming: null,
      pulseKind: 'blocked',
      pulseItem: 'puddle',
    });
  });

  it('effects on other riders come from their broadcast', () => {
    expect(riderFx({ v: 2 })).toBeUndefined();
    expect(riderFx({ v: 2, hit: { kind: 'puddle', s: 3 }, capeS: 0 })).toEqual({
      hit: 'puddle',
      cape: false,
      protected: false,
    });
    expect(riderFx({ v: 2, capeS: 40, protectedS: 5 })).toEqual({
      hit: null,
      cape: true,
      protected: true,
    });
    expect(riderFx({ v: 2, hit: { kind: 'headwind', s: 3 } })).toBeUndefined();
  });
});

describe('PowerUpSceneState: Rumble v3 items (ADR 0009)', () => {
  it('tacks lie on the road as tacks; rough sections move with the scene; the terrain is marked', () => {
    const s = new PowerUpSceneState();
    s.setLive(
      live({
        puddles: [{ id: 't', kind: 'tacks', aheadM: 25, own: false, by: 'Ben' }],
        rough: [{ id: 'r', fromM: -20, toM: 130, variant: 'cobbles', own: false, by: 'Ben' }],
        terrain: { variant: 'cobbles', by: 'Ben' },
      }),
      0,
      0,
    );
    const f = s.update(5, 500);
    expect(f.rumble?.puddles).toEqual([{ aheadM: 20, own: false, kind: 'tacks' }]);
    expect(f.rumble?.rough).toEqual([{ fromM: -25, toM: 125, variant: 'cobbles', own: false }]);
    expect(f.rumble?.terrain).toBe('cobbles');
    expect(powerUpAttributes(f)).toMatchObject({
      tacksAhead: '20',
      puddleAhead: '',
      roughAhead: 'cobbles',
      rumble: 'rough:cobbles',
    });
  });

  it('a flat tyre and the mini tool: the hit is drawn, the repair runs on between samples', () => {
    const s = new PowerUpSceneState();
    const hit = {
      kind: 'tacks' as const,
      by: 'Ben',
      remainingS: 3,
      durationS: 20,
      repair: { remainingS: 3, durationS: 3 },
    };
    s.setLive(live({ hit }), 0, 1000);
    const a = s.update(0, 1000).rumble!;
    expect(a.hit).toBe('tacks');
    expect(a.repair).toBeCloseTo(0, 5);
    expect(s.update(0, 2500).rumble!.repair).toBeCloseTo(0.5, 2);
    expect(powerUpAttributes(s.frame).rumble).toBe('tacks repair');
    s.setLive(live({ hit: { ...hit, repair: undefined } }), 0, 3000);
    expect(s.update(0, 3000).rumble!.repair).toBe(-1);
    // The puff of a tyre going flat when tacks land.
    const p = new PowerUpSceneState();
    p.setLive(live({}), 0, 0);
    p.setLive(live({ incoming: { seq: 1, kind: 'tacks', by: 'Ben', result: 'hit' } }), 0, 100);
    expect(p.update(0, 200).rumble).toMatchObject({ pulseItem: 'tacks', pulseKind: 'hit' });
    expect(p.update(0, 200).rumble!.incoming).toBeNull(); // nothing flies in
  });

  it('the team car shows for one visit per supply; the energy bar knows how long it has acted', () => {
    const s = new PowerUpSceneState();
    s.setLive(live({ supply: null }), 0, 0);
    expect(s.update(0, 10).rumble!.supply).toBe(-1);
    s.setLive(live({ supply: { seq: 1, kinds: ['tool', 'cape'] } }), 0, 1000);
    expect(s.update(0, 1000 + SUPPLY_MS / 2).rumble).toMatchObject({
      supplyKinds: ['tool', 'cape'],
    });
    expect(s.frame.rumble!.supply).toBeCloseTo(0.5, 2);
    expect(powerUpAttributes(s.frame).supply).toBe('yes');
    expect(s.update(0, 1000 + SUPPLY_MS + 10).rumble!.supply).toBe(-1);
    const before = rumbleKey(s.frame.rumble);
    s.setLive(live({ supply: { seq: 1, kinds: ['tool', 'cape'] } }), 0, 9000);
    expect(s.update(0, 9000).rumble!.supply).toBe(-1); // the same visit: not again
    expect(rumbleKey(s.frame.rumble)).toBe(before);
    const e = new PowerUpSceneState();
    const pu = live({});
    pu.effect = { kind: 'energyBar', phase: 'active', remainingS: 14.5, durationS: 15 };
    e.setLive(pu, 0, 0);
    expect(e.update(0, 250).effectAgeS).toBeCloseTo(0.75, 5);
  });

  it('other riders: a flat, a dropped chain and the mini tool at work, from their broadcast', () => {
    expect(riderFx({ v: 3, hit: { kind: 'tacks', s: 9 } })).toEqual({
      hit: 'tacks',
      cape: false,
      protected: false,
    });
    expect(riderFx({ v: 3, hit: { kind: 'chain', s: 2 }, repairS: 0.5 })).toEqual({
      hit: 'chain',
      cape: false,
      protected: false,
      repair: true,
    });
    // A kind from a later app: not drawn as a hit (still protected while it lasts).
    expect(riderFx({ v: 4, hit: { kind: 'meteor', s: 2 }, protectedS: 5 })).toEqual({
      hit: null,
      cape: false,
      protected: true,
    });
  });
});
