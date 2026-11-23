import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { Workout } from '@freilauf/workouts';
import { workoutStats } from '@freilauf/workouts';
import type { SharedWorkout } from '../appStore';
import type { WorkoutEntry } from '../../core/workoutLibrary';
import { downloadText } from './download';
import { workoutSharing } from './groupShare';
import { useApp, useAppState } from './hooks';
import { WorkoutChart } from './WorkoutChart';
import {
  chartSummary,
  formatApproxDuration,
  formatStepDuration,
  openEndedHorizonS,
  stepRows,
  uniqueEntries,
  zoneRows,
} from './workoutView';

/** Files above this are rejected before they are read. */
export const MAX_IMPORT_BYTES = 1024 * 1024;

const FTP_TEST_TEXT: Record<'twentyMinute' | 'ramp', { how: string; result: string }> = {
  twentyMinute: {
    how: 'After a warm-up with a few short efforts you ride 20 minutes as hard as you can sustain. For those 20 minutes the trainer is in free-ride mode: no target, you pace yourself with the gears.',
    result: 'Your FTP is 95 % of your 20-minute average power. About an hour in total.',
  },
  ramp: {
    how: 'After 5 minutes of warm-up the trainer holds a target that rises every minute. Keep pedalling until you cannot hold it any more — the test then ends by itself.',
    result:
      'Your FTP is 75 % of your best one-minute power. Usually about 20 minutes; the ramp adapts to your current FTP.',
  },
};

