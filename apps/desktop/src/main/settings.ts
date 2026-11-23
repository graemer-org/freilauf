/**
 * Pure settings logic: deep merge and defensive validation. No Electron, no fs
 * (unit-tested in settings.test.ts).
 *
 * `sanitizeSettings(raw, fallback)` builds a complete `Settings` from any
 * value: every field that is present and valid in `raw` is taken, everything
 * else comes from `fallback`. Loading uses `DEFAULT_SETTINGS` as fallback (so a
 * hand-edited file only loses its bad parts and new keys appear after an
 * upgrade); updates use the current settings (so a bad patch field is a no-op).
 */
import type { ControllerButton, DeviceKind } from '@freilauf/devices';
import type {
  Bounds,
  DeepPartial,
  LeverFunction,
  LeverSettings,
  OverlayTile,
  RememberedDevice,
  Settings,
  ShiftAction,
  StatId,
} from '../shared/contract';
import { DEFAULT_SETTINGS, LEGACY_DEFAULT_SIGNALLING_URL } from '../shared/contract';

// Records (not arrays) so the compiler flags a missing/extra member when the
// union types change.
const DEVICE_KINDS: Record<DeviceKind, true> = { trainer: true, heartRate: true, controller: true };
const CONTROLLER_BUTTONS: Record<ControllerButton, true> = {
  shiftUpLeft: true,
  shiftDownLeft: true,
  shiftUpRight: true,
  shiftDownRight: true,
  up: true,
  down: true,
  left: true,
  right: true,
  a: true,
  b: true,
  y: true,
  z: true,
  powerUpLeft: true,
  powerUpRight: true,
  onOffLeft: true,
  onOffRight: true,
};
const SHIFT_ACTIONS: Record<ShiftAction, true> = {
  none: true,
  shiftUp: true,
  shiftDown: true,
  gradientUp: true,
  gradientDown: true,
  startPause: true,
  workoutSkip: true,
  workoutBack: true,
  intensityUp: true,
  intensityDown: true,
  steerLeft: true,
  steerRight: true,
};
const LEVER_FUNCTIONS: Record<LeverFunction, true> = {
  none: true,
  steerLeft: true,
  steerRight: true,
  brake: true,
};
/** Largest accepted lever dead zone (fraction of full travel). */
export const MAX_LEVER_DEADZONE = 0.5;
const STAT_IDS: Record<StatId, true> = {
  power: true,
  power3s: true,
  wattsPerKg: true,
  cadence: true,
  speed: true,
  heartRate: true,
  gear: true,
  time: true,
  distance: true,
  gradient: true,
  targetPower: true,
  intervalRemaining: true,
  routeRemaining: true,
  ascentRemaining: true,
  elevation: true,
};
const TILE_SIZES: Record<OverlayTile['size'], true> = { s: true, m: true, l: true };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function has<K extends string>(table: Record<K, true>, key: unknown): key is K {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

/**
 * Deep-merges `patch` into a copy of `base`. Plain objects merge recursively;
 * arrays, primitives and null replace; `undefined` is ignored. Never mutates
 * its inputs and ignores prototype-polluting keys.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return clone(base);
  if (!isPlainObject(patch) || !isPlainObject(base)) return clone(patch) as T;
  const out: Record<string, unknown> = clone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key) || value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x: unknown) => clone(x)) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!FORBIDDEN_KEYS.has(k)) out[k] = clone(x);
    }
    return out as T;
  }
  return v;
}

/** Collects human-readable notes about the fields that were rejected. */
export type Problems = string[];

function num(
  raw: unknown,
  fallback: number,
  path: string,
  problems: Problems,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    problems.push(`${path}: expected a number in [${min}, ${max}]`);
    return fallback;
  }
  return raw;
}

function str(
  raw: unknown,
  fallback: string,
  path: string,
  problems: Problems,
  maxLen = 200,
): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || raw.length > maxLen) {
    problems.push(`${path}: expected a string`);
    return fallback;
  }
  return raw;
}

function bool(raw: unknown, fallback: boolean, path: string, problems: Problems): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    problems.push(`${path}: expected a boolean`);
    return fallback;
  }
  return raw;
}

function obj(raw: unknown, path: string, problems: Problems): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    problems.push(`${path}: expected an object`);
    return {};
  }
  return raw;
}

export function isBounds(v: unknown): v is Bounds {
  if (!isPlainObject(v)) return false;
  const { x, y, width, height } = v;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    Math.abs(x) < 1e6 &&
    Math.abs(y) < 1e6 &&
    width < 1e5 &&
    height < 1e5
  );
}

