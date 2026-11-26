/**
 * Battery levels of the connected devices as the UI shows them: colour
 * thresholds, the compact and detailed texts, and the low-battery notice at
 * ride start. Pure (unit-tested in batteryStatus.test.ts).
 */
import type { BatteryState, ConnectionState, DeviceKind } from '@freilauf/devices';

/** Below this the level is shown in orange. */
export const BATTERY_LOW_PERCENT = 20;
/** Below this the level is shown in red. */
export const BATTERY_CRITICAL_PERCENT = 10;
/** Below this a notice is shown when a ride starts. */
export const BATTERY_NOTICE_PERCENT = 15;

export type BatteryTone = 'normal' | 'low' | 'critical';

export function batteryTone(percent: number): BatteryTone {
  if (percent < BATTERY_CRITICAL_PERCENT) return 'critical';
  if (percent < BATTERY_LOW_PERCENT) return 'low';
  return 'normal';
}

/** "64 %" (with a no-break space, so the value never wraps away from its unit). */
export function formatPercent(percent: number): string {
  return `${Math.round(percent)}\u00a0%`;
}

interface DeviceWithBattery {
  state: ConnectionState;
  battery?: BatteryState | null;
}

/**
 * The battery level to show for a device slot: only while the device is
 * connected (or reconnecting, when the last level is still the best guess).
 */
export function shownBattery(device: DeviceWithBattery | null | undefined): BatteryState | null {
  if (!device?.battery) return null;
  return device.state === 'connected' || device.state === 'reconnecting' ? device.battery : null;
}

export interface BatteryPart {
  /** 'Left' / 'Right' for a controller grip; null for the device as a whole. */
  side: 'Left' | 'Right' | null;
  percent: number;
  tone: BatteryTone;
}

/** The levels a detailed display lists: each grip when known, else the device as a whole. */
export function batteryParts(battery: BatteryState): BatteryPart[] {
  const parts: BatteryPart[] = [];
  if (battery.left !== undefined) {
    parts.push({ side: 'Left', percent: battery.left, tone: batteryTone(battery.left) });
  }
  if (battery.right !== undefined) {
    parts.push({ side: 'Right', percent: battery.right, tone: batteryTone(battery.right) });
  }
  if (parts.length === 0) {
    parts.push({ side: null, percent: battery.percent, tone: batteryTone(battery.percent) });
  }
  return parts;
}

/** "battery 64 %" or "battery: left 81 %, right 12 %" (tooltips, screen readers). */
export function describeBattery(battery: BatteryState): string {
  const parts = batteryParts(battery);
  if (parts.length === 1 && parts[0]!.side === null) {
    return `battery ${formatPercent(parts[0]!.percent)}`;
  }
  return `battery: ${parts
    .map((p) => `${p.side!.toLowerCase()} ${formatPercent(p.percent)}`)
    .join(', ')}`;
}

/** Clock time of the last reading, e.g. "14:32". */
export function formatBatteryTime(updatedAt: number, locale?: string): string {
  return new Date(updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

const NOTICE_NAME: Record<DeviceKind, string> = {
  trainer: 'trainer',
  heartRate: 'heart rate sensor',
  controller: 'controller',
};

const NOTICE_ORDER: readonly DeviceKind[] = ['trainer', 'heartRate', 'controller'];

export interface LowBattery {
  kind: DeviceKind;
  /** Grip of a controller, when it reports each side. */
  side: 'left' | 'right' | null;
  percent: number;
}

/** Device batteries below `threshold` (connected devices only), lowest first per device. */
export function lowBatteries(
  devices: Partial<Record<DeviceKind, DeviceWithBattery | null | undefined>>,
  threshold = BATTERY_NOTICE_PERCENT,
): LowBattery[] {
  const out: LowBattery[] = [];
  for (const kind of NOTICE_ORDER) {
    const battery = shownBattery(devices[kind]);
    if (!battery) continue;
    for (const part of batteryParts(battery)) {
      if (part.percent < threshold) {
        out.push({
          kind,
          side: part.side === null ? null : part.side === 'Left' ? 'left' : 'right',
          percent: part.percent,
        });
      }
    }
  }
  return out;
}

/** The notice for the start of a ride, or null when every battery is fine. */
export function lowBatteryNotice(
  devices: Partial<Record<DeviceKind, DeviceWithBattery | null | undefined>>,
): string | null {
  const low = lowBatteries(devices);
  if (low.length === 0) return null;
  const items = low.map(
    (l) => `${l.side ? `${l.side} ` : ''}${NOTICE_NAME[l.kind]} ${formatPercent(l.percent)}`,
  );
  const list =
    items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
  const it = low.length === 1 ? 'it' : 'them';
  return `Low battery: ${list}. Charge ${it} after this ride — the ride keeps recording if a device drops.`;
}
