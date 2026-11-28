import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { EpisodeEffort, EpisodeOptions, EpisodePattern } from '@freilauf/workouts';
import {
  EPISODE_EFFORTS,
  EPISODE_MAX_LENGTH_MIN,
  EPISODE_MIN_LENGTH_MIN,
  EPISODE_PATTERNS,
  EPISODE_PRESETS_MIN,
  generateEpisodeWorkout,
  normalizeEpisodeOptions,
} from '@freilauf/workouts';
import { DEFAULT_EPISODE } from '../../../shared/contract';
import {
  EFFORT_TEXT,
  PATTERN_TEXT,
  episodeSummary,
  hardNowText,
  parseLengthMin,
} from './episodeView';
import { useApp, useAppState } from './hooks';
import { WorkoutChart } from './WorkoutChart';
import { chartSummary, formatApproxDuration, zoneRows } from './workoutView';

const PRESETS: readonly number[] = EPISODE_PRESETS_MIN;

/**
 * "Fit to an episode": length, effort and pattern, a preview of the generated workout, and
 * "Use for next ride". Starts from the last choices (Settings.episode) and remembers them.
 */
export function EpisodeDialog({
  onClose,
  onChosen,
}: {
  onClose: () => void;
  onChosen?: () => void;
}) {
  const app = useApp();
  const saved = useAppState((s) => s.settings?.episode ?? DEFAULT_EPISODE);
  const ftpW = useAppState((s) => s.settings?.rider.ftpW ?? 200);
  const locked = useAppState((s) => (s.live?.ride.state ?? 'idle') !== 'idle');
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [effort, setEffort] = useState<EpisodeEffort>(saved.effort);
  const [pattern, setPattern] = useState<EpisodePattern>(saved.pattern);
  const [preset, setPreset] = useState<number | null>(
    PRESETS.includes(saved.lengthMin) ? saved.lengthMin : null,
  );
  const [custom, setCustom] = useState(
    PRESETS.includes(saved.lengthMin) ? '' : String(saved.lengthMin),
  );
  const customMin = parseLengthMin(custom);
  const lengthMin = preset ?? customMin;
  const plan = useMemo(
    () =>
      lengthMin === null
        ? null
        : generateEpisodeWorkout(normalizeEpisodeOptions({ lengthMin, effort, pattern })),
    [lengthMin, effort, pattern],
  );
  const options: EpisodeOptions | null = plan?.options ?? null;
  const summary = useMemo(() => (plan ? episodeSummary(plan, ftpW) : null), [plan, ftpW]);

  // Focus the dialog; Escape closes it (before the screens' own Escape handling).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, []);

  const use = (): void => {
    if (!options) return;
    if (app.selectEpisode(options)) {
      onClose();
      onChosen?.();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal ep-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        tabIndex={-1}
        ref={dialogRef}
        data-testid="episode-dialog"
      >
        <div className="ep-head">
          <h2 id={`${id}-title`} className="modal-title">
            Fit to an episode
          </h2>
          <p id={`${id}-desc`} className="hint">
            A workout exactly as long as what you watch. Start the episode and the ride together;
            the easy spin falls on the credits.
          </p>
        </div>

        <div className="ep-choices">
          <div className="ep-field" role="group" aria-labelledby={`${id}-len`}>
            <span id={`${id}-len`} className="ep-label">
              Length
            </span>
            <div className="ep-length">
              <div className="seg" role="group" aria-label="Preset lengths">
                {PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="seg-item"
                    aria-pressed={preset === m}
                    data-testid={`episode-length-${m}`}
                    onClick={() => {
                      setPreset(m);
                      setCustom('');
                    }}
                  >
                    {`${m} min`}
                  </button>
                ))}
              </div>
              <label className="ep-custom">
                <span className="visually-hidden">Custom length in minutes</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Custom"
                  maxLength={3}
                  data-testid="episode-length-custom"
                  aria-invalid={
                    preset === null && custom !== '' && customMin === null ? true : undefined
                  }
                  value={custom}
                  onChange={(e) => {
                    setCustom(e.currentTarget.value);
                    setPreset(null);
                  }}
                />
                <span className="ep-unit" aria-hidden="true">
                  min
                </span>
              </label>
            </div>
            {lengthMin === null && (
              <p className="hint ep-error" role="status" data-testid="episode-length-error">
                {`Enter whole minutes from ${EPISODE_MIN_LENGTH_MIN} to ${EPISODE_MAX_LENGTH_MIN}.`}
              </p>
            )}
          </div>

          <div className="ep-field" role="group" aria-labelledby={`${id}-effort`}>
            <span id={`${id}-effort`} className="ep-label">
              Effort
            </span>
            <div className="ep-options ep-options-3">
              {EPISODE_EFFORTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="ep-option"
                  aria-pressed={effort === e}
                  data-testid={`episode-effort-${e}`}
                  onClick={() => setEffort(e)}
                >
                  <span className="ep-option-title">{EFFORT_TEXT[e].title}</span>
                  <span className="ep-option-text">{EFFORT_TEXT[e].text}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="ep-field" role="group" aria-labelledby={`${id}-pattern`}>
            <span id={`${id}-pattern`} className="ep-label">
              Pattern
            </span>
            <div className="ep-options ep-options-4">
              {EPISODE_PATTERNS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="ep-option"
                  aria-pressed={pattern === p}
                  data-testid={`episode-pattern-${p}`}
                  onClick={() => setPattern(p)}
                >
                  <span className="ep-option-title">{PATTERN_TEXT[p].title}</span>
                  <span className="ep-option-text">{PATTERN_TEXT[p].text}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {plan && summary && (
          <div className="ep-preview card-inset" data-testid="episode-preview">
            <WorkoutChart
              workout={plan.workout}
              label={chartSummary(plan.workout, summary.stats)}
              size="lg"
              testId="episode-preview-chart"
            />
            <div className="ep-summary">
              <dl className="ep-facts" data-testid="episode-summary">
                <div>
                  <dt>Length</dt>
                  <dd>{summary.duration}</dd>
                </div>
                <div>
                  <dt>Warm-up · cool-down</dt>
                  <dd>{`${summary.warmup} · ${summary.cooldown}`}</dd>
                </div>
                <div>
                  <dt>Hard parts</dt>
                  <dd data-testid="episode-summary-hard">{summary.hard}</dd>
                </div>
                <div>
                  <dt>Estimated load</dt>
                  <dd data-testid="episode-summary-load">{summary.load}</dd>
                </div>
                <div>
                  <dt>Hard now (H)</dt>
                  <dd>{hardNowText(plan.options, ftpW)}</dd>
                </div>
              </dl>
              <ul className="list wo-zones ep-zones" aria-label="Time in power zones">
                {zoneRows(summary.stats).map((z) => (
                  <li key={z.zone} className="wo-zone">
                    <span className={`wo-swatch wo-z${z.zone}`} aria-hidden="true" />
                    <span className="wo-zone-name">{`Z${z.zone} ${z.name}`}</span>
                    <span className="wo-zone-bar" aria-hidden="true">
                      <span
                        className={`wo-z${z.zone}`}
                        style={{ width: `${Math.max(2, Math.round(z.share * 100))}%` }}
                      />
                    </span>
                    <span className="wo-zone-time">{formatApproxDuration(z.seconds)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {locked && (
          <p className="hint" data-testid="episode-locked">
            A ride is in progress — finish it to choose a new workout.
          </p>
        )}
        <div className="button-row end">
          <button type="button" className="btn" data-testid="episode-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="episode-use"
            disabled={!plan || locked}
            onClick={use}
          >
            Use for next ride
          </button>
        </div>
      </div>
    </div>
  );
}
