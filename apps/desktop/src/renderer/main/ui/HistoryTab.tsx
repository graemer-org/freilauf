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
      <td>{formatDate(ride.startedAt)}</td>
      <td>
        {ride.name}
        {!ride.finished && (
          <span className="tag tag-warn" title="Saved from an unfinished session">
            recovered
          </span>
        )}
      </td>
      <td className="num">{formatDuration(ride.durationS)}</td>
      <td className="num">{formatDistance(ride.distanceM)}</td>
      <td className="num">
        {Number.isFinite(ride.avgPowerW) ? `${Math.round(ride.avgPowerW)} W` : '–'}
      </td>
      <td className="actions">
        {confirmDelete ? (
          <span className="button-row" role="group" aria-label="Delete ride?">
            <span>Delete?</span>
            <button
              type="button"
              className="btn btn-small btn-danger"
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
              className="btn btn-small"
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
    <div className="history">
      <div className="button-row">
        <button type="button" className="btn" onClick={() => void app.refreshRides()}>
          Refresh
        </button>
        <button type="button" className="btn" onClick={() => app.openRidesFolder()}>
          Open folder
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="empty" data-testid="history-empty">
          No rides yet. Finished rides are saved here automatically and can be exported as .fit
          files.
        </p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Name</th>
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
      )}
    </div>
  );
}
