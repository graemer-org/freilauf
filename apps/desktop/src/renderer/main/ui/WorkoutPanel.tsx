import { useMemo } from 'react';
import type { Workout } from '@freilauf/workouts';
import { workoutStats } from '@freilauf/workouts';
import { aheadCue, episodeProgress } from './episodeView';
import { formatDuration } from './format';
import { startTogetherAction } from './groupShare';
import { useApp, useAppState } from './hooks';
import { WorkoutChart } from './WorkoutChart';
import {
  chartProgress,
  chartSummary,
  classifyDeviation,
  deviationPosition,
  formatPercent,
  formatStepDuration,
  modeText,
  nextText,
  nudgeIntensity,
  openEndedHorizonS,
} from './workoutView';

/** The Workout behind the running/selected one (library or shared by the group). */
function useWorkoutById(id: string | null): Workout | null {
  const fromLibrary = useAppState((s) =>
    id === null ? null : (s.workouts.find((e) => e.workout.id === id)?.workout ?? null),
  );
  const fromGroup = useAppState((s) =>
    id === null ? null : (s.sharedWorkouts.find((w) => w.workout.id === id)?.workout ?? null),
  );
  // An episode workout (re-fitted by "hard now" during the ride).
  const episode = useAppState((s) =>
    id !== null && s.episodePlan?.workout.id === id ? s.episodePlan.workout : null,
  );
  return episode ?? fromLibrary ?? fromGroup;
}

