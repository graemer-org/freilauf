import { memo, type CSSProperties, type PointerEventHandler } from 'react';
import type { DeviceKind } from '@freilauf/devices';
import type { LiveState, OverlaySettings, OverlayTile, StatId } from '../../../shared/contract';
import { formatGap, statLabel, statUnit, statValue } from '../../main/ui/format';
import { PLACEHOLDER_LIVE, deviceWarnings, groupRows, type GroupRow } from './logic';

const PLACEHOLDER = '–';
const NO_DEVICES: ReadonlySet<DeviceKind> = new Set();

export interface OverlayViewProps {
  live: LiveState | null;
  settings: OverlaySettings;
  editMode: boolean;
  /** Device kinds that were connected at some point (non-trainer warnings need this). */
  everConnected?: ReadonlySet<DeviceKind>;
  onDone?: () => void;
  onResizePointerDown?: PointerEventHandler<HTMLDivElement>;
  onResizePointerMove?: PointerEventHandler<HTMLDivElement>;
  onResizePointerUp?: PointerEventHandler<HTMLDivElement>;
}

function safeValue(stat: StatId, live: LiveState | null): string {
  if (!live) return PLACEHOLDER;
  try {
    return statValue(stat, live.ride);
  } catch {
    return PLACEHOLDER;
  }
}

const Tile = memo(function Tile({
  stat,
  size,
  value,
}: {
  stat: StatId;
  size: OverlayTile['size'];
  value: string;
}) {
  const unit = statUnit(stat);
  return (
    <div className={`ov-tile ov-tile--${size}`} data-testid={`overlay-tile-${stat}`}>
      <div className="ov-backdrop" aria-hidden="true" />
      <div className="ov-label ov-text">{statLabel(stat)}</div>
      <div className="ov-value-line">
        <span className="ov-value ov-text">{value}</span>
        {unit ? <span className="ov-unit ov-text">{unit}</span> : null}
      </div>
    </div>
  );
});

function fmtNum(n: number | null): string {
  return n == null || !Number.isFinite(n) ? PLACEHOLDER : String(Math.round(n));
}

function GroupPanel({ rows }: { rows: GroupRow[] }) {
  return (
    <div className="ov-group" data-testid="overlay-group">
      <div className="ov-backdrop" aria-hidden="true" />
      <ol className="ov-group-list">
        {rows.map((r) => (
          <li
            key={r.key}
            className={
              'ov-group-row' + (r.local ? ' ov-group-row--local' : '') + (r.stale ? ' ov-group-row--stale' : '')
            }
            data-local={r.local ? 'true' : undefined}
          >
            <span className="ov-g-name ov-text">{r.name}</span>
            <span className="ov-g-gap ov-text">{formatGap(r.gapM)}</span>
            <span className="ov-g-num ov-text">
              {fmtNum(r.powerW)}
              <small>W</small>
            </span>
            <span className="ov-g-num ov-text">
              {fmtNum(r.heartRateBpm)}
              <small>bpm</small>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Presentational overlay: pure function of its props, no api access. */
export function OverlayView({
  live: liveProp,
  settings,
  editMode,
  everConnected = NO_DEVICES,
  onDone,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
}: OverlayViewProps) {
  const live = liveProp ?? (editMode ? PLACEHOLDER_LIVE : null);
  const rideState = live?.ride.state;
  const warnings = deviceWarnings(live?.devices, everConnected);
  const rows = live && settings.showGroup && live.group && live.group.riders.length > 0 ? groupRows(live) : null;
  const opacity = Number.isFinite(settings.backdropOpacity)
    ? Math.min(1, Math.max(0, settings.backdropOpacity))
    : 0.55;
  const style = { '--ov-backdrop-alpha': String(opacity) } as CSSProperties;

  const classes = ['ov-root'];
  if (editMode) classes.push('ov-root--edit');
  if (rideState === 'idle') classes.push('ov-root--idle');

  return (
    <div className={classes.join(' ')} style={style} data-testid="overlay-root">
      {editMode ? (
        <div className="ov-edit-bar" data-testid="overlay-edit-bar">
          <span className="ov-edit-text">Overlay edit mode — drag to move, drag the corner to resize</span>
          <button type="button" className="ov-done" data-testid="overlay-done" onClick={onDone}>
            Done
          </button>
        </div>
      ) : null}

      <div className="ov-body">
        {warnings.length > 0 || rideState === 'paused' || rideState === 'idle' ? (
          <div className="ov-status-row">
            {warnings.map((w) => (
              <div key={w.kind} className="ov-warning" data-testid="overlay-warning" role="alert">
                <span className="ov-warning-icon ov-text" aria-hidden="true">
                  !
                </span>
                <span className="ov-text">{w.text}</span>
              </div>
            ))}
            {rideState === 'paused' ? (
              <div className="ov-status" data-testid="overlay-status">
                <div className="ov-backdrop" aria-hidden="true" />
                <span className="ov-text">Paused</span>
              </div>
            ) : null}
            {rideState === 'idle' ? (
              <div className="ov-status" data-testid="overlay-status">
                <div className="ov-backdrop" aria-hidden="true" />
                <span className="ov-text">Not recording</span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="ov-tiles">
          {settings.tiles.map((t, i) => (
            <Tile key={`${t.stat}-${i}`} stat={t.stat} size={t.size} value={safeValue(t.stat, live)} />
          ))}
        </div>

        {rows ? <GroupPanel rows={rows} /> : null}
      </div>

      {editMode ? (
        <div
          className="ov-resize"
          data-testid="overlay-resize"
          title="Drag to resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ) : null}
    </div>
  );
}
