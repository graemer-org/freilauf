import { createEmitter } from '@freilauf/devices';
import type { ControllerButtonEvent } from '@freilauf/devices';
import { describe, expect, it } from 'vitest';
import type { LastButton } from './appStore';
import { watchButtonPresses } from './appStore';

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
