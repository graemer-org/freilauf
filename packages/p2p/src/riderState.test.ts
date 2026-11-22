import { describe, expect, it } from 'vitest';
import {
  decodeStateMessage,
  encodeStateMessage,
  extrapolateDistance,
  RemoteRiders,
  sanitizeRiderState,
} from './riderState';
import type { RiderState } from './types';

function state(overrides: Partial<RiderState> = {}): RiderState {
  return {
    name: 'Anna',
    sentAt: 1_000_000,
    distanceM: 1000,
    speedMps: 10,
    powerW: 200,
    cadenceRpm: 90,
    heartRateBpm: 140,
    gear: 11,
    ...overrides,
  };
}

describe('state validation', () => {
  it('round-trips a valid state', () => {
    expect(decodeStateMessage(encodeStateMessage(state()))).toEqual(state());
    expect(sanitizeRiderState(state({ heartRateBpm: null }))?.heartRateBpm).toBeNull();
  });

  it('drops garbage without throwing', () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      'x',
      '{',
      '[]',
      JSON.stringify({ v: 2, type: 'state', state: state() }),
      JSON.stringify({ v: 1, type: 'other', state: state() }),
      JSON.stringify({ v: 1, type: 'state', state: null }),
      JSON.stringify({ v: 1, type: 'state', state: { ...state(), name: 7 } }),
      JSON.stringify({ v: 1, type: 'state', state: { ...state(), heartRateBpm: undefined } }),
      'x'.repeat(5000),
    ];
    for (const raw of bad) expect(decodeStateMessage(raw)).toBeNull();
    const badStates: Partial<Record<keyof RiderState, unknown>>[] = [
      { sentAt: Number.NaN },
      { sentAt: -1 },
      { distanceM: Number.POSITIVE_INFINITY },
      { distanceM: -5 },
      { distanceM: '12' },
      { speedMps: 300 },
      { powerW: -1 },
      { cadenceRpm: 1e9 },
      { heartRateBpm: 999 },
      { gear: Number.NaN },
    ];
    for (const o of badStates) expect(sanitizeRiderState({ ...state(), ...o })).toBeNull();
  });

  it('sanitises names', () => {
    expect(sanitizeRiderState(state({ name: '  Ann\u0000a‮  ' }))?.name).toBe('Anna');
    expect(sanitizeRiderState(state({ name: 'x'.repeat(40) }))?.name).toHaveLength(24);
    expect(sanitizeRiderState(state({ name: '🚴'.repeat(30) }))?.name).toBe('🚴'.repeat(24));
    expect(sanitizeRiderState(state({ name: '   ' }))?.name).toBe('Rider');
    expect(sanitizeRiderState(state({ gear: 10.6 }))?.gear).toBe(11);
  });
});

describe('RemoteRiders', () => {
  const T0 = 5_000; // local clock; deliberately unrelated to the senders' sentAt values

  it('extrapolates with speed, capped at 2 s', () => {
    expect(extrapolateDistance(100, 10, 500)).toBe(105);
    expect(extrapolateDistance(100, 10, 10_000)).toBe(120);
    expect(extrapolateDistance(100, 10, -50)).toBe(100);
    const r = new RemoteRiders();
    r.ingest('a', state(), T0);
    expect(r.getRiders(T0 + 1000, 0)[0]?.distanceM).toBe(1010);
    expect(r.getRiders(T0 + 5000, 0)[0]?.distanceM).toBe(1020);
  });

  it('drops duplicate and out-of-order packets by sender time only', () => {
    const r = new RemoteRiders();
    // Sender clock is ~11 days off from ours: irrelevant.
    expect(r.ingest('a', state({ sentAt: 1e12, distanceM: 1000 }), T0)).toBe(true);
    expect(r.ingest('a', state({ sentAt: 1e12 + 250, distanceM: 1002.5 }), T0 + 250)).toBe(true);
    expect(r.ingest('a', state({ sentAt: 1e12 + 100, distanceM: 1001 }), T0 + 260)).toBe(false);
    expect(r.ingest('a', state({ sentAt: 1e12 + 250, distanceM: 1001 }), T0 + 260)).toBe(false);
    expect(r.getRiders(T0 + 250, 0)[0]?.distanceM).toBeCloseTo(1002.5);
    // A jump back by more than 5 s is a sender clock reset, not reordering.
    expect(r.ingest('a', state({ sentAt: 1e12 - 60_000, distanceM: 1003 }), T0 + 300)).toBe(true);
  });

  it('smooths corrections instead of jumping', () => {
    const r = new RemoteRiders();
    r.ingest('a', state({ sentAt: 1, distanceM: 1000, speedMps: 10 }), T0);
    // At T0+1000 we display 1010; the next packet says 1004 (they slowed down).
    r.ingest('a', state({ sentAt: 2, distanceM: 1004, speedMps: 4 }), T0 + 1000);
    const atReceive = r.getRiders(T0 + 1000, 0)[0]?.distanceM ?? 0;
    expect(atReceive).toBeCloseTo(1010); // continuous
    const soon = r.getRiders(T0 + 1100, 0)[0]?.distanceM ?? 0;
    expect(soon).toBeGreaterThan(1004.4);
    expect(soon).toBeLessThan(1010.4);
    const later = r.getRiders(T0 + 3000, 0)[0]?.distanceM ?? 0;
    expect(Math.abs(later - (1004 + 4 * 2))).toBeLessThan(0.3); // converged to the new track
  });

  it('snaps large corrections', () => {
    const r = new RemoteRiders();
    r.ingest('a', state({ sentAt: 1, distanceM: 1000 }), T0);
    r.ingest('a', state({ sentAt: 2, distanceM: 5000 }), T0 + 250);
    expect(r.getRiders(T0 + 250, 0)[0]?.distanceM).toBe(5000);
  });

  it('sorts by position, computes gaps and marks stale riders', () => {
    const r = new RemoteRiders();
    r.ingest('a', state({ name: 'A', distanceM: 900, speedMps: 0 }), T0);
    r.ingest('b', state({ name: 'B', distanceM: 1200, speedMps: 0 }), T0);
    r.ingest('c', state({ name: 'C', distanceM: 1050, speedMps: 0 }), T0 + 2000);
    const riders = r.getRiders(T0 + 3500, 1000);
    expect(riders.map((x) => [x.name, x.gapM, x.stale])).toEqual([
      ['B', 200, true],
      ['C', 50, false],
      ['A', -100, true],
    ]);
    r.remove('b');
    expect(r.getRiders(T0, 0).map((x) => x.peerId)).toEqual(['c', 'a']);
  });
});