function sanitizeDevices(
  raw: unknown,
  fallback: Settings['devices'],
  problems: Problems,
): Settings['devices'] {
  if (raw === undefined) return clone(fallback);
  if (!isPlainObject(raw)) {
    problems.push('devices: expected an object');
    return clone(fallback);
  }
  const out: Settings['devices'] = {};
  for (const [kind, dev] of Object.entries(raw)) {
    if (!has(DEVICE_KINDS, kind)) {
      problems.push(`devices.${kind}: unknown device kind`);
      continue;
    }
    if (
      isPlainObject(dev) &&
      typeof dev.id === 'string' &&
      dev.id.length > 0 &&
      dev.id.length <= 200 &&
      typeof dev.name === 'string' &&
      dev.name.length <= 200
    ) {
      const remembered: RememberedDevice = { id: dev.id, name: dev.name };
      out[kind] = remembered;
    } else {
      problems.push(`devices.${kind}: expected { id, name }`);
      const prev = fallback[kind];
      if (prev) out[kind] = { ...prev };
    }
  }
  return out;
}

function sanitizeButtons(
  raw: unknown,
  fallback: Settings['shifting']['buttons'],
  problems: Problems,
): Settings['shifting']['buttons'] {
  if (raw === undefined) return clone(fallback);
  if (!isPlainObject(raw)) {
    problems.push('shifting.buttons: expected an object');
    return clone(fallback);
  }
  const out: Settings['shifting']['buttons'] = {};
  for (const [button, action] of Object.entries(raw)) {
    if (!has(CONTROLLER_BUTTONS, button)) {
      problems.push(`shifting.buttons.${button}: unknown button`);
      continue;
    }
    if (has(SHIFT_ACTIONS, action)) {
      out[button] = action;
    } else {
      problems.push(`shifting.buttons.${button}: unknown action`);
      const prev = fallback[button];
      if (prev) out[button] = prev;
    }
  }
  return out;
}

/** Lever directions: each one a known function; dead zone 0 … MAX_LEVER_DEADZONE. */
function sanitizeLevers(raw: unknown, fallback: LeverSettings, problems: Problems): LeverSettings {
  const root = obj(raw, 'shifting.levers', problems);
  const grip = (side: 'left' | 'right'): LeverSettings['left'] => {
    const g = obj(root[side], `shifting.levers.${side}`, problems);
    const dir = (d: 'positive' | 'negative'): LeverFunction => {
      const v = g[d];
      if (v === undefined) return fallback[side][d];
      if (has(LEVER_FUNCTIONS, v)) return v;
      problems.push(`shifting.levers.${side}.${d}: unknown lever function`);
      return fallback[side][d];
    };
    return { positive: dir('positive'), negative: dir('negative') };
  };
  return {
    left: grip('left'),
    right: grip('right'),
    deadzone: num(
      root.deadzone,
      fallback.deadzone,
      'shifting.levers.deadzone',
      problems,
      0,
      MAX_LEVER_DEADZONE,
    ),
  };
}

function sanitizeTiles(raw: unknown, fallback: OverlayTile[], problems: Problems): OverlayTile[] {
  if (raw === undefined) return clone(fallback);
  if (!Array.isArray(raw)) {
    problems.push('overlay.tiles: expected an array');
    return clone(fallback);
  }
  const out: OverlayTile[] = [];
  raw.forEach((t: unknown, i) => {
    if (isPlainObject(t) && has(STAT_IDS, t.stat) && has(TILE_SIZES, t.size)) {
      out.push({ stat: t.stat, size: t.size });
    } else {
      problems.push(`overlay.tiles[${i}]: invalid tile dropped`);
    }
  });
  return out.slice(0, 32);
}

function sanitizeSignallingUrl(raw: unknown, fallback: string, problems: Problems): string {
  if (raw === undefined) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return ''; // none set up
  if (typeof raw === 'string' && raw.length <= 500 && /^wss?:\/\/[^\s]+$/i.test(raw)) return raw;
  problems.push('group.signallingUrl: expected a ws:// or wss:// URL or nothing');
  return fallback;
}

/** Advanced relay list: ws(s):// URLs only, de-duplicated, at most 16. */
function sanitizeRelayUrls(raw: unknown, fallback: string[], problems: Problems): string[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw)) {
    problems.push('group.relayUrls: expected a list of wss:// URLs');
    return [...fallback];
  }
  const out: string[] = [];
  for (const [i, u] of raw.entries()) {
    if (typeof u === 'string' && u.length <= 300 && /^wss?:\/\/[^\s/?#]+[^\s]*$/i.test(u.trim())) {
      if (!out.includes(u.trim())) out.push(u.trim());
    } else {
      problems.push(`group.relayUrls[${i}]: not a ws:// or wss:// URL, dropped`);
    }
  }
  return out.slice(0, 16);
}

/**
 * Upgrades a stored settings value before `sanitizeSettings` (on load only,
 * never on updates). Returns a new value; `raw` is not changed.
 *
 * - `group.signallingUrl` still at the old default `ws://localhost:8787` is
 *   dropped, so the current default applies: none set up on the desktop, the
 *   page's own `/signal` in the browser. That address only ever worked on one
 *   computer; group rides now explain how to set up a real server instead of
 *   failing against it. ("Use a server on this computer" stores
 *   `ws://127.0.0.1:8787`, which this leaves alone.)
 */
