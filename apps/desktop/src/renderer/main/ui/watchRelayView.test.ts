import { describe, expect, it } from 'vitest';
import { describeWatchRelay, listWords, watchRelayBadge } from './watchRelayView';

describe('describeWatchRelay', () => {
  it('words every state', () => {
    expect(describeWatchRelay({ state: 'off' })).toEqual({ text: 'Off', tone: 'off' });
    expect(describeWatchRelay({ state: 'starting' }).tone).toBe('busy');
    expect(describeWatchRelay({ state: 'unsupported', reason: 'No peripheral role.' }).text).toBe(
      'Not supported on this computer — No peripheral role.',
    );
    expect(describeWatchRelay({ state: 'unavailable', reason: 'Needs Windows.' }).text).toBe(
      'Not supported on this computer — Needs Windows.',
    );
    expect(
      describeWatchRelay({ state: 'unavailable', reason: 'Pages cannot.', browser: true }).text,
    ).toBe('Not available in the browser — Pages cannot.');
    expect(describeWatchRelay({ state: 'error', message: 'Radio off.', retrying: true }).text).toBe(
      'Radio off. Trying again…',
    );
  });

  it('says what to look for while waiting, and counts devices once connected', () => {
    expect(
      describeWatchRelay({
        state: 'sharing',
        devices: 0,
        sharing: ['heartRate', 'power', 'speedCadence'],
        computerName: 'DESKTOP-1',
      }).text,
    ).toBe(
      'Waiting for a watch — look for this PC’s Bluetooth name (“DESKTOP-1”) as a heart-rate sensor, power meter and bike sensor',
    );
    const s = { state: 'sharing' as const, sharing: ['power' as const], computerName: 'X' };
    expect(describeWatchRelay({ ...s, devices: 1 })).toEqual({
      text: 'Connected: 1 device',
      tone: 'ok',
    });
    expect(describeWatchRelay({ ...s, devices: 2 }).text).toBe('Connected: 2 devices');
  });
});

describe('watchRelayBadge', () => {
  it('only shows while sharing is switched on and possible', () => {
    expect(watchRelayBadge({ state: 'off' }, true)).toBeNull();
    expect(watchRelayBadge({ state: 'starting' }, false)).toBeNull();
    expect(watchRelayBadge({ state: 'unavailable', reason: 'x' }, true)).toBeNull();
    expect(
      watchRelayBadge({ state: 'sharing', devices: 1, sharing: [], computerName: '' }, true),
    ).toEqual({ text: 'Watch: 1', tone: 'ok' });
    expect(watchRelayBadge({ state: 'unsupported', reason: 'x' }, true)?.tone).toBe('warn');
  });
});

describe('listWords', () => {
  it('joins with commas and "and"', () => {
    expect(listWords([])).toBe('');
    expect(listWords(['a'])).toBe('a');
    expect(listWords(['a', 'b'])).toBe('a and b');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
