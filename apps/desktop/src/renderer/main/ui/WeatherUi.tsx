/**
 * The weather of a day along routes in the Routes tab and on the start screen (docs/routes.md,
 * "The weather of that day"): the import option (off by default), the per-route status with
 * progress and cancel, loading, replacing or removing it later, and "Ride with that day's
 * wind". Loading is always the rider's explicit choice.
 */
import { useId, useMemo, useState } from 'react';
import { DEFAULT_WEATHER_START } from '@freilauf/routes';
import { useApp, useAppState } from './hooks';
import {
  type RouteEntry,
  rideWithWindOf,
  routeWindOf,
  selectedRouteIdOf,
  weatherActions,
  weatherStatusOf,
} from './routesApi';
import {
  WEATHER_CREDIT,
  WEATHER_PRIVACY_NOTE,
  latestWeatherDay,
  weatherProgressText,
  weatherSummaryText,
  weatherWhenText,
  windIndicator,
} from './weatherView';

export interface WeatherDay {
  date: string;
  time: string;
}

export const EMPTY_WEATHER_DAY: WeatherDay = { date: '', time: DEFAULT_WEATHER_START };

/** Day and start time fields (the day must be in the archive: a few days back or older). */
function DayFields({
  day,
  onChange,
  testPrefix,
}: {
  day: WeatherDay;
  onChange: (d: WeatherDay) => void;
  testPrefix: string;
}) {
  const id = useId();
  return (
    <span className="rt-weather-fields">
      <label htmlFor={`${id}-d`}>Day</label>
      <input
        id={`${id}-d`}
        type="date"
        className="input"
        data-testid={`${testPrefix}-date`}
        min="1940-01-01"
        max={latestWeatherDay()}
        value={day.date}
        onChange={(e) => onChange({ ...day, date: e.currentTarget.value })}
      />
      <label htmlFor={`${id}-t`}>Start</label>
      <input
        id={`${id}-t`}
        type="time"
        className="input"
        data-testid={`${testPrefix}-time`}
        value={day.time}
        onChange={(e) => onChange({ ...day, time: e.currentTarget.value || DEFAULT_WEATHER_START })}
      />
    </span>
  );
}

/** "Load the weather of that day" next to "Load surroundings" when importing. */
export function WeatherImportOption({
  checked,
  onChange,
  day,
  onDay,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  day: WeatherDay;
  onDay: (d: WeatherDay) => void;
}) {
  return (
    <div className="rt-scenery-option rt-weather-option" data-testid="route-import-weather-option">
      <label className="check-row">
        <input
          type="checkbox"
          data-testid="route-import-weather"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />{' '}
        Load the weather of that day
      </label>
      <p className="hint rt-scenery-note" data-testid="route-import-weather-note">
        {WEATHER_PRIVACY_NOTE}
      </p>
      {checked && (
        <div className="rt-scenery-note rt-weather-day" data-testid="route-import-weather-day">
          <p className="hint">
            A recorded ride (a file with times) uses its own day and times. For a file without
            times:
          </p>
          <DayFields day={day} onChange={onDay} testPrefix="route-import-weather" />
        </div>
      )}
    </div>
  );
}

/** A short line under the route's summary while loading or once stored. */
export function WeatherBadge({ entry }: { entry: RouteEntry }) {
  const app = useApp();
  const status = useAppState((s) => weatherStatusOf(s, entry.id));
  const actions = useMemo(() => weatherActions(app), [app]);
  if (status.state === 'queued' || status.state === 'loading') {
    return (
      <p className="wo-meta rt-scenery-badge" data-testid="route-weather-progress" role="status">
        <span>{weatherProgressText(status)}</span>{' '}
        <button
          type="button"
          className="btn btn-small btn-quiet"
          data-testid="route-weather-cancel"
          onClick={() => actions.cancel(entry.id)}
        >
          Cancel
        </button>
      </p>
    );
  }
  if (status.state === 'ready') {
    return (
      <p className="wo-meta rt-scenery-badge" data-testid="route-weather-badge">
        <span className="tag tag-accent">{`Weather of ${status.label}`}</span>
      </p>
    );
  }
  if (status.state === 'error') {
    return (
      <p className="wo-meta rt-scenery-badge callout-warn" data-testid="route-weather-error-badge">
        Weather not loaded
      </p>
    );
  }
  return null;
}