/** Shown before the ride starts: what is selected, with Clear. */
export function WorkoutBanner() {
  const app = useApp();
  const name = useAppState((s) => s.live?.workout?.name ?? null);
  const totalS = useAppState((s) => s.live?.workout?.totalDurationS ?? 0);
  const ftpTest = useAppState((s) => s.live?.workout?.ftpTest);
  const rideIdle = useAppState((s) => s.live?.ride.state === 'idle');
  const inGroup = useAppState((s) => s.group.phase === 'joined');
  // No "Start together" while any countdown runs (a group's or the local one before Start).
  const countdown = useAppState((s) => s.live?.countdown ?? null);
  const startTogether = useMemo(() => startTogetherAction(app), [app]);
  if (name === null) return null;
  return (
    <div className="wo-banner" data-testid="workout-banner">
      <p className="wo-banner-text">
        <span className="wo-banner-label">Next ride</span> <strong>{name}</strong>
        <span className="wo-banner-sep" aria-hidden="true">
          {' · '}
        </span>
        <span className="visually-hidden">, </span>
        {ftpTest === 'ramp' ? 'open-ended' : formatStepDuration(totalS)}
      </p>
      <div className="button-row">
        {inGroup && startTogether && rideIdle && countdown === null && (
          <button
            type="button"
            className="btn btn-small btn-primary"
            data-testid="workout-start-together"
            onClick={() => startTogether(10)}
          >
            Start together in 10 s
          </button>
        )}
        <button
          type="button"
          className="btn btn-small"
          data-testid="workout-banner-clear"
          onClick={() => app.selectWorkout(null)}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function DeviationBar({ targetW }: { targetW: number }) {
  const actualW = useAppState((s) => s.live?.ride.power3sW ?? 0);
  const d = classifyDeviation(actualW, targetW);
  const pos = deviationPosition(d.ratio);
  const left = Math.min(50, pos);
  const width = Math.abs(pos - 50);
  return (
    <div
      className={`wo-dev wo-dev-${d.level}`}
      data-level={d.level}
      data-testid="workout-deviation"
    >
      <span className="wo-dev-track" aria-hidden="true">
        <span className="wo-dev-zone" />
        <span className="wo-dev-fill" style={{ left: `${left}%`, width: `${width}%` }} />
        <span className="wo-dev-mark" style={{ left: `${pos}%` }} />
      </span>
      <span className="wo-dev-text">
        {d.direction === 'over' && <span aria-hidden="true">▲ </span>}
        {d.direction === 'under' && <span aria-hidden="true">▼ </span>}
        {d.text}
      </span>
    </div>
  );
}

function IntensityControl({ intensity, disabled }: { intensity: number; disabled: boolean }) {
  const app = useApp();
  return (
    <div
      className="control wo-intensity"
      role="group"
      aria-label="Intensity"
      data-testid="workout-intensity"
    >
      <span className="control-label">
        Intensity <output data-testid="workout-intensity-value">{formatPercent(intensity)}</output>
      </span>
      <div className="stepper">
        <button
          type="button"
          className="btn btn-icon"
          data-testid="workout-intensity-down"
          aria-label="Intensity down 5 %"
          disabled={disabled || intensity <= 0.5}
          onClick={() => app.setWorkoutIntensity(nudgeIntensity(intensity, -1))}
        >
          −
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="workout-intensity-up"
          aria-label="Intensity up 5 %"
          disabled={disabled || intensity >= 1.5}
          onClick={() => app.setWorkoutIntensity(nudgeIntensity(intensity, 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** The running workout: step, target vs actual, countdowns, profile and controls. */
export function WorkoutPanel() {
  const app = useApp();
  const w = useAppState((s) => s.live?.workout ?? null);
  const ftpW = useAppState((s) => s.settings?.rider.ftpW ?? 200);
  const workout = useWorkoutById(w?.id ?? null);
  const openEnded = w?.ftpTest === 'ramp';
  const horizonS = useMemo(
    () => (workout && openEnded ? openEndedHorizonS(workout) : undefined),
    [workout, openEnded],
  );
  const chartLabel = useMemo(
    () => (workout ? chartSummary(workout, workoutStats(workout, ftpW), openEnded) : ''),
    [workout, ftpW, openEnded],
  );
  if (!w || !w.started) return null;

  const erg = w.mode === 'erg' && !w.finished && w.targetPowerW !== null;
  const ahead = aheadCue(w);
  const episode = w.episode;
  const episodeLine = episodeProgress(w);
  const progress = chartProgress(w.elapsedS, horizonS ?? w.totalDurationS);
  const mode = modeText(w);

  return (
    <section
      className={`card wo-panel${w.finished ? ' is-finished' : ''}`}
      data-testid="workout-panel"
      data-mode={w.finished ? 'finished' : w.mode}
      aria-label={`Workout: ${w.name}`}
    >
      <div className="wo-panel-top">
        <div className="wo-target" data-testid="workout-target">
          <span className="tile-label">
            Target{w.cadenceRpm !== undefined && erg ? ` · ${w.cadenceRpm} rpm` : ''}
          </span>
          {erg ? (
            <>
              <span className="wo-big">
                <span className="tile-number" data-testid="workout-target-value">
                  {Math.round(w.targetPowerW ?? 0)}
                </span>
                <span className="tile-unit">W</span>
              </span>
              <DeviationBar targetW={w.targetPowerW ?? 0} />
            </>
          ) : (
            <>
              <span className="wo-big wo-big-text">{w.finished ? 'Done' : 'Free ride'}</span>
              <span className="hint">
                {w.finished
                  ? 'No more targets'
                  : w.cadenceRpm !== undefined
                    ? `Cadence ${w.cadenceRpm} rpm`
                    : 'You set the pace'}
              </span>
            </>
          )}
        </div>

        <div className="wo-step">
          <span className="tile-label wo-name-line">{w.name}</span>
          <p className="wo-step-label" data-testid="workout-label">
            {w.label}
          </p>
          <p
            className={`wo-mode${w.mode === 'free' || w.finished ? ' is-strong' : ''}`}
            data-testid="workout-mode"
          >
            {mode}
          </p>
          <p className="wo-cue" aria-live="polite" data-testid="workout-cue">
            {w.cue ?? ''}
          </p>
          {episode && (
            <p
              className={`wo-ahead${episode.notice ? ` is-${episode.notice.tone}` : ''}`}
              data-testid="workout-ahead"
              aria-live="polite"
            >
              {episode.notice?.text ?? ahead ?? ''}
            </p>
          )}
        </div>

        <div className="wo-count">
          <span className="tile-label">{w.finished ? 'Workout time' : 'Step left'}</span>
          <span className="wo-big">
            <span className="tile-number" data-testid="workout-remaining">
              {formatDuration(w.finished ? w.elapsedS : w.segmentRemainingS)}
            </span>
          </span>
          <span className="hint" data-testid="workout-total-remaining">
            {w.finished
              ? 'All steps done'
              : openEnded
                ? `Test time ${formatDuration(w.elapsedS)}`
                : `Workout left ${formatDuration(w.totalRemainingS)}`}
          </span>
        </div>
      </div>

      <div className="wo-panel-bottom">
        <div className="wo-progress">
          {workout && (
            <WorkoutChart
              workout={workout}
              label={chartLabel}
              size="md"
              horizonS={horizonS}
              progress={progress}
              testId="workout-progress-chart"
            />
          )}
          {episodeLine && (
            <div className="wo-episode-line" data-testid="workout-episode-progress">
              <span className="wo-episode-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(episodeLine.progress * 1000) / 10}%` }} />
              </span>
              <span className="wo-episode-left">{`Episode · ${episodeLine.left}`}</span>
            </div>
          )}
          <p className="wo-next" data-testid="workout-next">
            {w.finished ? 'You are back in free-ride mode' : nextText(w.next)}
          </p>
        </div>
        <div className="wo-controls">
          <div className="button-row" role="group" aria-label="Step">
            <button
              type="button"
              className="btn btn-small"
              data-testid="workout-back"
              onClick={() => app.restartWorkoutSegment()}
            >
              Restart step
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="workout-skip"
              disabled={w.finished}
              onClick={() => app.skipWorkoutSegment()}
            >
              Skip step
            </button>
          </div>
          {episode && (
            <button
              type="button"
              className="btn btn-small wo-hard-now"
              data-testid="workout-hard-now"
              aria-keyshortcuts="H"
              aria-disabled={!episode.hardNow.available || undefined}
              title={
                episode.hardNow.available
                  ? `2 min at ${episode.hardNowTargetW} W, then easy; the rest is re-fitted (H)`
                  : episode.hardNow.reason
              }
              onClick={() => app.hardNow('ui')}
            >
              Hard now <span className="wo-hard-now-w">{`${episode.hardNowTargetW} W`}</span>
            </button>
          )}
          <IntensityControl intensity={w.intensity} disabled={w.finished} />
        </div>
      </div>
    </section>
  );
}
