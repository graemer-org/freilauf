import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EpisodeLive, LiveState, WorkoutLive } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { OverlayView } from './OverlayView';
import { workoutStrip } from './logic';

const episode = (over: Partial<EpisodeLive> = {}): EpisodeLive => ({
  lengthS: 2520,
  revision: 0,
  hardNow: { available: true },
  hardNowTargetW: 220,
  notice: null,
  ...over,
});

function workout(over: Partial<WorkoutLive> = {}): WorkoutLive {
  return {
    id: 'episode-42-medium-spread',
    name: 'Episode 42 min · Spread, medium',
    mode: 'erg',
    label: 'Endurance',
    targetPowerW: 130,
    elapsedS: 630,
    totalDurationS: 2520,
    segmentElapsedS: 190,
    segmentRemainingS: 10,
    totalRemainingS: 1890,
    next: { label: 'Hard 1/3', targetPowerW: 250.4, durationS: 180 },
    intensity: 1,
    finished: false,
    started: true,
    episode: episode(),
    ...over,
  };
}

function live(w: WorkoutLive | null): LiveState {
  return {
    ride: {
      state: 'riding',
      elapsedS: 630,
      distanceM: 5000,
      speedMps: 8,
      powerW: 130,
      power3sW: 130,
      displayPowerW: 130,
      avgPowerW: 140,
      wattsPerKg: 1.8,
      cadenceRpm: 88,
      heartRateBpm: 120,
      gear: 12,
      gearCount: 24,
      gradePercent: 0,
    },
    devices: { trainer: { name: 'T', state: 'connected' }, heartRate: null, controller: null },
    group: null,
    localName: 'Me',
    workout: w,
  };
}

const render = (w: WorkoutLive | null): string =>
  renderToString(
    createElement(OverlayView, {
      live: live(w),
      settings: DEFAULT_SETTINGS.overlay,
      editMode: false,
    }),
  );

describe('overlay: episode workout', () => {
  it('cues the next change in the last 10 s of a step', () => {
    expect(workoutStrip(workout())?.ahead).toEqual({
      text: 'in 10 s: 3 min hard · 250 W',
      tone: 'cue',
    });
    expect(workoutStrip(workout({ segmentRemainingS: 3.7 }))?.ahead?.text).toBe(
      'in 3 s: 3 min hard · 250 W',
    );
    expect(workoutStrip(workout({ segmentRemainingS: 0.4 }))?.ahead?.text).toMatch(/^in 1 s:/);
    // Not earlier, not for the last step, not once finished.
    expect(workoutStrip(workout({ segmentRemainingS: 10.5 }))?.ahead).toBeNull();
    const last = workout({ next: undefined });
    expect(workoutStrip(last)?.ahead).toBeNull();
    expect(workoutStrip(workout({ finished: true }))?.ahead).toBeNull();
    // Into the cool-down (a ramp: its start watts) and a free step without watts.
    expect(
      workoutStrip(workout({ next: { label: 'Cool-down', targetPowerW: 120, durationS: 210 } }))
        ?.ahead?.text,
    ).toBe('in 10 s: 3:30 min cool-down · 120 W');
    expect(
      workoutStrip(workout({ next: { label: 'Easy', targetPowerW: null, durationS: 60 } }))?.ahead
        ?.text,
    ).toBe('in 10 s: 1 min easy');
  });

  it('only for episode workouts', () => {
    expect(workoutStrip(workout({ episode: undefined }))).toMatchObject({
      ahead: null,
      episode: null,
    });
    expect(render(workout({ episode: undefined }))).not.toContain('overlay-workout-ahead');
  });

  it('shows the note after hard now instead of the cue', () => {
    const w = workout({
      episode: episode({ notice: { text: 'Hard now: 2 min · 220 W', tone: 'info' } }),
    });
    expect(workoutStrip(w)?.ahead).toEqual({ text: 'Hard now: 2 min · 220 W', tone: 'info' });
    const refused = workout({
      segmentRemainingS: 100,
      episode: episode({ notice: { text: 'Already in a hard block.', tone: 'warn' } }),
    });
    expect(workoutStrip(refused)?.ahead).toEqual({
      text: 'Already in a hard block.',
      tone: 'warn',
    });
  });

  it('draws a thin line for the whole episode with the time left, inside the workout strip', () => {
    expect(workoutStrip(workout())?.episode).toEqual({ progress: 0.25, left: '31:30 left' });
    expect(workoutStrip(workout({ finished: true }))?.episode).toEqual({
      progress: 1,
      left: 'Episode done',
    });
    const html = render(workout());
    expect(html).toContain('data-testid="overlay-workout-ahead"');
    expect(html).toContain('in 10 s: 3 min hard · 250 W');
    expect(html).toContain('data-testid="overlay-episode"');
    expect(html).toContain('width:25%');
    expect(html).toContain('31:30 left');
    // All of it inside the strip (nothing new elsewhere over the film).
    const strip = html.indexOf('data-testid="overlay-workout"');
    const tiles = html.indexOf('overlay-tile-');
    expect(html.indexOf('overlay-workout-ahead')).toBeGreaterThan(strip);
    expect(html.indexOf('overlay-episode')).toBeLessThan(tiles);
  });
});