/** In a route's details: status, load / load again with another date / remove. Imported routes only. */
export function WeatherDetails({ entry, riding }: { entry: RouteEntry; riding: boolean }) {
  const app = useApp();
  const status = useAppState((s) => weatherStatusOf(s, entry.id));
  const actions = useMemo(() => weatherActions(app), [app]);
  const recorded = useMemo(() => actions.recorded(entry.id), [actions, entry.id]);
  const [day, setDay] = useState<WeatherDay>(EMPTY_WEATHER_DAY);
  const [picking, setPicking] = useState(false);
  if (entry.source !== 'imported') return null;

  const dayForm = (label: string) => (
    <div className="button-row rt-weather-day" data-testid="route-weather-day">
      <DayFields day={day} onChange={setDay} testPrefix="route-weather" />
      <button
        type="button"
        className="btn btn-small"
        data-testid="route-weather-load-day"
        disabled={!day.date}
        onClick={() => {
          if (actions.load(entry.id, day)) setPicking(false);
        }}
      >
        {label}
      </button>
    </div>
  );
  const recordedButton = (label: string) =>
    recorded && (
      <button
        type="button"
        className="btn btn-small"
        data-testid="route-weather-load"
        onClick={() => actions.load(entry.id)}
      >
        {label}
      </button>
    );

  return (
    <div className="rt-scenery rt-weather" data-testid="route-weather" data-state={status.state}>
      <h4 className="rt-scenery-title">Weather of that day</h4>
      {status.state === 'none' && (
        <>
          <p className="hint">
            Ride with the wind of a real day: the historical wind along this road changes how fast
            you go. Loaded once, then kept on this device. {WEATHER_PRIVACY_NOTE}
          </p>
          {recorded && (
            <div className="button-row">
              {recordedButton(`Load the weather of the recorded ride (${recorded.label})`)}
            </div>
          )}
          {dayForm(recorded ? 'Load this day instead' : 'Load the weather')}
        </>
      )}
      {(status.state === 'queued' || status.state === 'loading') && (
        <div className="button-row" role="status" data-testid="route-weather-loading">
          <span>{weatherProgressText(status)}</span>
          <button
            type="button"
            className="btn btn-small"
            data-testid="route-weather-details-cancel"
            onClick={() => actions.cancel(entry.id)}
          >
            Cancel
          </button>
        </div>
      )}
      {status.state === 'ready' && (
        <>
          <p data-testid="route-weather-summary">{weatherSummaryText(status.summary)}</p>
          <p className="hint" data-testid="route-weather-attribution">
            {weatherWhenText(status.summary)} {WEATHER_CREDIT}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-small btn-danger"
              data-testid="route-weather-remove"
              disabled={riding}
              onClick={() => actions.remove(entry.id)}
            >
              Remove weather
            </button>
            {!picking && (
              <button
                type="button"
                className="btn btn-small btn-quiet"
                data-testid="route-weather-reload"
                disabled={riding}
                onClick={() => setPicking(true)}
              >
                Load again with another date
              </button>
            )}
            {status.summary.when === 'chosen' && recordedButton('Use the recorded ride instead')}
          </div>
          {picking && dayForm('Load this day')}
        </>
      )}
      {status.state === 'error' && (
        <>
          <p className="callout-warn" data-testid="route-weather-error">
            {status.message}
          </p>
          <div className="button-row">{recordedButton('Try again')}</div>
          {dayForm(recorded ? 'Try another day' : 'Try again')}
        </>
      )}
    </div>
  );
}

/** Start screen: "Ride with that day's wind" for the selected route when it has weather. */
export function RideWithWindToggle({ disabled }: { disabled?: boolean }) {
  const app = useApp();
  const id = useAppState(selectedRouteIdOf);
  const profile = useAppState(routeWindOf);
  const on = useAppState((s) => rideWithWindOf(s, id));
  const label = useAppState((s) => (id ? weatherStatusOf(s, id) : null));
  const actions = useMemo(() => weatherActions(app), [app]);
  if (!id || !profile || label?.state !== 'ready') return null;
  return (
    <div className="start-wind" data-testid="start-wind">
      <label className="check-row">
        <input
          type="checkbox"
          data-testid="start-wind-toggle"
          checked={on}
          disabled={disabled}
          onChange={(e) => actions.setRideWithWind(id, e.currentTarget.checked)}
        />{' '}
        {`Ride with that day’s wind (${label.label})`}
      </label>
      <p className="hint" data-testid="start-wind-hint">
        {on
          ? 'Head- and tailwind change your speed; the ride is compared only with rides in the same wind.'
          : 'Ridden without wind, like before the weather was loaded.'}
      </p>
    </div>
  );
}

/** The wind chip on the ride scene (top centre), in both views; light rain streaks when wet. */
export function WindHud() {
  const w = useAppState((s) => s.live?.wind ?? null);
  const ind = windIndicator(w);
  if (!ind || !w) return null;
  return (
    <>
      {ind.rain > 0 && (
        <div
          className="scene-rain"
          data-testid="scene-rain"
          aria-hidden="true"
          style={{ opacity: Math.min(0.9, 0.35 + ind.rain / 4) }}
        />
      )}
      <div
        className={`wind-chip is-${ind.kind}`}
        data-testid="wind-chip"
        data-kind={ind.kind}
        data-head-mps={w.headMps.toFixed(2)}
        title={ind.title}
        role="status"
      >
        <svg
          className="wind-arrow"
          viewBox="0 0 16 16"
          aria-hidden="true"
          style={{ transform: `rotate(${ind.arrowDeg}deg)` }}
        >
          <path d="M8 1.5 12.5 7H9.4v7.5H6.6V7H3.5Z" fill="currentColor" />
        </svg>
        <span className="wind-chip-text" data-testid="wind-text">
          {ind.text}
        </span>
        {ind.weather && (
          <span className="wind-chip-weather" data-testid="wind-weather">
            {ind.weather}
          </span>
        )}
      </div>
    </>
  );
}
