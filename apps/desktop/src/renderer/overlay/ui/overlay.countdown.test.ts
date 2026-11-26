import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type LiveState, type RideCountdown } from '../../../shared/contract';
import { countdownDisplay } from '../../main/ui/countdownView';
import { OverlayView } from './OverlayView';

function live(
  countdown: RideCountdown | null,
  state: LiveState['ride']['state'] = 'idle',
): LiveState {
  return {
    ride: {
      state,
      elapsedS: 0,
      distanceM: 0,
      speedMps: 0,
      powerW: 160,
      power3sW: 158,
      displayPowerW: 160,
      avgPowerW: 160,
      wattsPerKg: 2.1,
      cadenceRpm: 80,
      heartRateBpm: 110,
      gear: 12,
      gearCount: 24,
      gradePercent: 0,
    },
    devices: { trainer: { name: 'T', state: 'connected' }, heartRate: null, controller: null },
    group: null,
    localName: 'Me',
    ...(countdown ? { countdown } : {}),
  };
}

const render = (l: LiveState, editMode = false): string =>
  renderToString(
    createElement(OverlayView, { live: l, settings: DEFAULT_SETTINGS.overlay, editMode }),
  );

describe('Overlay: the countdown before the ride starts or resumes (SSR)', () => {
  it('shows big digits and "Get ready" over the tiles, every glyph opaque with outline', () => {
    const html = render(live({ kind: 'start', remainingS: 1.6, totalS: 3 }));
    expect(html).toMatch(/data-testid="overlay-countdown" data-kind="start" role="timer"/);
    expect(html).toMatch(/class="cd-digit ov-text" data-testid="countdown-digit">2</);
    expect(html).toMatch(/class="cd-title ov-text">Get ready</);
    expect(html).toContain('class="ov-backdrop"');
    // No hint text in the overlay (the keys are the main window's).
    expect(html).not.toContain('Esc cancels');
    // It takes the tiles' place (hidden by CSS, back at zero).
    expect(html).toMatch(/class="ov-root ov-root--idle ov-root--countdown"/);
    expect(render(live(null))).not.toContain('ov-root--countdown');
  });

  it('resume and group look the same; the group says it starts together', () => {
    expect(render(live({ kind: 'resume', remainingS: 3, totalS: 3 }, 'paused'))).toMatch(
      /data-kind="resume"[\s\S]*?>3<[\s\S]*?>Get ready</,
    );
    expect(render(live({ kind: 'group', remainingS: 9.2, totalS: 10 }))).toMatch(
      /data-kind="group"[\s\S]*?>10<[\s\S]*?>Starting together</,
    );
  });

  it('shows nothing without a countdown or in edit mode', () => {
    expect(render(live(null))).not.toContain('overlay-countdown');
    expect(render(live({ kind: 'start', remainingS: 2, totalS: 3 }), true)).not.toContain(
      'overlay-countdown',
    );
  });
});

describe('countdownDisplay', () => {
  it('digit is the ceiling, never 0; the ring is the share left; bad input is safe', () => {
    expect(countdownDisplay(null)).toBeNull();
    expect(countdownDisplay({ kind: 'start', remainingS: 3, totalS: 3 })).toMatchObject({
      digit: 3,
      fraction: 1,
      title: 'Get ready',
    });
    expect(countdownDisplay({ kind: 'start', remainingS: 2.01, totalS: 3 })?.digit).toBe(3);
    expect(countdownDisplay({ kind: 'start', remainingS: 0.2, totalS: 3 })?.digit).toBe(1);
    expect(countdownDisplay({ kind: 'start', remainingS: 0, totalS: 3 })).toMatchObject({
      digit: 1,
      fraction: 0,
    });
    expect(countdownDisplay({ kind: 'group', remainingS: 5, totalS: 10 })).toMatchObject({
      fraction: 0.5,
      title: 'Starting together',
    });
    expect(countdownDisplay({ kind: 'resume', remainingS: Number.NaN, totalS: 0 })).toMatchObject({
      digit: 1,
      fraction: 0,
    });
  });
});
