import { useId, useRef, useState } from 'react';
import type { GhostChoice } from '../../../shared/contract';
import { NO_GHOST } from '../appStore';
import type { RideSummary } from '../appStore';
import { Toggle } from './fields';
import {
  NO_ROUTE_GHOST_NOTE,
  ghostChip,
  ghostHint,
  ghostOptions,
  ghostSummary,
  selectedGhostOption,
} from './ghostView';
import { useApp, useAppState } from './hooks';

/** Start screen, with a route chosen: which ghost to race (docs/ghost.md). */
export function GhostPicker({ locked }: { locked: boolean }) {
  const app = useApp();
  const id = useId();
  const g = useAppState((s) => s.ghost ?? NO_GHOST);
  const track = useAppState((s) => s.routeTrack);
  const enabled = useAppState((s) => s.settings?.ghost?.enabled !== false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!track || g.routeId === null) return null;
  const shape = { lengthM: track.totalDistanceM, loop: track.loop };
  const options = ghostOptions(g, shape);
  const main = options.filter((o) => o.group === 'main');
  const rides = options.filter((o) => o.group === 'rides');
  const selected = selectedGhostOption(g);
  const hasSource = g.candidates.length > 0 || g.imported !== null;
  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await app.importGhost(bytes, file.name);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  return (
    <div
      className="start-ghost"
      data-testid="start-ghost"
      data-active={g.active?.kind ?? 'none'}
      data-loading={g.loading || undefined}
    >
      <span className="start-choice-label" id={`${id}-label`}>
        Ghost
      </span>
      <div className="start-ghost-body">
        <div className="start-ghost-row">
          <label className="check-row start-ghost-switch">
            <input
              type="checkbox"
              role="switch"
              data-testid="ghost-enabled"
              checked={enabled}
              disabled={locked}
              onChange={(e) => void app.setGhostEnabled(e.currentTarget.checked)}
            />{' '}
            Race a ghost
          </label>
          {enabled && hasSource && (
            <select
              className="start-ghost-select"
              aria-labelledby={`${id}-label`}
              data-testid="ghost-source"
              value={selected}
              disabled={locked || g.loading}
              onChange={(e) => {
                const v = e.currentTarget.value as GhostChoice | 'import';
                if (v !== 'import') void app.chooseGhost(v);
              }}
            >
              {main
                .filter((o) => o.value !== 'none')
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              {rides.length > 0 && (
                <optgroup label="Pick an earlier ride">
                  {rides.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="none">No ghost</option>
            </select>
          )}
          {enabled && (
            <>
              <button
                type="button"
                className="link"
                data-testid="ghost-import-button"
                disabled={locked || busy}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? 'Reading…' : 'Import a ride file…'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".fit,application/vnd.ant.fit,application/octet-stream"
                hidden
                data-testid="ghost-import"
                onChange={(e) => void onFile(e.currentTarget.files?.[0])}
              />
            </>
          )}
        </div>
        <p
          className={g.error ? 'callout-warn start-ghost-hint' : 'hint start-ghost-hint'}
          data-testid="ghost-hint"
          role={g.error ? 'alert' : undefined}
        >
          {ghostHint(g, enabled)}
        </p>
      </div>
    </div>
  );
}

/** Free ride: one quiet line on why there is no ghost. */
export function NoRouteGhostNote() {
  return (
    <p className="hint" data-testid="start-ghost-none">
      {NO_ROUTE_GHOST_NOTE}
    </p>
  );
}

/** The gap chip on the ride scene (top left), in both views. */
export function GhostHud() {
  const g = useAppState((s) => s.live?.ghost ?? null);
  const elapsedS = useAppState((s) => s.live?.ride.elapsedS ?? 0);
  const chip = ghostChip(g, elapsedS);
  if (!chip || !g) return null;
  return (
    <div
      className={`ghost-chip is-${chip.tone}`}
      data-testid="ghost-chip"
      data-status={g.status}
      data-gap-m={g.gapM === null ? '' : g.gapM.toFixed(1)}
      data-gap-s={g.gapS === null ? '' : g.gapS.toFixed(2)}
      data-ahead-m={g.aheadM === null ? '' : g.aheadM.toFixed(1)}
      role="status"
    >
      <span className="ghost-chip-title">
        <GhostGlyph />
        {chip.title}
      </span>
      <span className="ghost-chip-gap" data-testid="ghost-gap">
        {chip.text}
      </span>
      {chip.split && (
        <span className="ghost-chip-split" data-testid="ghost-split">
          {chip.split}
        </span>
      )}
    </div>
  );
}

function GhostGlyph() {
  return (
    <svg className="ghost-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 14V7a5 5 0 0 1 10 0v7l-1.7-1.3L9.6 14 8 12.7 6.4 14l-1.7-1.3Z"
        fill="currentColor"
        opacity="0.5"
      />
      <circle cx="6.2" cy="7" r="0.9" fill="currentColor" />
      <circle cx="9.8" cy="7" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** Summary: the verdict against the ghost, splits, and a new best time. */
export function SummaryGhost({ summary }: { summary: RideSummary }) {
  const view = ghostSummary(summary);
  if (!view) return null;
  return (
    <section className="card summary-ghost" data-testid="summary-ghost" data-tone={view.tone}>
      {view.verdict && (
        <p className={`summary-ghost-verdict is-${view.tone}`} data-testid="summary-ghost-verdict">
          <GhostGlyph />
          <strong>{view.verdict}</strong>
          {view.against && <span className="hint">{`against ${view.against}`}</span>}
        </p>
      )}
      {view.splits.length > 0 && (
        <p className="hint summary-ghost-splits" data-testid="summary-ghost-splits">
          {view.splits.join('  ·  ')}
        </p>
      )}
      {view.best && (
        <p className="summary-ghost-best" data-testid="summary-best-time">
          {view.best}
        </p>
      )}
    </section>
  );
}

/** Settings → Ride: the ghost switch. */
export function GhostSettingsToggle() {
  const app = useApp();
  const enabled = useAppState((s) => s.settings?.ghost?.enabled !== false);
  return (
    <Toggle
      label="Ghost rider"
      testId="settings-ghost-enabled"
      checked={enabled}
      hint="On a route, race an earlier ride of it: your best time, your last ride, any ride you pick, or a ride file. Only the screen shows it; nothing about your ride changes."
      onChange={(on) => void app.setGhostEnabled(on)}
    />
  );
}
