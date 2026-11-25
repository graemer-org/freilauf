/** Pure helpers for the overlay (no React, no DOM) — unit-tested directly. */
import type { ConnectionState, DeviceKind } from '@freilauf/devices';
import type { RideSnapshot } from '@freilauf/session';
import type { Bounds, LiveState } from '../../../shared/contract';
import type { PowerUpKind } from '../../../shared/powerUps';
import {
  CARD_KEYS,
  CARD_RACE_NAME,
  FOG_GAP,
  POWER_UP_INFO,
  POWER_UP_KEY,
  formatSignedM,
  gapsHidden,
} from '../../../shared/powerUps';
import { formatGap } from '../../main/ui/format';

export const MIN_WIDTH = 160;
export const MIN_HEIGHT = 80;
export const MAX_GROUP_ROWS = 8;

/**
 * New window bounds while dragging the bottom-right resize grip. Position is
 * kept; size follows the pointer's screen-space delta, clamped to the minimum.
 */
export function computeResizeBounds(
  start: Bounds,
  startPointer: { screenX: number; screenY: number },
  pointer: { screenX: number; screenY: number },
): Bounds {
  const dx = pointer.screenX - startPointer.screenX;
  const dy = pointer.screenY - startPointer.screenY;
  return {
    ...start,
    width: Math.max(MIN_WIDTH, Math.round(start.width + dx)),
    height: Math.max(MIN_HEIGHT, Math.round(start.height + dy)),
  };
}

/** Shown in edit mode before any live data so the user sees what they are positioning. */
export const PLACEHOLDER_RIDE: RideSnapshot = {
  state: 'riding',
  elapsedS: 1834,
  distanceM: 14_250,
  speedMps: 9.2,
  powerW: 245,
  power3sW: 248,
  wattsPerKg: 3.3,
  cadenceRpm: 88,
  heartRateBpm: 142,
  gear: 12,
  gearCount: 24,
  gradePercent: 2.5,
};

export const PLACEHOLDER_LIVE: LiveState = {
  ride: PLACEHOLDER_RIDE,
  devices: {
    trainer: { name: 'Trainer', state: 'connected' },
    heartRate: { name: 'HR strap', state: 'connected' },
    controller: null,
  },
  group: {
    roomCode: 'EDIT',
    riders: [
      {
        peerId: 'placeholder-a',
        name: 'Rider ahead',
        distanceM: 14_330,
        speedMps: 9.4,
        powerW: 262,
        cadenceRpm: 90,
        heartRateBpm: 150,
        gear: 13,
        gapM: 80,
        stale: false,
      },
      {
        peerId: 'placeholder-b',
        name: 'Rider behind',
        distanceM: 14_200,
        speedMps: 9.0,
        powerW: 231,
        cadenceRpm: 84,
        heartRateBpm: null,
        gear: 11,
        gapM: -50,
        stale: true,
      },
    ],
  },
  localName: 'You',
  // Sample energy so calorie / fat tiles show something while arranging the overlay.
  energy: { kcal: 612, source: 'power', kcalPower: 612, kcalHr: null, fatG: 31, carbG: 79 },
};

const DEVICE_LABEL: Record<DeviceKind, string> = {
  trainer: 'Trainer',
  heartRate: 'Heart rate',
  controller: 'Controller',
};

const DEVICE_KINDS: readonly DeviceKind[] = ['trainer', 'heartRate', 'controller'];

export interface DeviceWarning {
  kind: DeviceKind;
  text: string;
}

function isTrouble(state: ConnectionState): state is 'reconnecting' | 'disconnected' {
  return state === 'reconnecting' || state === 'disconnected';
}

/**
 * Warnings for devices in trouble. The trainer always counts (riding without
 * it is pointless); other devices only once they were seen connected, so an
 * unused HR strap does not nag.
 */
export function deviceWarnings(
  devices: LiveState['devices'] | undefined,
  everConnected: ReadonlySet<DeviceKind>,
): DeviceWarning[] {
  if (!devices) return [];
  const out: DeviceWarning[] = [];
  for (const kind of DEVICE_KINDS) {
    const status = devices[kind];
    if (!status || !isTrouble(status.state)) continue;
    if (kind !== 'trainer' && !everConnected.has(kind)) continue;
    const label = DEVICE_LABEL[kind];
    out.push({
      kind,
      text: status.state === 'reconnecting' ? `${label} reconnecting…` : `${label} disconnected`,
    });
  }
  return out;
}

export interface GroupRow {
  key: string;
  name: string;
  gapM: number;
  /** The gap as shown: "+12 m", or "?" while Fog lies on the local rider (Card Race). */
  gapText: string;
  powerW: number;
  heartRateBpm: number | null;
  stale: boolean;
  local: boolean;
}

