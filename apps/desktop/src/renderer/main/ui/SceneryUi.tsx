/**
 * Scenery along routes in the Routes tab (docs/routes.md, "Surroundings from OpenStreetMap"):
 * the import option (off by default), the per-route status with progress and cancel, and
 * loading or removing it later. Loading is always the rider's explicit choice.
 */
import { useEffect, useMemo } from 'react';
import { OSM_ATTRIBUTION } from '@freilauf/routes';
import type { SceneryStatus } from '../appStore';
import { useApp, useAppState } from './hooks';
import { type RouteEntry, sceneryActions, sceneryStatusOf } from './routesApi';

/** The one-line privacy note next to every "load" control. */
export const SCENERY_PRIVACY_NOTE =
  'The map server learns roughly where the route runs; nothing about you is sent.';

export function SceneryImportOption({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="rt-scenery-option" data-testid="route-import-scenery-option">
      <label className="check-row">
        <input
          type="checkbox"
          data-testid="route-import-scenery"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />{' '}
        Load surroundings from OpenStreetMap
      </label>
      <p className="hint rt-scenery-note" data-testid="route-import-scenery-note">
        {SCENERY_PRIVACY_NOTE}
      </p>
    </div>
  );
}

const kb = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const km = (m: number): string => `${(m / 1000).toFixed(1)} km`;

/** "132 buildings · woods 2.5 km · water 6.4 km · Kleinmoos, Auhof" */
export function scenerySummaryText(status: SceneryStatus & { state: 'ready' }): string {
  const s = status.summary;
  if (!s) return `Stored (${kb(status.bytes)}).`;
  const parts: string[] = [];
  parts.push(s.buildings === 1 ? '1 building' : `${s.buildings} buildings`);
  if (s.forestM > 0) parts.push(`woods ${km(s.forestM)}`);
  if (s.waterM > 0) parts.push(`water ${km(s.waterM)}`);
  if (s.places.length > 0) parts.push(s.places.slice(0, 4).join(', '));
  parts.push(kb(status.bytes));
  return parts.join(' · ');
}

export function sceneryProgressText(status: SceneryStatus): string {
  if (status.state === 'queued') return 'Waiting to load surroundings…';
  if (status.state !== 'loading') return '';
  if (status.waitS !== null)
    return `The map server is busy; trying again in ${Math.max(1, status.waitS)} s…`;
  if (status.total === 0) return 'Loading surroundings…';
  return `Loading surroundings… part ${Math.min(status.done + 1, status.total)} of ${status.total}`;
}

/** A short line under the route's summary while loading or once stored. */
export function SceneryBadge({ entry }: { entry: RouteEntry }) {
  const app = useApp();
  const status = useAppState((s) => sceneryStatusOf(s, entry.id));
  const actions = useMemo(() => sceneryActions(app), [app]);
  if (status.state === 'queued' || status.state === 'loading') {
    return (
      <p className="wo-meta rt-scenery-badge" data-testid="route-scenery-progress" role="status">
        <span>{sceneryProgressText(status)}</span>{' '}
        {status.state === 'loading' && status.total > 0 && (
          <progress
            className="rt-scenery-progress"
            max={status.total}
            value={status.done}
            aria-label="Surroundings loaded"
          />
        )}{' '}
        <button
          type="button"
          className="btn btn-small btn-quiet"
          data-testid="route-scenery-cancel"
          onClick={() => actions.cancel(entry.id)}
        >
          Cancel
        </button>
      </p>
    );
  }
  if (status.state === 'ready') {
    return (
      <p className="wo-meta rt-scenery-badge" data-testid="route-scenery-badge">
        <span className="tag tag-accent">With surroundings</span>
      </p>
    );
  }
  if (status.state === 'error') {
    return (
      <p className="wo-meta rt-scenery-badge callout-warn" data-testid="route-scenery-error-badge">
        Surroundings not loaded
      </p>
    );
  }
  return null;
}

/** In a route's details: status, load / load again / remove. Imported routes only. */
export function SceneryDetails({ entry, riding }: { entry: RouteEntry; riding: boolean }) {
  const app = useApp();
  const status = useAppState((s) => sceneryStatusOf(s, entry.id));
  const actions = useMemo(() => sceneryActions(app), [app]);
  const needsSummary = status.state === 'ready' && status.summary === null;
  useEffect(() => {
    if (needsSummary) actions.summarize(entry.id);
  }, [needsSummary, actions, entry.id]);
  if (entry.source !== 'imported') return null;
  return (
    <div className="rt-scenery" data-testid="route-scenery" data-state={status.state}>
      <h4 className="rt-scenery-title">Surroundings</h4>
      {status.state === 'none' && (
        <>
          <p className="hint">
            Draw the buildings, woods, fields and water along this road in the ride scene. Loaded
            once, then kept on this device. {SCENERY_PRIVACY_NOTE}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-small"
              data-testid="route-scenery-load"
              onClick={() => actions.load(entry.id)}
            >
              Load surroundings
            </button>
          </div>
        </>
      )}
      {(status.state === 'queued' || status.state === 'loading') && (
        <div className="button-row" role="status" data-testid="route-scenery-loading">
          <span>{sceneryProgressText(status)}</span>
          <button
            type="button"
            className="btn btn-small"
            data-testid="route-scenery-details-cancel"
            onClick={() => actions.cancel(entry.id)}
          >
            Cancel
          </button>
        </div>
      )}
      {status.state === 'ready' && (
        <>
          <p data-testid="route-scenery-summary">{scenerySummaryText(status)}</p>
          <p className="hint" data-testid="route-scenery-attribution">
            Map data {OSM_ATTRIBUTION}
            {status.summary?.truncated
              ? ' · very dense: the buildings nearest the road are kept'
              : ''}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-small btn-danger"
              data-testid="route-scenery-remove"
              disabled={riding}
              onClick={() => actions.remove(entry.id)}
            >
              Remove surroundings
            </button>
            <button
              type="button"
              className="btn btn-small btn-quiet"
              data-testid="route-scenery-reload"
              onClick={() => actions.load(entry.id)}
            >
              Load again
            </button>
          </div>
        </>
      )}
      {status.state === 'error' && (
        <>
          <p className="callout-warn" data-testid="route-scenery-error">
            {status.message}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-small"
              data-testid="route-scenery-load"
              onClick={() => actions.load(entry.id)}
            >
              Try again
            </button>
          </div>
        </>
      )}
    </div>
  );
}
