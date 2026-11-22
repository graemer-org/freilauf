/** Pure helpers for the overlay (no React, no DOM) — unit-tested directly. */
import type { ConnectionState, DeviceKind } from '@freilauf/devices';
import type { RideSnapshot } from '@freilauf/session';
import type { Bounds, LiveState } from '../../../shared/contract';

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
  const rows: GroupRow[] = riders.map((r) => ({
    key: r.peerId,
    name: r.name,
    gapM: Number.isFinite(r.gapM) ? r.gapM : 0,
    powerW: r.powerW,
    heartRateBpm: r.heartRateBpm,
    stale: r.stale,
    local: false,
  }));
  rows.push({
    key: '__local__',
    name: live.localName,
    gapM: 0,
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
