/**
 * The handlebar controller's sixteen buttons in human terms, grouped by grip, plus the reset
 * patch for the mapping editor. Pure; unit-tested.
 *
 * Every bit is confirmed on hardware (docs/protocols/zwift-ride.md). The "lever click / side
 * button" bits were only seen with the lever at the end of its travel, so what exactly is
 * pressed there is not known yet. The live indicator in Settings shows what actually arrives.
 */
import type { ControllerButton } from '@freilauf/devices';
import type { ControllerAction, Settings } from '../../../shared/contract';
import { CONTROLLER_ACTION_LABELS, DEFAULT_SETTINGS } from '../../../shared/contract';

export type Grip = 'left' | 'right';

export interface ButtonInfo {
  button: ControllerButton;
  grip: Grip;
  /** Name on its grip, e.g. "Upper shift button". */
  name: string;
}

export const GRIP_LABEL: Record<Grip, string> = { left: 'Left grip', right: 'Right grip' };

/** In the order the capture guide asks riders to press them. */
export const CONTROLLER_BUTTONS: readonly ButtonInfo[] = [
  { button: 'shiftDownLeft', grip: 'left', name: 'Lower shift button' },
  { button: 'shiftUpLeft', grip: 'left', name: 'Upper shift button' },
  { button: 'up', grip: 'left', name: 'D-pad up' },
  { button: 'right', grip: 'left', name: 'D-pad right' },
  { button: 'down', grip: 'left', name: 'D-pad down' },
  { button: 'left', grip: 'left', name: 'D-pad left' },
  { button: 'powerUpLeft', grip: 'left', name: 'Lever click / side button' },
  { button: 'onOffLeft', grip: 'left', name: 'Power button' },
  { button: 'shiftDownRight', grip: 'right', name: 'Lower shift button' },
  { button: 'shiftUpRight', grip: 'right', name: 'Upper shift button' },
  { button: 'a', grip: 'right', name: 'A' },
  { button: 'b', grip: 'right', name: 'B' },
  { button: 'y', grip: 'right', name: 'Y' },
  { button: 'z', grip: 'right', name: 'Z' },
  { button: 'powerUpRight', grip: 'right', name: 'Lever click / side button' },
  { button: 'onOffRight', grip: 'right', name: 'Power button' },
];

export function buttonsOnGrip(grip: Grip): ButtonInfo[] {
  return CONTROLLER_BUTTONS.filter((b) => b.grip === grip);
}

/** "Right grip · Upper shift button"; the raw name for anything unknown. */
export function buttonLabel(button: string): string {
  const info = CONTROLLER_BUTTONS.find((b) => b.button === button);
  return info ? `${GRIP_LABEL[info.grip]} · ${info.name}` : button;
}

/** Every action, "Nothing" first. */
export const ACTION_OPTIONS: readonly ControllerAction[] = [
  'none',
  ...(Object.keys(CONTROLLER_ACTION_LABELS) as ControllerAction[]).filter((a) => a !== 'none'),
];

export function actionOf(
  buttons: Settings['shifting']['buttons'],
  button: ControllerButton,
): ControllerAction {
  const a = buttons[button];
  return a && a in CONTROLLER_ACTION_LABELS ? a : 'none';
}

/**
 * A settings patch that restores the default mapping. A deep-merging patch cannot delete keys,
 * so buttons without a default are set to 'none' explicitly.
 */
export function defaultButtonsPatch(): Record<ControllerButton, ControllerAction> {
  const defaults = DEFAULT_SETTINGS.shifting.buttons;
  const out = {} as Record<ControllerButton, ControllerAction>;
  for (const { button } of CONTROLLER_BUTTONS) out[button] = defaults[button] ?? 'none';
  return out;
}

/** True when the mapping already equals the defaults (absent and 'none' are the same). */
export function isDefaultMapping(buttons: Settings['shifting']['buttons']): boolean {
  const defaults = defaultButtonsPatch();
  return CONTROLLER_BUTTONS.every(({ button }) => actionOf(buttons, button) === defaults[button]);
}
