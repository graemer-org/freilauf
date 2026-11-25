import type { DeviceKind } from '@freilauf/devices';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DEVICE_KINDS, DEVICE_LABEL, describeDevice } from './deviceStatus';
import { GroupTab } from './GroupTab';
import { ConnectionBanners, DeviceDots, LOST_TEXT, SimBadge } from './Header';
import { isEditableTarget, useAppState } from './hooks';
import { RideTab } from './RideTab';
import { OverlaySettings } from './SettingsTab';
import { WatchRelayBadge } from './WatchRelay';

type Sheet = 'devices' | 'group' | 'overlay';

const SHEET_TITLE: Record<Sheet, string> = {
  devices: 'Devices',
  group: 'Group ride',
  overlay: 'Overlay',
};

export interface RideViewProps {
  onLeave: () => void;
  onFinished: () => void;
  onOpenWorkouts: () => void;
  onOpenDevices: () => void;
  onOpenSettings: () => void;
  extras?: ReactNode;
}

function DeviceStatusRow({ kind }: { kind: DeviceKind }) {
  const state = useAppState((s) => s.live?.devices[kind]?.state ?? null);
  const name = useAppState(
    (s) => s.live?.devices[kind]?.name ?? s.settings?.devices[kind]?.name ?? null,
  );
  const remembered = useAppState((s) => s.settings?.devices[kind] !== undefined);
  const busy = useAppState((s) => s.busy[kind]);
  const { text, tone } = describeDevice(state, remembered, busy);
  return (
    <li className="sheet-device" data-testid={`sheet-device-${kind}`} data-state={state ?? 'none'}>
      <span className="sheet-device-name">
        <strong>{DEVICE_LABEL[kind]}</strong>
        <span className="hint">{name ?? 'No device paired'}</span>
      </span>
      <span className={`chip chip-${tone}`}>
        <span className="status-mark" aria-hidden="true" />
        <span className="chip-text">{text}</span>
      </span>
      {state === 'reconnecting' && (
        <p className="callout-warn sheet-device-note">{LOST_TEXT[kind]}</p>
      )}
    </li>
  );
}

function DevicesSheet({ onOpenDevices }: { onOpenDevices: () => void }) {
  return (
    <>
      <ul className="list sheet-devices">
        {DEVICE_KINDS.map((kind) => (
          <DeviceStatusRow key={kind} kind={kind} />
        ))}
      </ul>
      <p className="hint">
        Remembered devices reconnect on their own; the ride keeps recording meanwhile.
      </p>
      <button
        type="button"
        className="btn"
        data-testid="ride-devices-manage"
        onClick={onOpenDevices}
      >
        Pairing and controllers…
      </button>
    </>
  );
}

function RideSheet({
  sheet,
  onClose,
  onOpenDevices,
  onOpenSettings,
}: {
  sheet: Sheet;
  onClose: () => void;
  onOpenDevices: () => void;
  onOpenSettings: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [sheet]);
  return (
    <aside
      ref={ref}
      className="sheet"
      id="ride-sheet"
      tabIndex={-1}
      aria-labelledby="ride-sheet-title"
      data-testid={`ride-sheet-${sheet}`}
    >
      <div className="sheet-head">
        <h2 id="ride-sheet-title" className="section-title">
          {SHEET_TITLE[sheet]}
        </h2>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          data-testid="ride-sheet-close"
          aria-label={`Close ${SHEET_TITLE[sheet]}`}
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="sheet-body">
        {sheet === 'devices' && <DevicesSheet onOpenDevices={onOpenDevices} />}
        {sheet === 'group' && <GroupTab variant="ride" onOpenSettings={onOpenSettings} />}
        {sheet === 'overlay' && (
          <>
            <p className="hint">Changes show on the overlay at once — watch it while you edit.</p>
            <OverlaySettings />
          </>
        )}
      </div>
    </aside>
  );
}

function GroupToolLabel() {
  const joined = useAppState((s) => s.group.phase === 'joined');
  const riders = useAppState((s) => (s.group.phase === 'joined' ? s.group.peers.length + 1 : 0));
  return (
    <>
      Group
      {joined && <span className="tool-count">{riders}</span>}
    </>
  );
}

/**
 * The ride, filling the window. A quiet toolbar on top reaches what is needed mid-ride (device
 * status, the group, the overlay) as side panels, without leaving the ride.
 */
export function RideView(props: RideViewProps) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const editMode = useAppState((s) => s.overlayEditMode);
  const riding = useAppState((s) => (s.live?.ride.state ?? 'idle') !== 'idle');
  const toolRefs = useRef<Partial<Record<Sheet, HTMLButtonElement | null>>>({});

  // Overlay edit mode (hotkey or toggle): offer the tile setup right here, next to the overlay.
  useEffect(() => {
    if (editMode) setSheet('overlay');
  }, [editMode]);

  const close = (): void => {
    const was = sheet;
    setSheet(null);
    if (was) toolRefs.current[was]?.focus();
  };

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isEditableTarget(e.target)) return;
      e.preventDefault();
      setSheet(null);
      toolRefs.current[sheet]?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const tool = (kind: Sheet, label: ReactNode, testId: string, extra?: string) => (
    <button
      ref={(el) => {
        toolRefs.current[kind] = el;
      }}
      type="button"
      className={`tool${sheet === kind ? ' is-open' : ''}${extra ? ` ${extra}` : ''}`}
      data-testid={testId}
      aria-expanded={sheet === kind}
      aria-controls={sheet === kind ? 'ride-sheet' : undefined}
      onClick={() => (sheet === kind ? close() : setSheet(kind))}
    >
      {label}
    </button>
  );

  const toolbar = (
    <>
      <div className="ride-top">
        <div className="ride-top-left">
          <button
            type="button"
            className="tool tool-back"
            data-testid="ride-leave"
            aria-label={
              riding ? 'Start screen (the ride keeps recording)' : 'Back to the start screen'
            }
            onClick={props.onLeave}
          >
            <span aria-hidden="true">‹</span> Start screen
          </button>
          <SimBadge />
        </div>
        <div className="ride-top-right" role="toolbar" aria-label="Ride tools">
          {props.extras}
          <WatchRelayBadge />
          {tool(
            'devices',
            <>
              <DeviceDots />
              <span className="visually-hidden">Device status</span>
            </>,
            'ride-open-devices',
          )}
          {tool('group', <GroupToolLabel />, 'ride-open-group')}
          {tool(
            'overlay',
            <>Overlay{editMode && <span className="tool-count is-edit">editing</span>}</>,
            'ride-open-overlay',
          )}
        </div>
      </div>
      <ConnectionBanners />
    </>
  );

  return (
    <div className={`ride-view${sheet ? ' has-sheet' : ''}`}>
      <RideTab
        toolbar={toolbar}
        onFinished={props.onFinished}
        onOpenWorkouts={props.onOpenWorkouts}
      />
      {sheet && (
        <RideSheet
          sheet={sheet}
          onClose={close}
          onOpenDevices={props.onOpenDevices}
          onOpenSettings={props.onOpenSettings}
        />
      )}
    </div>
  );
}