export function migrateSettings(raw: unknown): unknown {
  if (!isPlainObject(raw) || !isPlainObject(raw.group)) return raw;
  if (raw.group.signallingUrl !== LEGACY_DEFAULT_SIGNALLING_URL) return raw;
  const { signallingUrl: _old, ...group } = raw.group;
  return { ...raw, group };
}

/** Builds valid `Settings` from untrusted input; see the module comment. */
export function sanitizeSettings(
  raw: unknown,
  fallback: Settings = DEFAULT_SETTINGS,
  problems: Problems = [],
): Settings {
  const root = obj(raw, '(root)', problems);
  const rider = obj(root.rider, 'rider', problems);
  const shifting = obj(root.shifting, 'shifting', problems);
  const overlay = obj(root.overlay, 'overlay', problems);
  const group = obj(root.group, 'group', problems);
  const route = obj(root.route, 'route', problems);

  let trainerMassKg = fallback.shifting.trainerMassKg;
  if (shifting.trainerMassKg === null) trainerMassKg = null;
  else if (shifting.trainerMassKg !== undefined) {
    trainerMassKg = num(
      shifting.trainerMassKg,
      fallback.shifting.trainerMassKg ?? 0,
      'shifting.trainerMassKg',
      problems,
      1,
      500,
    );
    if (trainerMassKg === 0) trainerMassKg = fallback.shifting.trainerMassKg;
  }

  let bounds = fallback.overlay.bounds ? { ...fallback.overlay.bounds } : null;
  if (overlay.bounds === null) bounds = null;
  else if (overlay.bounds !== undefined) {
    if (isBounds(overlay.bounds)) {
      const b = overlay.bounds;
      bounds = {
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      };
    } else problems.push('overlay.bounds: expected { x, y, width, height } or null');
  }

  let editHotkey = str(
    overlay.editHotkey,
    fallback.overlay.editHotkey,
    'overlay.editHotkey',
    problems,
    100,
  );
  if (editHotkey.trim() === '') {
    problems.push('overlay.editHotkey: empty');
    editHotkey = fallback.overlay.editHotkey;
  }

  return {
    rider: {
      name: str(rider.name, fallback.rider.name, 'rider.name', problems, 100),
      massKg: num(rider.massKg, fallback.rider.massKg, 'rider.massKg', problems, 20, 300),
      bikeMassKg: num(
        rider.bikeMassKg,
        fallback.rider.bikeMassKg,
        'rider.bikeMassKg',
        problems,
        0,
        60,
      ),
      ftpW: Math.round(num(rider.ftpW, fallback.rider.ftpW, 'rider.ftpW', problems, 50, 600)),
    },
    devices: sanitizeDevices(root.devices, fallback.devices, problems),
    shifting: {
      physicalRatio: num(
        shifting.physicalRatio,
        fallback.shifting.physicalRatio,
        'shifting.physicalRatio',
        problems,
        0.1,
        20,
      ),
      trainerMassKg,
      buttons: sanitizeButtons(shifting.buttons, fallback.shifting.buttons, problems),
      levers: sanitizeLevers(shifting.levers, fallback.shifting.levers, problems),
    },
    overlay: {
      visible: bool(overlay.visible, fallback.overlay.visible, 'overlay.visible', problems),
      bounds,
      backdropOpacity: num(
        overlay.backdropOpacity,
        fallback.overlay.backdropOpacity,
        'overlay.backdropOpacity',
        problems,
        0,
        1,
      ),
      tiles: sanitizeTiles(overlay.tiles, fallback.overlay.tiles, problems),
      showGroup: bool(overlay.showGroup, fallback.overlay.showGroup, 'overlay.showGroup', problems),
      editHotkey,
    },
    group: {
      useOwnServer: bool(
        group.useOwnServer,
        fallback.group.useOwnServer,
        'group.useOwnServer',
        problems,
      ),
      signallingUrl: sanitizeSignallingUrl(
        group.signallingUrl,
        fallback.group.signallingUrl,
        problems,
      ),
      relayUrls: sanitizeRelayUrls(group.relayUrls, fallback.group.relayUrls, problems),
    },
    route: {
      difficulty: num(
        route.difficulty,
        fallback.route.difficulty,
        'route.difficulty',
        problems,
        0,
        100,
      ),
    },
  };
}

/** `settings.update(patch)`: deep-merge (arrays replace), then validate against the current value. */
export function applySettingsPatch(
  current: Settings,
  patch: DeepPartial<Settings> | unknown,
  problems: Problems = [],
): Settings {
  if (!isPlainObject(patch)) {
    problems.push('patch: expected an object');
    return clone(current);
  }
  return sanitizeSettings(deepMerge(current, patch), current, problems);
}

export function forgetDevice(current: Settings, kind: unknown): Settings {
  const next = clone(current);
  if (has(DEVICE_KINDS, kind)) delete next.devices[kind];
  return next;
}

export function isDeviceKind(v: unknown): v is DeviceKind {
  return has(DEVICE_KINDS, v);
}