/**
 * Group rows sorted by position (furthest ahead first), including the local
 * rider at gap 0. Capped at `max` rows; the local rider is always kept.
 */
export function groupRows(live: LiveState, max = MAX_GROUP_ROWS): GroupRow[] {
  const riders = live.group?.riders ?? [];
  const fog = gapsHidden(live.powerUps);
  const rows: GroupRow[] = riders.map((r) => ({
    key: r.peerId,
    name: r.name,
    gapM: Number.isFinite(r.gapM) ? r.gapM : 0,
    gapText: fog ? FOG_GAP : formatGap(Number.isFinite(r.gapM) ? r.gapM : 0),
    powerW: r.powerW,
    heartRateBpm: r.heartRateBpm,
    stale: r.stale,
    local: false,
  }));
  rows.push({
    key: '__local__',
    name: live.localName,
    gapM: 0,
    gapText: formatGap(0),
    powerW: live.ride.powerW,
    heartRateBpm: live.ride.heartRateBpm,
    stale: false,
    local: true,
  });
  // Stable sort; on equal gap the local rider goes first.
  rows.sort((a, b) => b.gapM - a.gapM || Number(b.local) - Number(a.local));
  if (rows.length <= max) return rows;
  const top = rows.slice(0, max);
  if (top.some((r) => r.local)) return top;
  const local = rows.find((r) => r.local);
  return local ? [...rows.slice(0, max - 1), local] : top;
}

