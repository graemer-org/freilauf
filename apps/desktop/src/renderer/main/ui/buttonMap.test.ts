import { describe, expect, it } from 'vitest';
import { RIDE_BUTTON_MASK } from '@freilauf/devices';
import { CONTROLLER_ACTION_LABELS, DEFAULT_SETTINGS } from '../../../shared/contract';
import {
  ACTION_OPTIONS,
  CONTROLLER_BUTTONS,
  actionOf,
  buttonLabel,
  buttonsOnGrip,
  defaultButtonsPatch,
  isDefaultMapping,
} from './buttonMap';

describe('controller button names', () => {
  it('covers all sixteen buttons once, eight per grip', () => {
    const all = CONTROLLER_BUTTONS.map((b) => b.button).sort();
    expect(all).toEqual(Object.keys(RIDE_BUTTON_MASK).sort());
    expect(buttonsOnGrip('left')).toHaveLength(8);
    expect(buttonsOnGrip('right')).toHaveLength(8);
    expect(buttonLabel('shiftUpRight')).toBe('Right grip · Upper shift button');
    expect(buttonLabel('up')).toBe('Left grip · D-pad up');
    expect(buttonLabel('mystery')).toBe('mystery');
  });

  it('offers every action, Nothing first', () => {
    expect(ACTION_OPTIONS[0]).toBe('none');
    expect([...ACTION_OPTIONS].sort()).toEqual(Object.keys(CONTROLLER_ACTION_LABELS).sort());
  });

  it('resets to the defaults, setting unmapped buttons to none explicitly', () => {
    const patch = defaultButtonsPatch();
    expect(Object.keys(patch)).toHaveLength(16);
    expect(patch.shiftUpRight).toBe(DEFAULT_SETTINGS.shifting.buttons.shiftUpRight);
    expect(patch.a).toBe('none');
    expect(isDefaultMapping(DEFAULT_SETTINGS.shifting.buttons)).toBe(true);
    expect(isDefaultMapping(patch)).toBe(true);
    expect(isDefaultMapping({ ...DEFAULT_SETTINGS.shifting.buttons, a: 'startPause' })).toBe(false);
    expect(actionOf({}, 'b')).toBe('none');
    expect(actionOf({ b: 'bogus' as never }, 'b')).toBe('none');
  });
});
