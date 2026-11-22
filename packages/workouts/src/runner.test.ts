import { describe, expect, it } from 'vitest';
import type { Workout } from './model';
import type { RunnerChanges } from './runner';
import { WorkoutRunner } from './runner';

const workout: Workout = {
  id: 'w',
  name: 'Runner',
  steps: [
    { kind: 'ramp', durationS: 10, powerStart: 0.5, powerEnd: 1.0 }, // 0–10
    { kind: 'steady', durationS: 20, power: 0.8, cues: [{ atS: 5, message: 'Hi' }] }, // 10–30
    { kind: 'freeRide', durationS: 20, gradePercent: 2 }, // 30–50
    { kind: 'freeRide', durationS: 10 }, // 50–60
    {
      kind: 'intervals',
      repeat: 2,
      onDurationS: 10,
      onPower: 1.2,
      offDurationS: 10,
      offPower: 0.5,
    }, // 60–100
  ],
};
const FTP = 200;
const none: RunnerChanges = {
  segmentChanged: false,
  modeChanged: false,
  targetPowerChanged: false,
  gradeChanged: false,
  cueChanged: false,
  finished: false,
};

describe('WorkoutRunner', () => {
  it('reports everything on the first update', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP });
    expect(r.state).toBeNull();
    const u = r.update(0);
    expect(u).toMatchObject({
      segmentIndex: 0,
      mode: 'erg',
      targetPowerW: 100,
      intensity: 1,
      ftpW: FTP,
    });
    expect(u.changes).toEqual({
      ...none,
      segmentChanged: true,
      modeChanged: true,
      targetPowerChanged: true,
    });
    expect(r.state).toBe(u);
  });

  it('steps ramps at most once per second and only when watts change', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP });
    r.update(0);
    const writes: number[] = [];
    for (let t = 0.25; t < 10; t += 0.25) {
      const u = r.update(t);
      if (u.changes.targetPowerChanged) writes.push(u.targetPowerW as number);
    }
    // 0.5 → 1.0 over 10 s at 200 W FTP = +10 W per whole second.
    expect(writes).toEqual([110, 120, 130, 140, 150, 160, 170, 180, 190]);
  });

  it('does not report power changes when the rounded watts stay the same', () => {
    const flat: Workout = {
      id: 'f',
      name: 'f',
      steps: [{ kind: 'ramp', durationS: 100, powerStart: 0.5, powerEnd: 0.51 }],
    };
    const r = new WorkoutRunner(flat, { ftpW: 100 });
    r.update(0);
    let writes = 0;
    for (let t = 1; t < 100; t++) if (r.update(t).changes.targetPowerChanged) writes++;
    expect(writes).toBe(1); // 50 W → 51 W once (rounded at 50 s)
  });

  it('switches modes and gradients, fires cues, finishes once', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP });
    r.update(0);
    let u = r.update(10);
    expect(u.changes).toEqual({ ...none, segmentChanged: true, targetPowerChanged: true });
    expect(u.targetPowerW).toBe(160);
    expect(r.update(14).changes).toEqual(none);
    u = r.update(15);
    expect(u.changes.cueChanged).toBe(true);
    expect(u.cue?.message).toBe('Hi');
    expect(r.update(16).changes.cueChanged).toBe(false);

    u = r.update(30);
    expect(u.mode).toBe('free');
    expect(u.gradePercent).toBe(2);
    expect(u.changes).toEqual({
      ...none,
      segmentChanged: true,
      modeChanged: true,
      gradeChanged: true,
    });

    u = r.update(50);
    expect(u.changes).toEqual({ ...none, segmentChanged: true, gradeChanged: true });
    expect(u.gradePercent).toBeUndefined();

    u = r.update(60);
    expect(u.changes).toEqual({
      ...none,
      segmentChanged: true,
      modeChanged: true,
      targetPowerChanged: true,
    });
    expect(u.targetPowerW).toBe(240);

    u = r.update(100);
    expect(u.finished).toBe(true);
    expect(u.mode).toBe('free');
    expect(u.changes).toEqual({
      ...none,
      segmentChanged: true,
      modeChanged: true,
      gradeChanged: true,
      finished: true,
    });
    expect(r.update(120).changes).toEqual(none);
  });

  it('pauses implicitly and ignores backwards ride time', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP });
    r.update(0);
    r.update(12);
    expect(r.update(12).elapsedS).toBe(12);
    expect(r.positionS).toBe(12);
    r.update(11.5); // jitter: ignored, not counted twice
    r.update(12.5);
    expect(r.positionS).toBe(12.5);
    r.update(2); // big jump back (new ride clock): re-anchors, no rewind
    expect(r.positionS).toBe(12.5);
    r.update(4);
    expect(r.positionS).toBe(14.5);
    r.update(Number.NaN);
    expect(r.positionS).toBe(14.5);
  });

  it('jumps forward across several segments', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP });
    r.update(0);
    const u = r.update(65);
    expect(u.segmentIndex).toBe(4);
    expect(u.label).toBe('Interval 1/2 · on');
    expect(u.targetPowerW).toBe(240);
    expect(u.changes).toEqual({ ...none, segmentChanged: true, targetPowerChanged: true });
  });

  it('honours startRideS', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP, startRideS: 100 });
    r.update(50);
    expect(r.positionS).toBe(0);
    r.update(99);
    expect(r.positionS).toBe(0);
    r.update(112);
    expect(r.positionS).toBe(12);
  });

  it('skips segments and restarts with back()', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP });
    r.update(0);
    r.update(3);
    r.skipSegment();
    let u = r.update(3);
    expect(u.segmentIndex).toBe(1);
    expect(r.positionS).toBe(10);
    expect(u.changes.segmentChanged).toBe(true);

    r.update(8); // 15 s into the workout
    r.back();
    u = r.update(8);
    expect(r.positionS).toBe(10);
    expect(u.segmentIndex).toBe(1);
    expect(u.changes.segmentChanged).toBe(true); // restart counts
    expect(u.changes.targetPowerChanged).toBe(false); // same watts

    // Ride time keeps advancing from the new position.
    r.update(13);
    expect(r.positionS).toBe(15);

    // Back on a ramp resends the lower power.
    const r2 = new WorkoutRunner(workout, { ftpW: FTP });
    r2.update(0);
    r2.update(5);
    r2.back();
    u = r2.update(5);
    expect(u.targetPowerW).toBe(100);
    expect(u.changes.targetPowerChanged).toBe(true);
  });

  it('skip at the last segment finishes, back after finish resumes the last segment', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP });
    r.update(0);
    r.update(95);
    r.skipSegment();
    let u = r.update(95);
    expect(u.finished).toBe(true);
    expect(u.changes.finished).toBe(true);
    r.skipSegment(); // no-op
    r.back();
    u = r.update(95);
    expect(u.finished).toBe(false);
    expect(r.positionS).toBe(90);
    expect(u.mode).toBe('erg');
    expect(u.changes.modeChanged).toBe(true);
    u = r.update(105);
    expect(u.changes.finished).toBe(true);
  });

  it('applies intensity and FTP changes on the next update', () => {
    const r = new WorkoutRunner(workout, { ftpW: FTP, intensity: 1.1 });
    r.update(0);
    expect(r.update(10).targetPowerW).toBe(176);
    expect(r.setIntensity(2)).toBe(1.5);
    let u = r.update(10);
    expect(u.targetPowerW).toBe(240);
    expect(u.intensity).toBe(1.5);
    expect(u.changes).toEqual({ ...none, targetPowerChanged: true });
    r.setIntensity(1);
    r.setFtp(250);
    u = r.update(11);
    expect(u.targetPowerW).toBe(200);
    expect(u.changes.targetPowerChanged).toBe(true);
    r.setFtp(Number.NaN);
    expect(r.update(11).ftpW).toBe(250);
    // Intensity never affects free-ride steps.
    r.setIntensity(0.5);
    expect(r.update(35).targetPowerW).toBeNull();
  });

  it('is deterministic', () => {
    const run = () => {
      const r = new WorkoutRunner(workout, { ftpW: 233 });
      const out: string[] = [];
      for (let t = 0; t <= 110; t += 0.7) out.push(JSON.stringify(r.update(t)));
      return out;
    };
    expect(run()).toEqual(run());
  });
});
