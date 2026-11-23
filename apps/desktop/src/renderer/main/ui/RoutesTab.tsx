import { useId, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { downloadText } from './download';
import { useApp, useAppState } from './hooks';
import { RouteOutline, RouteProfile } from './RouteGraphics';
import {
  hasRouteState,
  routeActions,
  type RouteActions,
  type RouteEntry,
  routeSharing,
  type RouteSharing,
  routesOf,
  selectedRouteIdOf,
  sharedRoutesOf,
  sharingRouteIdOf,
  type SharedRoute,
} from './routesApi';
import {
  formatClimb,
  formatGradient,
  formatKm,
  routeImageLabel,
  routeSummary,
  steepestGradient,
} from './routeView';

/** GPX files above this are rejected before they are read. */
export const MAX_ROUTE_IMPORT_BYTES = 20 * 1024 * 1024;

interface ImportOutcome {
  key: number;
  fileName: string;
  ok: boolean;
  name?: string;
  messages: string[];
}

// ───────────── rows ─────────────

function RouteThumbs({ entry }: { entry: RouteEntry }) {
  const label = routeImageLabel(entry);
  return (
    <div className="rt-thumbs">
      <RouteOutline outline={entry.outline} loop={entry.loop} label={`Shape of ${label}`} />
      <RouteProfile profile={entry.profile} label={`Elevation profile of ${label}`} />
    </div>
  );
}

function DeleteRoute({ id, actions }: { id: string; actions: RouteActions }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-small btn-danger"
        data-testid="route-delete"
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    );
  }
  return (
    <span className="button-row" role="group" aria-label="Delete route?">
      <span className="confirm-label">Delete this route?</span>
      <button
        type="button"
        className="btn btn-small btn-danger-solid"
        data-testid="route-delete-confirm"
        onClick={() => {
          setConfirming(false);
          actions.remove(id);
        }}
      >
        Delete
      </button>
      <button type="button" className="btn btn-small" onClick={() => setConfirming(false)}>
        Keep
      </button>
    </span>
  );
}

function RouteDetails({
  entry,
  id,
  actions,
  sharing,
}: {
  entry: RouteEntry;
  id: string;
  actions: RouteActions;
  sharing: RouteSharing | null;
}) {
  const app = useApp();
  const sharingId = useAppState(sharingRouteIdOf);
  const steepest = useMemo(
    () => steepestGradient(entry.profile, entry.totalDistanceM, 200),
    [entry.profile, entry.totalDistanceM],
  );
  const label = routeImageLabel(entry);
  const save = (): void => {
    const file = actions.exportRoute(entry.id);
    if (!file) {
      app.notify('error', 'This route could not be exported.');
      return;
    }
    downloadText(file.fileName, file.text, 'application/gpx+xml');
  };
  return (
    <div className="wo-details rt-details" id={id} data-testid="route-details">
      <div className="rt-details-graphs">
        <RouteOutline
          outline={entry.outline}
          loop={entry.loop}
          size="lg"
          label={`Map of ${label}`}
        />
        <RouteProfile profile={entry.profile} size="lg" label={`Elevation profile of ${label}`} />
      </div>
      {entry.description && <p className="wo-description">{entry.description}</p>}
      <dl className="rt-facts">
        <div>
          <dt>Distance</dt>
          <dd>{formatKm(entry.totalDistanceM)}</dd>
        </div>
        <div>
          <dt>Climbing</dt>
          <dd>{formatClimb(entry.ascentM)}</dd>
        </div>
        <div>
          <dt>Descending</dt>
          <dd>{formatClimb(entry.descentM)}</dd>
        </div>
        {steepest !== null && (
          <div title="Steepest 200 m, from the route's profile">
            <dt>Steepest 200 m</dt>
            <dd data-testid="route-steepest">≈ {formatGradient(steepest)}</dd>
          </div>
        )}
        <div>
          <dt>Kind</dt>
          <dd>{entry.loop ? 'Loop — ride as many laps as you like' : 'Point to point'}</dd>
        </div>
      </dl>
      <div className="button-row wo-file-actions">
        <button type="button" className="btn btn-small" data-testid="route-export" onClick={save}>
          Save as GPX file
        </button>
        {sharing &&
          (sharingId === entry.id ? (
            <button
              type="button"
              className="btn btn-small"
              data-testid="route-share-stop"
              onClick={() => sharing.stop()}
            >
              Stop sharing
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              data-testid="route-share"
              onClick={() => sharing.share(entry.id)}
            >
              Share with group
            </button>
          ))}
        {entry.source === 'imported' && <DeleteRoute id={entry.id} actions={actions} />}
      </div>
    </div>
  );
}

