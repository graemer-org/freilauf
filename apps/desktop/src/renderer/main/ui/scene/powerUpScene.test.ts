/** The scene's Freilauf Rumble bookkeeping (docs/rumble.md): flights, splashes, puddles. */
import { describe, expect, it } from 'vitest';
import type { PowerUpLive, RumbleLive } from '../../../../shared/powerUps';
import {
  FLIGHT_MS,
  INCOMING_FLIGHT_MS,
  PULSE_MS,
  PowerUpSceneState,
  powerUpAttributes,
  riderFx,
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
    expect(f.rumble?.puddles).toEqual([{ aheadM: 30, own: false }]);
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
