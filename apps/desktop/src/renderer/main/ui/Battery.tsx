import type { BatteryState, DeviceKind } from '@freilauf/devices';
import {
  batteryParts,
  batteryTone,
  describeBattery,
  formatBatteryTime,
  formatPercent,
  shownBattery,
} from '../batteryStatus';
import type { BatteryTone } from '../batteryStatus';
import { DEVICE_LABEL } from './deviceStatus';
import { useAppState } from './hooks';

/** The device's battery while it is connected (a stable object: it only changes with a reading). */
export function useBattery(kind: DeviceKind): BatteryState | null {
  return useAppState((s) => shownBattery(s.live?.devices[kind]));
}

/** A small horizontal battery whose fill follows the level. Drawn here, no external asset. */
export function BatteryIcon({ percent, tone }: { percent: number; tone: BatteryTone }) {
  const width = percent <= 0 ? 0 : Math.max(1.6, (15 * Math.min(100, percent)) / 100);
  return (
    <svg className={`battery-icon battery-${tone}`} viewBox="0 0 22 12" aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width="18"
        height="10.5"
        rx="2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect x="19.9" y="3.8" width="1.6" height="4.4" rx="0.8" fill="currentColor" />
      <rect x="2.25" y="2.25" width={width} height="7.5" rx="1.3" fill="currentColor" />
    </svg>
  );
}

/**
 * Compact level for the device chips and the ride view's top bar: one icon and
 * the lowest level (for the controllers, the weaker grip; both in the tooltip).
 */
export function BatteryBadge({ kind }: { kind: DeviceKind }) {
  const battery = useBattery(kind);
  if (!battery) return null;
  const tone = batteryTone(battery.percent);
  const side = weakerSide(battery);
  const title = `${DEVICE_LABEL[kind]} ${describeBattery(battery)}`;
  return (
    <span
      className={`battery-badge battery-${tone}`}
      data-testid={`battery-${kind}`}
      data-percent={battery.percent}
      data-tone={tone}
      title={title}
    >
      <BatteryIcon percent={battery.percent} tone={tone} />
      <span className="battery-value" aria-hidden="true">
        {side && <span className="battery-side">{side}</span>}
        {formatPercent(battery.percent)}
      </span>
      <span className="visually-hidden">{`, ${describeBattery(battery)}`}</span>
    </span>
  );
}

/** Devices screen: every level (each controller grip) with its icon and the time of the reading. */
export function BatteryDetail({ kind }: { kind: DeviceKind }) {
  const battery = useBattery(kind);
  if (!battery) return null;
  return (
    <p className="device-battery" data-testid={`battery-detail-${kind}`}>
      {batteryParts(battery).map((part) => (
        <span
          key={part.side ?? 'whole'}
          className={`battery-part battery-${part.tone}`}
          data-testid={`battery-detail-${kind}-${part.side?.toLowerCase() ?? 'whole'}`}
          data-tone={part.tone}
        >
          <BatteryIcon percent={part.percent} tone={part.tone} />
          <span>
            {part.side ? `${part.side} ` : 'Battery '}
            <strong>{formatPercent(part.percent)}</strong>
          </span>
        </span>
      ))}
      <span className="hint battery-time">
        {`updated ${formatBatteryTime(battery.updatedAt)}`}
        {batteryTone(battery.percent) !== 'normal' && ' · charge soon'}
      </span>
    </p>
  );
}

/** "L" / "R" when the grips differ (the compact display shows the weaker one). */
function weakerSide(battery: BatteryState): 'L' | 'R' | null {
  if (battery.left === undefined || battery.right === undefined) return null;
  if (battery.left < battery.right) return 'L';
  return battery.right < battery.left ? 'R' : null;
}
