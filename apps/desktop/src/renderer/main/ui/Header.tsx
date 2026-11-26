import type { DeviceKind } from '@freilauf/devices';
import { BatteryBadge } from './Battery';
import { DEVICE_KINDS, DEVICE_LABEL, describeDevice } from './deviceStatus';
import { formatDuration } from './format';
import { useAppState } from './hooks';

const TESTID: Record<DeviceKind, string> = {
  trainer: 'chip-trainer',
  heartRate: 'chip-heartRate',
  controller: 'chip-controller',
};

function DeviceChip({ kind }: { kind: DeviceKind }) {
  const state = useAppState((s) => s.live?.devices[kind]?.state ?? null);
  const remembered = useAppState((s) => s.settings?.devices[kind] !== undefined);
  const busy = useAppState((s) => s.busy[kind]);
  const { text, tone } = describeDevice(state, remembered, busy);
  return (
    <li className={`chip chip-${tone}`} data-testid={TESTID[kind]} data-state={state ?? 'none'}>
      <span className="status-mark" aria-hidden="true" />
      <span className="chip-label">{DEVICE_LABEL[kind]}</span>
      <span className="chip-text">{text}</span>
      <BatteryBadge kind={kind} />
    </li>
  );
}

export function DeviceChips() {
  return (
    <ul className="chips" aria-label="Device status">
      {DEVICE_KINDS.map((kind) => (
        <DeviceChip key={kind} kind={kind} />
      ))}
    </ul>
  );
}

export const LOST_TEXT: Record<DeviceKind, string> = {
  trainer: 'Trainer connection lost — reconnecting… Power reads 0 until it is back.',
  heartRate: 'Heart rate connection lost — reconnecting…',
  controller: 'Controller connection lost — reconnecting… Keyboard shifting still works.',
};

function ReconnectBanner({ kind }: { kind: DeviceKind }) {
  const reconnecting = useAppState((s) => s.live?.devices[kind]?.state === 'reconnecting');
  if (!reconnecting) return null;
  return (
    <p className="banner banner-warn" role="status" data-testid={`banner-${kind}`}>
      {LOST_TEXT[kind]}
    </p>
  );
}

/** Non-blocking banners for devices that dropped and are being recovered. */
export function ConnectionBanners() {
  return (
    <div className="banners" aria-live="polite">
      {DEVICE_KINDS.map((kind) => (
        <ReconnectBanner key={kind} kind={kind} />
      ))}
    </div>
  );
}

/** A freewheel: outer ring and hub. Drawn here, no external asset. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="10" cy="10" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function SimBadge() {
  const simMode = useAppState((s) => s.simMode);
  if (!simMode) return null;
  return (
    <span className="badge badge-sim" data-testid="sim-badge">
      Simulation
    </span>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      <span className="brand-name">Freilauf</span>
      <SimBadge />
    </div>
  );
}

/** One status dot per device, for the ride view's quiet toolbar. */
function DeviceDot({ kind }: { kind: DeviceKind }) {
  const state = useAppState((s) => s.live?.devices[kind]?.state ?? null);
  const remembered = useAppState((s) => s.settings?.devices[kind] !== undefined);
  const busy = useAppState((s) => s.busy[kind]);
  const { text, tone } = describeDevice(state, remembered, busy);
  return (
    <span
      className={`dot-item chip-${tone}`}
      data-testid={`dot-${kind}`}
      data-state={state ?? 'none'}
    >
      <span className="status-mark" aria-hidden="true" />
      <span className="visually-hidden">{`${DEVICE_LABEL[kind]}: ${text}.`}</span>
      <span className="dot-label" aria-hidden="true">
        {DOT_LABEL[kind]}
      </span>
      <BatteryBadge kind={kind} />
    </span>
  );
}

const DOT_LABEL: Record<DeviceKind, string> = {
  trainer: 'Trainer',
  heartRate: 'HR',
  controller: 'Controls',
};

export function DeviceDots() {
  return (
    <span className="dots">
      {DEVICE_KINDS.map((kind) => (
        <DeviceDot key={kind} kind={kind} />
      ))}
    </span>
  );
}

/**
 * While a ride is recording or paused and the ride view is not shown: a persistent bar that
 * says so and leads back. The ride keeps running underneath — it is never paused silently.
 */
export function RideReturnBar({ onReturn }: { onReturn: () => void }) {
  const state = useAppState((s) => s.live?.ride.state ?? 'idle');
  const elapsed = useAppState((s) => Math.floor(s.live?.ride.elapsedS ?? 0));
  if (state === 'idle') return null;
  return (
    <div className="return-bar" role="status" data-testid="ride-return-bar" data-state={state}>
      <span className="ride-state" data-state={state}>
        {state === 'riding' ? 'Ride in progress' : 'Ride paused'}
      </span>
      <span className="return-time">{formatDuration(elapsed)}</span>
      <span className="return-note">
        {state === 'riding' ? 'Still recording.' : 'Resume or finish it in the ride view.'}
      </span>
      <button
        type="button"
        className="btn btn-small btn-primary"
        data-testid="ride-return"
        onClick={onReturn}
      >
        Return to ride
      </button>
    </div>
  );
}