interface ImportOutcome {
  key: number;
  fileName: string;
  ok: boolean;
  /** Workout name on success. */
  name?: string;
  messages: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ───────────── stats ─────────────

function StatsLine({
  workout,
  ftpW,
  openEnded,
}: {
  workout: Workout;
  ftpW: number;
  openEnded: boolean;
}) {
  const stats = useMemo(() => workoutStats(workout, ftpW), [workout, ftpW]);
  if (openEnded) {
    return (
      <p className="wo-meta">
        <span className="wo-meta-strong">Open-ended</span>
        <span>usually about 20 min, no load estimate — it depends on how far you get</span>
      </p>
    );
  }
  return (
    <p className="wo-meta">
      <span className="wo-meta-strong">{formatStepDuration(stats.durationS)}</span>
      <span title="Estimated from the plan at your FTP">
        <span className="visually-hidden">Estimated </span>
        {`avg ≈ ${Math.round(stats.averagePowerW)} W`}
      </span>
      <span title="Estimated normalised power">
        <span className="visually-hidden">Estimated </span>
        {`NP ≈ ${Math.round(stats.normalizedPowerW)} W`}
      </span>
      <span title="Estimated intensity factor">
        <span className="visually-hidden">Estimated </span>
        {`IF ≈ ${stats.intensityFactor.toFixed(2)}`}
      </span>
      <span title="Estimated training stress score">
        <span className="visually-hidden">Estimated </span>
        {`TSS ≈ ${Math.round(stats.tss)}`}
      </span>
    </p>
  );
}

// ───────────── details ─────────────

function ZoneBars({ workout, ftpW }: { workout: Workout; ftpW: number }) {
  const rows = useMemo(() => zoneRows(workoutStats(workout, ftpW)), [workout, ftpW]);
  return (
    <ul className="list wo-zones" aria-label="Time in power zones">
      {rows.map((z) => (
        <li key={z.zone} className="wo-zone">
          <span
            className={`wo-swatch ${z.zone === 0 ? 'wo-swatch-free' : `wo-z${z.zone}`}`}
            aria-hidden="true"
          />
          <span className="wo-zone-name">{z.zone === 0 ? z.name : `Z${z.zone} ${z.name}`}</span>
          <span className="wo-zone-bar" aria-hidden="true">
            <span
              className={z.zone === 0 ? 'wo-swatch-free' : `wo-z${z.zone}`}
              style={{ width: `${Math.max(2, Math.round(z.share * 100))}%` }}
            />
          </span>
          <span className="wo-zone-time">{formatApproxDuration(z.seconds)}</span>
        </li>
      ))}
    </ul>
  );
}

function DeleteButton({ id }: { id: string }) {
  const app = useApp();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-small btn-danger"
        data-testid="workout-delete"
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    );
  }
  return (
    <span className="button-row" role="group" aria-label="Delete workout?">
      <span className="confirm-label">Delete this workout?</span>
      <button
        type="button"
        className="btn btn-small btn-danger-solid"
        data-testid="workout-delete-confirm"
        onClick={() => {
          setConfirming(false);
          app.deleteWorkout(id);
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

function WorkoutDetails({
  entry,
  ftpW,
  id,
  canShare,
}: {
  entry: WorkoutEntry;
  ftpW: number;
  id: string;
  canShare: boolean;
}) {
  const app = useApp();
  const { workout } = entry;
  const openEnded = entry.ftpTest?.openEnded === true;
  const sharingId = useAppState((s) => s.sharingWorkoutId);
  const sharing = useMemo(() => (canShare ? workoutSharing(app) : null), [app, canShare]);
  const rows = useMemo(() => stepRows(workout, ftpW), [workout, ftpW]);
  const horizonS = useMemo(
    () => (openEnded ? openEndedHorizonS(workout) : undefined),
    [workout, openEnded],
  );
  const label = useMemo(
    () => chartSummary(workout, workoutStats(workout, ftpW), openEnded),
    [workout, ftpW, openEnded],
  );
  const save = (format: 'freilauf' | 'zwo'): void => {
    const file = app.exportWorkout(workout.id, format);
    if (!file) {
      app.notify('error', 'This workout could not be exported.');
      return;
    }
    downloadText(
      file.fileName,
      file.text,
      format === 'zwo' ? 'application/xml' : 'application/json',
    );
  };
  return (
    <div className="wo-details" id={id} data-testid="workout-details">
      <WorkoutChart workout={workout} label={label} size="lg" horizonS={horizonS} />
      {/* The row shows a one-line description; repeat it here only when it is cut off there. */}
      {workout.description &&
        (entry.ftpTest ||
          workout.description.length > 90 ||
          workout.description.includes('\n')) && (
          <p className="wo-description">{workout.description}</p>
        )}
      <div className="wo-details-grid">
        <div>
          <h4 className="wo-subhead">Steps</h4>
          <div className="wo-steps-scroll">
            <table className="wo-steps">
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Target</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.label}</td>
                    <td className="wo-nowrap">{r.duration}</td>
                    <td>{r.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {!openEnded && (
          <div>
            <h4 className="wo-subhead">Time in zones</h4>
            <ZoneBars workout={workout} ftpW={ftpW} />
          </div>
        )}
      </div>
      <div className="button-row wo-file-actions">
        <button
          type="button"
          className="btn btn-small"
          data-testid="workout-export-zwo"
          onClick={() => save('zwo')}
        >
          Save as .zwo file
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="workout-export-freilauf"
          onClick={() => save('freilauf')}
        >
          Save as Freilauf file
        </button>
        {sharing &&
          (sharingId === workout.id ? (
            <button
              type="button"
              className="btn btn-small"
              data-testid="workout-share-stop"
              onClick={() => sharing.stop()}
            >
              Stop sharing
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              data-testid="workout-share"
              onClick={() => sharing.share(workout.id)}
            >
              Share with group
            </button>
          ))}
        {entry.source === 'imported' && <DeleteButton id={workout.id} />}
      </div>
    </div>
  );
}

// ───────────── rows ─────────────

function SelectControls({
  id,
  name,
  selected,
  locked,
  lockNoteId,
  onGoToRide,
  onSelect,
}: {
  id: string;
  name: string;
  selected: boolean;
  locked: boolean;
  lockNoteId: string;
  onGoToRide: () => void;
  onSelect?: () => void;
}) {
  const app = useApp();
  if (selected) {
    return (
      <div className="button-row wo-selected-actions">
        <span className="wo-selected-tag" data-testid="workout-selected">
          <span aria-hidden="true">✓</span> Selected for next ride
        </span>
        <button
          type="button"
          className="btn btn-small btn-primary"
          data-testid="workout-go-ride"
          onClick={onGoToRide}
        >
          Go to ride
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="workout-clear"
          disabled={locked}
          aria-describedby={locked ? lockNoteId : undefined}
          onClick={() => app.selectWorkout(null)}
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
      data-testid="workout-select"
      aria-label={`Select ${name} for the next ride`}
      disabled={locked}
      aria-describedby={locked ? lockNoteId : undefined}
      onClick={() => (onSelect ? onSelect() : app.selectWorkout(id))}
    >
      Select
    </button>
  );
}

function WorkoutRow({
  entry,
  ftpW,
  locked,
  lockNoteId,
  canShare,
  onGoToRide,
}: {
  entry: WorkoutEntry;
  ftpW: number;
  locked: boolean;
  lockNoteId: string;
  canShare: boolean;
  onGoToRide: () => void;
}) {
  const { workout } = entry;
  const selected = useAppState((s) => s.selectedWorkoutId === workout.id);
  const shared = useAppState((s) => s.sharingWorkoutId === workout.id);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const openEnded = entry.ftpTest?.openEnded === true;
  const horizonS = useMemo(
    () => (openEnded ? openEndedHorizonS(workout) : undefined),
    [workout, openEnded],
  );
  const label = useMemo(
    () => chartSummary(workout, workoutStats(workout, ftpW), openEnded),
    [workout, ftpW, openEnded],
  );
  const explain = entry.ftpTest ? FTP_TEST_TEXT[entry.ftpTest.kind] : null;

  return (
    <li
      className={`wo-row${selected ? ' is-selected' : ''}`}
      data-testid="workout-row"
      data-workout-id={workout.id}
      data-selected={selected || undefined}
    >
      <div className="wo-info">
        <h3 className="wo-name">
          {workout.name}
          {shared && <span className="tag tag-accent">Sharing</span>}
        </h3>
        {explain ? (
          <div className="wo-explain">
            <p>{explain.how}</p>
            <p>
              <strong>Result:</strong> {explain.result}
            </p>
          </div>
        ) : (
          workout.description && <p className="wo-desc">{workout.description}</p>
        )}
        <StatsLine workout={workout} ftpW={ftpW} openEnded={openEnded} />
      </div>
      <div className="wo-preview">
        <WorkoutChart workout={workout} label={label} horizonS={horizonS} />
      </div>
      <div className="wo-actions">
        <SelectControls
          id={workout.id}
          name={workout.name}
          selected={selected}
          locked={locked}
          lockNoteId={lockNoteId}
          onGoToRide={onGoToRide}
        />
        <button
          type="button"
          className="btn btn-small btn-quiet wo-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          data-testid="workout-details-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>
      {open && <WorkoutDetails entry={entry} ftpW={ftpW} id={detailsId} canShare={canShare} />}
    </li>
  );
}

function SharedRow({
  shared,
  ftpW,
  locked,
  lockNoteId,
  onGoToRide,
  adopt,
}: {
  shared: SharedWorkout;
  ftpW: number;
  locked: boolean;
  lockNoteId: string;
  onGoToRide: () => void;
  adopt: (peerId: string) => void;
}) {
  const { workout } = shared;
  const selected = useAppState((s) => s.selectedWorkoutId === workout.id);
  const label = useMemo(() => chartSummary(workout, workoutStats(workout, ftpW)), [workout, ftpW]);
  return (
    <li
      className={`wo-row${selected ? ' is-selected' : ''}`}
      data-testid="shared-workout-row"
      data-workout-id={workout.id}
    >
      <div className="wo-info">
        <h3 className="wo-name">{workout.name}</h3>
        <p className="wo-desc">{`Shared by ${shared.peerName}`}</p>
        <StatsLine workout={workout} ftpW={ftpW} openEnded={false} />
      </div>
      <div className="wo-preview">
        <WorkoutChart workout={workout} label={label} />
      </div>
      <div className="wo-actions">
        {selected ? (
          <SelectControls
            id={workout.id}
            name={workout.name}
            selected
            locked={locked}
            lockNoteId={lockNoteId}
            onGoToRide={onGoToRide}
          />
        ) : (
          <button
            type="button"
            className="btn btn-small"
            data-testid="shared-workout-use"
            disabled={locked}
            aria-describedby={locked ? lockNoteId : undefined}
            onClick={() => adopt(shared.peerId)}
          >
            Use this workout
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
      data-testid="workout-import-results"
    >
      <ul className="list">
        {results.map((r) => (
          <li
            key={r.key}
            className={`wo-import-result ${r.ok ? 'is-ok' : 'is-error'}`}
            data-testid="workout-import-result"
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

function useImporter() {
  const app = useApp();
  const [results, setResults] = useState<ImportOutcome[]>([]);
  const key = useRef(0);

  const importFiles = async (files: readonly File[]): Promise<void> => {
    const out: ImportOutcome[] = [];
    for (const file of files) {
      const base = { key: ++key.current, fileName: file.name || 'Unnamed file' };
      if (file.size > MAX_IMPORT_BYTES) {
        out.push({
          ...base,
          ok: false,
          messages: ['The file is larger than 1 MB; workout files are much smaller.'],
        });
        continue;
      }
      try {
        const text = await file.text();
        const result = app.importWorkout(text);
        if (result.ok) {
          out.push({
            ...base,
            ok: true,
            name: result.workout.name,
            messages: result.warnings.map((w) => `Note: ${w}`),
          });
        } else {
          out.push({
            ...base,
            ok: false,
            messages: result.errors.length > 0 ? result.errors : ['Not a workout file.'],
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
    if (out.length > 0) setResults(out);
  };

  return { results, clear: () => setResults([]), importFiles };
}

// ───────────── tab ─────────────

export interface WorkoutsTabProps {
  onGoToRide: () => void;
  onOpenSettings: () => void;
  /** Scroll to the FTP tests when the tab opens. */
  focusFtpTests?: boolean;
}

export function WorkoutsTab({ onGoToRide, onOpenSettings, focusFtpTests }: WorkoutsTabProps) {
  const app = useApp();
  const workouts = useAppState((s) => s.workouts);
  const ftpW = useAppState((s) => s.settings?.rider.ftpW ?? 200);
  const locked = useAppState((s) => (s.live?.ride.state ?? 'idle') !== 'idle');
  const inGroup = useAppState((s) => s.group.phase === 'joined');
  const sharedWorkouts = useAppState((s) => s.sharedWorkouts);
  const sharing = useMemo(() => workoutSharing(app), [app]);
  const canShare = inGroup && sharing !== null;
  const lockNoteId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const ftpSection = useRef<HTMLElement>(null);
  const { results, clear, importFiles } = useImporter();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (focusFtpTests) ftpSection.current?.scrollIntoView({ block: 'start' });
  }, [focusFtpTests]);

  const entries = useMemo(() => uniqueEntries(workouts), [workouts]);
  const tests = entries.filter((e) => e.source === 'ftpTest');
  const library = entries.filter((e) => e.source === 'builtin');
  const mine = entries.filter((e) => e.source === 'imported');

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

  const rowProps = { ftpW, locked, lockNoteId, canShare, onGoToRide };

  return (
    <div className={`page workouts${dragging ? ' is-dragging' : ''}`} {...dropProps}>
      <div className="wo-head">
        <h2 className="page-title">Workouts</h2>
        <div className="wo-import">
          <input
            ref={fileInput}
            type="file"
            accept=".zwo,.json,.xml"
            multiple
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="workout-import"
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = '';
              void importFiles(files);
            }}
          />
          <button
            type="button"
            className="btn"
            data-testid="workout-import-button"
            title=".zwo workout files or Freilauf files; you can also drop them on this page"
            onClick={() => fileInput.current?.click()}
          >
            Import workouts…
          </button>
        </div>
        <p className="wo-ftp" data-testid="workouts-ftp">
          Your FTP: <strong>{`${ftpW} W`}</strong> — targets below are scaled to it.{' '}
          <button type="button" className="link" onClick={onOpenSettings}>
            Change in Settings
          </button>{' '}
          ·{' '}
          <button
            type="button"
            className="link"
            onClick={() =>
              ftpSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            Not sure? Take an FTP test
          </button>
        </p>
      </div>

      {results.length > 0 && <ImportResults results={results} onClear={clear} />}

      {locked && (
        <p className="banner banner-info" id={lockNoteId} data-testid="workouts-locked">
          A ride is in progress. Finish it to choose a different workout.
        </p>
      )}

      <section
        aria-labelledby="wo-tests-title"
        ref={ftpSection}
        id="ftp-tests"
        className="wo-section"
      >
        <div className="section-head">
          <h2 id="wo-tests-title" className="section-title">
            FTP tests
          </h2>
          <span className="hint">Measure your FTP; ride rested and at 100 % intensity.</span>
        </div>
        <ul className="list card wo-list">
          {tests.map((e) => (
            <WorkoutRow key={e.workout.id} entry={e} {...rowProps} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="wo-library-title" className="wo-section">
        <div className="section-head">
          <h2 id="wo-library-title" className="section-title">
            Library
          </h2>
          <span className="hint">≈ values are estimates from the plan at your FTP.</span>
        </div>
        <ul className="list card wo-list">
          {library.map((e) => (
            <WorkoutRow key={e.workout.id} entry={e} {...rowProps} />
          ))}
        </ul>
      </section>

      {canShare && sharing && (
        <section
          aria-labelledby="wo-shared-title"
          className="wo-section"
          data-testid="workouts-shared"
        >
          <div className="section-head">
            <h2 id="wo-shared-title" className="section-title">
              Shared by the group
            </h2>
            <span className="hint">Each rider's targets follow their own FTP.</span>
          </div>
          {sharedWorkouts.length === 0 ? (
            <p className="card wo-empty-line">
              Nobody in the group is sharing a workout. Open a workout's details to share one.
            </p>
          ) : (
            <ul className="list card wo-list">
              {sharedWorkouts.map((s) => (
                <SharedRow
                  key={s.peerId}
                  shared={s}
                  ftpW={ftpW}
                  locked={locked}
                  lockNoteId={lockNoteId}
                  onGoToRide={onGoToRide}
                  adopt={sharing.adopt}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="wo-mine-title" className="wo-section" data-testid="workouts-mine">
        <div className="section-head">
          <h2 id="wo-mine-title" className="section-title">
            My workouts
          </h2>
          <span className="hint">
            {mine.length > 0 ? `${plural(mine.length, 'imported workout')} · ` : ''}Drop .zwo or
            Freilauf files anywhere on this page to import
          </span>
        </div>
        {mine.length === 0 ? (
          <div className="card empty wo-empty">
            <p className="empty-title">No imported workouts yet</p>
            <p className="empty-text">
              Import .zwo workout files from other training tools, or Freilauf files a friend sent
              you. Drag them onto this page or use Import.
            </p>
          </div>
        ) : (
          <ul className="list card wo-list">
            {mine.map((e) => (
              <WorkoutRow key={e.workout.id} entry={e} {...rowProps} />
            ))}
          </ul>
        )}
      </section>

      {dragging && (
        <div className="wo-drop" aria-hidden="true">
          <span>Drop workout files to import</span>
        </div>
      )}
    </div>
  );
}
