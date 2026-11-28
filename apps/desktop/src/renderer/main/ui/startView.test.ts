import { describe, expect, it } from 'vitest';
import { activeKinds, routeLine, trainerNotice, workoutLine } from './startView';

describe('start screen helpers', () => {
  it('marks free ride, workout, FTP test and route; workout and route combine', () => {
    expect(activeKinds(null, false)).toEqual({
      free: true,
      workout: false,
      episode: false,
      ftp: false,
      route: false,
    });
    expect(activeKinds({ ftpTest: false }, false)).toMatchObject({ free: false, workout: true });
    expect(activeKinds({ ftpTest: true }, false)).toMatchObject({ ftp: true, workout: false });
    expect(activeKinds({ ftpTest: false }, true)).toEqual({
      free: false,
      workout: true,
      episode: false,
      ftp: false,
      route: true,
    });
    expect(activeKinds({ ftpTest: false, episode: true }, false)).toEqual({
      free: false,
      workout: false,
      episode: true,
      ftp: false,
      route: false,
    });
  });

  it('summarises the choice in one line', () => {
    expect(workoutLine('Sweet spot 3×12', 4020, false)).toBe('Sweet spot 3×12 · 1 h 7 min');
    expect(workoutLine('FTP test · ramp', 1200, true)).toBe('FTP test · ramp · open-ended');
    expect(routeLine({ name: 'Isar Ursprung', totalDistanceM: 97_600, startM: 42_300 })).toBe(
      'Isar Ursprung · 97.6 km · starts at km 42.3',
    );
    expect(routeLine({ name: 'Hill loop', totalDistanceM: 3000 })).toBe('Hill loop · 3.0 km');
  });

  it('warns without a trainer, but never blocks, and offers the one useful action', () => {
    expect(trainerNotice('connected', true, undefined, false)).toBeNull();
    expect(trainerNotice('reconnecting', true, undefined, false)?.tone).toBe('info');
    expect(trainerNotice(null, true, 'searching', false)?.tone).toBe('info');
    const none = trainerNotice(null, false, undefined, false);
    expect(none).toEqual({
      tone: 'warn',
      text: 'No trainer connected. You can still start — power will read 0.',
      action: 'pair',
    });
    expect(trainerNotice(null, true, undefined, false)?.action).toBe('retry');
    expect(trainerNotice('disconnected', true, undefined, true)?.action).toBeNull();
  });
});
