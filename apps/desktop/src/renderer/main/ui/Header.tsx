import type { DeviceKind } from '@freilauf/devices';
import { DEVICE_KINDS, DEVICE_LABEL, describeDevice } from './deviceStatus';
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
      <span className="chip-dot" aria-hidden="true" />
      <span className="chip-label">{DEVICE_LABEL[kind]}</span>
      <span className="chip-text">{text}</span>
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

const LOST_TEXT: Record<DeviceKind, string> = {
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