function SelectRoute({
  entry,
  selected,
  locked,
  lockNoteId,
  actions,
  onGoToRide,
  onSelect,
}: {
  entry: RouteEntry;
  selected: boolean;
  locked: boolean;
  lockNoteId: string;
  actions: RouteActions;
  onGoToRide: () => void;
  onSelect?: () => void;
}) {
  if (selected) {
    return (
      <div className="button-row wo-selected-actions">
        <span className="wo-selected-tag" data-testid="route-selected">
          <span aria-hidden="true">✓</span> Selected for next ride
        </span>
        <button
          type="button"
          className="btn btn-small btn-primary"
          data-testid="route-go-ride"
          onClick={onGoToRide}
        >
          Go to ride
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="route-clear"
          disabled={locked}
          aria-describedby={locked ? lockNoteId : undefined}
          onClick={() => actions.select(null)}
        >
          Clear
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-small"
      data-testid="route-select"
      aria-label={`Select ${entry.name} for the next ride`}
      disabled={locked}
      aria-describedby={locked ? lockNoteId : undefined}
      onClick={() => (onSelect ? onSelect() : actions.select(entry.id))}
    >
      Select
    </button>
  );
}

function RouteRow({
  entry,
  locked,
  lockNoteId,
  actions,
  sharing,
  onGoToRide,
}: {
  entry: RouteEntry;
  locked: boolean;
  lockNoteId: string;
  actions: RouteActions;
  sharing: RouteSharing | null;
  onGoToRide: () => void;
}) {
  const selected = useAppState((s) => selectedRouteIdOf(s) === entry.id);
  const shared = useAppState((s) => sharingRouteIdOf(s) === entry.id);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <li
      className={`wo-row route-row${selected ? ' is-selected' : ''}`}
      data-testid="route-row"
      data-route-id={entry.id}
      data-selected={selected || undefined}
    >
      <div className="wo-info">
        <h3 className="wo-name">
          {entry.name}
          {shared && <span className="tag tag-accent">Sharing</span>}
        </h3>
        {entry.description && <p className="wo-desc">{entry.description}</p>}
        <p className="wo-meta" data-testid="route-summary">
          {routeSummary(entry)}
        </p>
      </div>
      <div className="wo-preview">
        <RouteThumbs entry={entry} />
      </div>
      <div className="wo-actions">
        <SelectRoute
          entry={entry}
          selected={selected}
          locked={locked}
          lockNoteId={lockNoteId}
          actions={actions}
          onGoToRide={onGoToRide}
        />
        <button
          type="button"
          className="btn btn-small btn-quiet wo-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          data-testid="route-details-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>
      {open && <RouteDetails entry={entry} id={detailsId} actions={actions} sharing={sharing} />}
    </li>
  );
}

function SharedRouteRow({
  shared,
  locked,
  lockNoteId,
  actions,
  adopt,
  onGoToRide,
}: {
  shared: SharedRoute;
  locked: boolean;
  lockNoteId: string;
  actions: RouteActions;
  adopt: (peerId: string) => void;
  onGoToRide: () => void;
}) {
  const { entry } = shared;
  const selected = useAppState((s) => selectedRouteIdOf(s) === entry.id);
  return (
    <li
      className={`wo-row route-row${selected ? ' is-selected' : ''}`}
      data-testid="shared-route-row"
      data-route-id={entry.id}
    >
      <div className="wo-info">
        <h3 className="wo-name">{entry.name}</h3>
        <p className="wo-desc">{`Shared by ${shared.peerName}`}</p>
        <p className="wo-meta">{routeSummary(entry)}</p>
      </div>
      <div className="wo-preview">
        <RouteThumbs entry={entry} />
      </div>
      <div className="wo-actions">
        {selected ? (
          <SelectRoute
            entry={entry}
            selected
            locked={locked}
            lockNoteId={lockNoteId}
            actions={actions}
            onGoToRide={onGoToRide}
          />
        ) : (
          <button
            type="button"
            className="btn btn-small"
            data-testid="shared-route-use"
            disabled={locked}
            aria-describedby={locked ? lockNoteId : undefined}
            onClick={() => adopt(shared.peerId)}
          >
            Use this route
          </button>
        )}
      </div>
    </li>
  );
}