export interface WorkoutStrip {
  label: string;
  /** "240 W", "Free ride" or "Done". */
  target: string;
  /** Step countdown, e.g. "3:12"; empty once finished. */
  countdown: string;
  /** Progress through the current step, 0…1. */
  progress: number;
  cue: string | null;
  finished: boolean;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** What the overlay's workout strip shows; null when there is no running workout. */
export function workoutStrip(workout: LiveState['workout']): WorkoutStrip | null {
  if (!workout || !workout.started) return null;
  if (workout.finished) {
    return {
      label: 'Workout complete',
      target: 'Done',
      countdown: '',
      progress: 1,
      cue: null,
      finished: true,
    };
  }
  const span = workout.segmentElapsedS + workout.segmentRemainingS;
  const progress = span > 0 ? Math.min(1, Math.max(0, workout.segmentElapsedS / span)) : 0;
  const target =
    workout.mode === 'erg' && workout.targetPowerW !== null && Number.isFinite(workout.targetPowerW)
      ? `${Math.round(workout.targetPowerW)} W`
      : 'Free ride';
  return {
    label: workout.label,
    target,
    countdown: clock(workout.segmentRemainingS),
    progress,
    cue: workout.cue ? workout.cue : null,
    finished: false,
  };
}

export interface RouteStrip {
  name: string;
  /** "12.4 km to go", or "Route complete". */
  left: string;
  /** Climbing still to come, e.g. "↑ 320 m"; empty once done. */
  climb: string;
  /** The gradient under the rider, e.g. "+4.5 %". */
  grade: string;
  /** "Lap 2" on a loop after the first lap; empty otherwise. */
  lap: string;
  finished: boolean;
}

function km(m: number): string {
  const v = Math.max(0, Number.isFinite(m) ? m : 0);
  return v < 1000 ? `${Math.round(v / 10) * 10} m` : `${(v / 1000).toFixed(1)} km`;
}

function gradeText(g: number): string {
  if (!Number.isFinite(g)) return '–';
  const r = Math.round(g * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} %`;
}

/** What the overlay's route strip shows; null without a route. */
export function routeStrip(route: LiveState['route']): RouteStrip | null {
  if (!route) return null;
  if (route.finished) {
    return {
      name: route.name,
      left: 'Route complete',
      climb: '',
      grade: '',
      lap: '',
      finished: true,
    };
  }
  return {
    name: route.name,
    left: `${km(route.remainingM)} to go`,
    climb: `↑ ${Math.round(Math.max(0, route.ascentRemainingM))} m`,
    grade: gradeText(route.gradePercent),
    lap: route.lap > 1 ? `Lap ${route.lap}` : '',
    finished: false,
  };
}

/** One compact power-up line for the overlay: what is held, running or asked for. */
export interface PowerUpPill {
  key: 'challenge' | 'effect' | 'held' | 'attack' | 'hand' | 'guard';
  kind: PowerUpKind | null;
  text: string;
  /** Quieter second part, e.g. "212 W now", "+38 m". */
  detail: string;
  /** Highlighted (a power-up ready to use, a target being met). */
  active: boolean;
  /** Card Race: the colour of the marker (the text says what it is too). */
  tone?: 'attack' | 'guard';
}

/** The group panel's heading in a Card Race (absent in a normal ride). */
export function groupModeLabel(live: LiveState | null): string | null {
  return live?.group?.mode === 'cardRace' ? CARD_RACE_NAME : null;
}

/**
 * The Card Race in the overlay (at most four pills): an attack acting on the rider, the hand
 * ("L Headwind · R Shield", with the keys when one can be played), the own boost or the
 * challenge, and the shield or protection; the race offset rides along once.
 */
export function cardPills(pu: LiveState['powerUps']): PowerUpPill[] {
  const c = pu?.cards;
  if (!pu || !c) return [];
  const out: PowerUpPill[] = [];
  if (c.attack) {
    const name = POWER_UP_INFO[c.attack.kind].label;
    out.push({
      key: 'attack',
      kind: c.attack.kind,
      text: `${name} from ${c.attack.by}`,
      detail: c.attack.kind === 'fog' ? 'gaps hidden' : `${Math.ceil(c.attack.remainingS)} s`,
      active: true,
      tone: 'attack',
    });
  }
  const label = (k: PowerUpKind | null) => (k ? POWER_UP_INFO[k].label : '–');
  const ready = c.slots.map((k, i) => k !== null && c.slotNotes[i] === null);
  out.push({
    key: 'hand',
    kind: c.slots[0] ?? c.slots[1] ?? null,
    text: `L ${label(c.slots[0] ?? null)} · R ${label(c.slots[1] ?? null)}`,
    detail:
      ready[0] && ready[1]
        ? `${CARD_KEYS.left} / ${CARD_KEYS.right}`
        : ready[0]
          ? CARD_KEYS.left
          : ready[1]
            ? CARD_KEYS.right
            : '',
    active: ready.some(Boolean),
  });
  const offset = Math.round(pu.raceOffsetM) !== 0 ? formatSignedM(pu.raceOffsetM) : '';
  const guard: PowerUpPill | null = c.shield
    ? {
        key: 'guard',
        kind: 'shield',
        text: `Shield up · ${Math.ceil(c.shield.remainingS)} s`,
        detail: '',
        active: true,
        tone: 'guard',
      }
    : c.protection
      ? {
          key: 'guard',
          kind: null,
          text: `Protected · ${Math.ceil(c.protection.remainingS)} s`,
          detail: '',
          active: true,
          tone: 'guard',
        }
      : null;
  if (pu.challenge) {
    out.push({
      key: 'challenge',
      kind: null,
      text: `Hold ${pu.challenge.targetW} W · ${Math.ceil(pu.challenge.remainingS)} s`,
      detail: `${pu.challenge.powerW} W now`,
      active: pu.challenge.powerW >= pu.challenge.targetW * 0.95,
    });
  } else if (pu.effect) {
    out.push({
      key: 'effect',
      kind: pu.effect.kind,
      text:
        pu.effect.phase === 'armed'
          ? `${POWER_UP_INFO[pu.effect.kind].label} · armed`
          : `${POWER_UP_INFO[pu.effect.kind].label} · ${Math.ceil(pu.effect.remainingS)} s`,
      detail: offset,
      active: pu.effect.phase === 'active',
    });
  } else if (offset && !guard) {
    out.push({ key: 'effect', kind: null, text: 'Race', detail: offset, active: false });
  }
  if (guard) out.push({ ...guard, detail: out.some((p) => p.detail === offset) ? '' : offset });
  return out.slice(0, 4);
}

/** What the overlay shows about power-ups (at most two pills); [] without any. */
export function powerUpPills(pu: LiveState['powerUps']): PowerUpPill[] {
  if (!pu) return [];
  if (pu.cards) return cardPills(pu);
  const out: PowerUpPill[] = [];
  const ch = pu.challenge;
  if (ch) {
    const s = Math.ceil(ch.remainingS);
    out.push({
      key: 'challenge',
      kind: null,
      text: `Hold ${ch.targetW} W · ${s} s`,
      detail: `${ch.powerW} W now`,
      active: ch.powerW >= ch.targetW * 0.95,
    });
  }
  const gain = pu.raceOffsetM >= 1 ? `+${Math.round(pu.raceOffsetM)} m` : '';
  if (pu.effect) {
    const name = POWER_UP_INFO[pu.effect.kind].label;
    out.push({
      key: 'effect',
      kind: pu.effect.kind,
      text:
        pu.effect.phase === 'armed'
          ? `${name} · armed`
          : `${name} · ${Math.ceil(pu.effect.remainingS)} s`,
      detail: gain,
      active: pu.effect.phase === 'active',
    });
  } else if (pu.held) {
    out.push({
      key: 'held',
      kind: pu.held,
      text: `${POWER_UP_INFO[pu.held].label}${pu.canActivate ? ' ready' : ''}`,
      detail: pu.canActivate ? `side button / ${POWER_UP_KEY}` : gain,
      active: pu.canActivate,
    });
  } else if (gain) {
    out.push({ key: 'effect', kind: null, text: 'Power-ups', detail: gain, active: false });
  }
  return out.slice(0, 2);
}
