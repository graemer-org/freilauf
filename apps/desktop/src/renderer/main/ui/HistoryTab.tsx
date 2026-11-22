import { useState } from 'react';
import type { RideListItem } from '../../../shared/contract';
import { formatDistance, formatDuration } from './format';
import { useApp, useAppState } from './hooks';

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDate(ms: number): string {
  return Number.isFinite(ms) ? dateFormat.format(new Date(ms)) : '–';
}

function HistoryRow({ ride }: { ride: RideListItem }) {
  const app = useApp();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  return (
    <tr data-testid="history-row">
      <td>
        <div className="ride-name">
          {ride.name}
          {!ride.finished && (
            <span className="tag tag-warn" title="Saved from an unfinished session">
              recovered
            </span>
          )}
        </div>
        <div className="ride-date">{formatDate(ride.startedAt)}</div>
      </td>
      <td className="num">{formatDuration(ride.durationS)}</td>
      <td className="num">{formatDistance(ride.distanceM)}</td>
      <td className="num">
        {Number.isFinite(ride.avgPowerW) ? `${Math.round(ride.avgPowerW)} W` : '–'}
      </td>
      <td className="actions">
        {confirmDelete ? (
          <span className="button-row" role="group" aria-label="Delete ride?">
            <span className="confirm-label">Delete this ride?</span>
            <button
              type="button"
              className="btn btn-small btn-danger-solid"
              data-testid="delete-confirm"
              onClick={() => {
                setConfirmDelete(false);
                void app.deleteRide(ride.id);
              }}
            >
              Delete
            </button>
            <button type="button" className="btn btn-small" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </span>
        ) : (
          <span className="button-row">
            <button
              type="button"
              className="btn btn-small"
              data-testid="export-fit"
              disabled={exporting}
              onClick={() => {
                setExporting(true);
                void app.exportFit(ride.id).finally(() => setExporting(false));
              }}
            >
              {exporting ? 'Exporting…' : 'Export .fit'}
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger"
              data-testid="delete-ride"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

export function HistoryTab() {
  const app = useApp();
  const rides = useAppState((s) => s.rides);
  const sorted = [...rides].sort((a, b) => b.startedAt - a.startedAt);
  return (
    <div className="page history">
      <div className="section-head">
        <h2 className="page-title">Rides</h2>
        <div className="button-row">
          <button type="button" className="btn btn-small" onClick={() => void app.refreshRides()}>
            Refresh
          </button>
          <button type="button" className="btn btn-small" onClick={() => app.openRidesFolder()}>
            Open folder
          </button>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="card empty" data-testid="history-empty">
          <svg className="empty-icon" viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="14" cy="32" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="34" cy="32" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <path
              d="M14 32l7-13h10l3 13M21 19l-2-5h-4M31 19l2-5h4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <p className="empty-title">No rides yet</p>
          <p className="empty-text">
            Finished rides are saved here automatically and can be exported as .fit files.
          </p>
        </div>
      ) : (
        <div className="card card-clip">
          <table className="history-table">
            <thead>
              <tr>
                <th scope="col">Ride</th>
                <th scope="col" className="num">
                  Duration
                </th>
                <th scope="col" className="num">
                  Distance
                </th>
                <th scope="col" className="num">
                  Avg power
                </th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((ride) => (
                <HistoryRow key={ride.id} ride={ride} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