// ───────────── import ─────────────

function ImportResults({ results, onClear }: { results: ImportOutcome[]; onClear: () => void }) {
  return (
    <div
      className="card wo-import-results"
      role="status"
      aria-live="polite"
      data-testid="route-import-results"
    >
      <ul className="list">
        {results.map((r) => (
          <li
            key={r.key}
            className={`wo-import-result ${r.ok ? 'is-ok' : 'is-error'}`}
            data-testid="route-import-result"
            data-ok={r.ok}
          >
            <span className="wo-import-mark" aria-hidden="true">
              {r.ok ? '✓' : '!'}
            </span>
            <div className="wo-import-text">
              <p>
                <strong>{r.fileName}</strong>
                {r.ok ? ` — imported as “${r.name ?? ''}”.` : ' — could not be imported.'}
              </p>
              {r.messages.length > 0 && (
                <ul className="wo-import-messages">
                  {r.messages.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="button-row end wo-import-foot">
        <button type="button" className="btn btn-small btn-quiet" onClick={onClear}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Reads and imports files one by one; one outcome per file. */
export async function importRouteFiles(
  actions: RouteActions,
  files: readonly File[],
  nextKey: () => number,
): Promise<ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  for (const file of files) {
    const base = { key: nextKey(), fileName: file.name || 'Unnamed file' };
    if (file.size > MAX_ROUTE_IMPORT_BYTES) {
      out.push({
        ...base,
        ok: false,
        messages: [
          'The file is larger than 20 MB; even long routes are much smaller. It was not read.',
        ],
      });
      continue;
    }
    try {
      const text = await file.text();
      const result = await actions.importRoute(text, file.name);
      if (result.ok) {
        out.push({
          ...base,
          ok: true,
          name: result.entry.name,
          messages: result.warnings.map((w) => `Note: ${w}`),
        });
      } else {
        out.push({
          ...base,
          ok: false,
          messages: result.errors.length > 0 ? result.errors : ['This is not a GPX route.'],
        });
      }
    } catch (err) {
      out.push({
        ...base,
        ok: false,
        messages: [
          `The file could not be read (${err instanceof Error ? err.message : String(err)}).`,
        ],
      });
    }
  }
  return out;
}

// ───────────── tab ─────────────

export interface RoutesTabProps {
  onGoToRide: () => void;
}

export function RoutesTab({ onGoToRide }: RoutesTabProps) {
  const app = useApp();
  const available = useAppState(hasRouteState);
  const routes = useAppState(routesOf);
  const sharedRoutes = useAppState(sharedRoutesOf);
  const locked = useAppState((s) => (s.live?.ride.state ?? 'idle') !== 'idle');
  const inGroup = useAppState((s) => s.group.phase === 'joined');
  const actions = useMemo(() => routeActions(app), [app]);
  const sharingApi = useMemo(() => routeSharing(app), [app]);
  const sharing = inGroup ? sharingApi : null;
  const lockNoteId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<ImportOutcome[]>([]);
  const key = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  if (!available || !actions) {
    return (
      <div className="page routes">
        <h2 className="page-title">Routes</h2>
        <div className="card empty" data-testid="routes-unavailable">
          <p className="empty-title">Routes are not available in this build</p>
          <p className="empty-text">Free rides and workouts work as usual.</p>
        </div>
      </div>
    );
  }

  const importFiles = async (files: readonly File[]): Promise<void> => {
    const out = await importRouteFiles(actions, files, () => ++key.current);
    if (out.length > 0) setResults(out);
  };

  const hasFiles = (e: DragEvent): boolean => [...e.dataTransfer.types].includes('Files');
  const dropProps = {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void importFiles([...e.dataTransfer.files]);
    },
  };

  const builtin = routes.filter((r) => r.source === 'builtin');
  const mine = routes.filter((r) => r.source === 'imported');
  const rowProps = { locked, lockNoteId, actions, sharing, onGoToRide };

  return (
    <div className={`page routes workouts${dragging ? ' is-dragging' : ''}`} {...dropProps}>
      <div className="wo-head">
        <h2 className="page-title">Routes</h2>
        <div className="wo-import">
          <input
            ref={fileInput}
            type="file"
            accept=".gpx,application/gpx+xml"
            multiple
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="route-import"
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = '';
              void importFiles(files);
            }}
          />
          <button
            type="button"
            className="btn"
            data-testid="route-import-button"
            title="GPX files; you can also drop them on this page"
            onClick={() => fileInput.current?.click()}
          >
            Import GPX…
          </button>
        </div>
        <p className="wo-ftp" data-testid="routes-intro">
          Ride a real road: the gradient follows the route and the scene shows the bends and hills
          ahead. GPX files come from your own recorded rides (most bike computers and ride-logging
          apps can export them) or from route planners.
        </p>
      </div>

      {results.length > 0 && <ImportResults results={results} onClear={() => setResults([])} />}

      {locked && (
        <p className="banner banner-info" id={lockNoteId} data-testid="routes-locked">
          A ride is in progress. Finish it to choose a different route.
        </p>
      )}

      <section aria-labelledby="rt-builtin-title" className="wo-section">
        <div className="section-head">
          <h2 id="rt-builtin-title" className="section-title">
            Built-in routes
          </h2>
          <span className="hint">Made-up roads to try the feature.</span>
        </div>
        {builtin.length === 0 ? (
          <p className="card wo-empty-line">No built-in routes in this build.</p>
        ) : (
          <ul className="list card wo-list">
            {builtin.map((e) => (
              <RouteRow key={e.id} entry={e} {...rowProps} />
            ))}
          </ul>
        )}
      </section>

      {sharing && (
        <section
          aria-labelledby="rt-shared-title"
          className="wo-section"
          data-testid="routes-shared"
        >
          <div className="section-head">
            <h2 id="rt-shared-title" className="section-title">
              Shared by the group
            </h2>
            <span className="hint">Ride the same road together.</span>
          </div>
          {sharedRoutes.length === 0 ? (
            <p className="card wo-empty-line">
              Nobody in the group is sharing a route. Open a route's details to share one.
            </p>
          ) : (
            <ul className="list card wo-list">
              {sharedRoutes.map((s) => (
                <SharedRouteRow
                  key={s.peerId}
                  shared={s}
                  locked={locked}
                  lockNoteId={lockNoteId}
                  actions={actions}
                  adopt={sharing.adopt}
                  onGoToRide={onGoToRide}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="rt-mine-title" className="wo-section" data-testid="routes-mine">
        <div className="section-head">
          <h2 id="rt-mine-title" className="section-title">
            My routes
          </h2>
          <span className="hint">
            {mine.length > 0 ? `${mine.length} imported · ` : ''}Drop .gpx files anywhere on this
            page to import
          </span>
        </div>
        {mine.length === 0 ? (
          <div className="card empty wo-empty">
            <p className="empty-title">No imported routes yet</p>
            <p className="empty-text">
              Import a GPX file with a track or a route. Without elevation in the file the route is
              ridden flat; the bends still show.
            </p>
          </div>
        ) : (
          <ul className="list card wo-list">
            {mine.map((e) => (
              <RouteRow key={e.id} entry={e} {...rowProps} />
            ))}
          </ul>
        )}
      </section>

      {dragging && (
        <div className="wo-drop" aria-hidden="true">
          <span>Drop GPX files to import</span>
        </div>
      )}
    </div>
  );
}
