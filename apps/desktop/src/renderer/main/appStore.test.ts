import { createEmitter } from '@freilauf/devices';
import type { ConnectionState, ControllerButtonEvent } from '@freilauf/devices';
import { describe, expect, it } from 'vitest';
import type { LastButton, LeverPositionsState } from './appStore';
import { LEVER_UPDATE_MS, watchButtonPresses, watchLevers } from './appStore';

describe('watchButtonPresses (live button indicator)', () => {
  it('reports presses with the time, ignores releases and stops when unsubscribed', () => {
    const events = createEmitter<ControllerButtonEvent>();
    const seen: LastButton[] = [];
    let t = 1000;
    const off = watchButtonPresses(
      { onButton: (l) => events.on(l) },
      (p) => seen.push(p),
      () => t,
    );
    events.emit({ button: 'shiftUpRight', pressed: true });
    t = 2000;
    events.emit({ button: 'shiftUpRight', pressed: false });
    events.emit({ button: 'a', pressed: true });
    off();
    events.emit({ button: 'b', pressed: true });
    expect(seen).toEqual([
      { button: 'shiftUpRight', at: 1000 },
      { button: 'a', at: 2000 },
    ]);
  });
});

describe('watchLevers (live lever display)', () => {
  function setup() {
    const paddles = createEmitter<{ side: 'left' | 'right'; value: number }>();
    const states = createEmitter<ConnectionState>();
    const seen: LeverPositionsState[] = [];
    let t = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const off = watchLevers(
      { onPaddle: (l) => paddles.on(l), onState: (l) => states.on(l) },
      (p) => seen.push(p),
      {
        now: () => t,
        setTimer: (fn, ms) => {
          const timer = { fn, at: t + ms };
          timers.push(timer);
          return timer;
        },
        clearTimer: (h) => timers.splice(timers.indexOf(h as (typeof timers)[number]), 1),
      },
    );
    const advance = (ms: number) => {
      t += ms;
      for (const timer of [...timers]) {
        if (timer.at <= t) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        }
      }
    };
    return { paddles, states, seen, off, advance, timers };
  }

  it('reports at most every 50 ms and never loses the final position', () => {
    const { paddles, seen, advance } = setup();
    expect(LEVER_UPDATE_MS).toBe(50);
    paddles.emit({ side: 'right', value: 0.2 }); // first: at once
    advance(10);
    paddles.emit({ side: 'right', value: 0.5 });
    advance(10);
    paddles.emit({ side: 'right', value: 0.9 });
    paddles.emit({ side: 'left', value: -0.3 });
    expect(seen).toEqual([{ left: 0, right: 0.2, at: 0 }]);
    advance(30); // 50 ms after the first report: the latest positions
    expect(seen.at(-1)).toEqual({ left: -0.3, right: 0.9, at: 50 });
    expect(seen).toHaveLength(2);
    // Repeated identical frames add nothing.
    advance(100);
    paddles.emit({ side: 'right', value: 0.9 });
    advance(100);
    expect(seen).toHaveLength(2);
  });

  it('returns to rest at once when the controller drops, and stops when unsubscribed', () => {
    const { paddles, states, seen, off, advance, timers } = setup();
    paddles.emit({ side: 'left', value: 1 });
    advance(5);
    paddles.emit({ side: 'left', value: 0.8 }); // pending
    states.emit('reconnecting');
    expect(seen.at(-1)).toEqual({ left: 0, right: 0, at: 5 });
    expect(timers).toHaveLength(0);
    advance(100);
    paddles.emit({ side: 'right', value: 0.4 });
    advance(1);
    paddles.emit({ side: 'right', value: 0.6 }); // pending, then unsubscribed
    off();
    expect(timers).toHaveLength(0);
    paddles.emit({ side: 'right', value: 1 });
    expect(seen.at(-1)).toEqual({ left: 0, right: 0.4, at: 105 });
  });
});
