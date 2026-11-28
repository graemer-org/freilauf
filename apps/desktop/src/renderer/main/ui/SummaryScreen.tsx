import { useState } from 'react';
import type { RideBest } from '../appStore';
import {
  RUMBLE_NAME,
  formatHitLoss,
  formatItemGain,
  formatRaceGain,
} from '../../../shared/powerUps';
import { formatDistance, formatDuration } from './format';
import { SummaryEnergy } from './EnergyUi';
import { FtpOutcomeCard } from './FtpOutcome';
import { SummaryGhost } from './GhostUi';
import { useApp, useAppState } from './hooks';

const BEST_LABEL: Record<RideBest['key'], string> = {
  p5s: '5 s',
  p1m: '1 min',
  p5m: '5 min',
  p20m: '20 min',
};

function Fact({
  label,
  value,
  unit,
  testId,
}: {
  label: string;
  value: string;
  unit?: string;
  testId: string;
}) {
  return (
    <div className="summary-fact" data-testid={testId}>
      <dt className="tile-label">{label}</dt>
      <dd className="summary-value">
        <span className="tile-number">{value}</span>
        {unit && <span className="tile-unit">{unit}</span>}
      </dd>
    </div>
  );
}

/** After Finish: what the ride came to, then back to the start screen. */
export function SummaryScreen({ onDone, onAgain }: { onDone: () => void; onAgain: () => void }) {
  const app = useApp();
  const summary = useAppState((s) => s.lastRide);
  const weekPoints = useAppState((s) => s.community.week.totals.points);
  const [exporting, setExporting] = useState(false);

  if (!summary) {
    return (
      <div className="page summary" data-testid="summary-screen">
        <h1 className="start-title">Ride finished</h1>
        <p className="hint">Nothing to show for this ride.</p>
        <div className="button-row">
          <button
            type="button"
            className="btn btn-primary btn-big"
            data-testid="summary-done"
            onClick={onDone}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  const saved = summary.rideId !== null;
  const rideId = summary.rideId;
  const what = [summary.workoutName, summary.routeName].filter((x) => x !== null).join(' on ');
  const [distance, distanceUnit] = formatDistance(summary.distanceM).split(' ');

  return (
    <div className="page summary" data-testid="summary-screen" data-saved={saved}>
      <header className="summary-head">
        <span className="tile-label">{saved ? 'Ride saved' : 'Ride not saved'}</span>
        <h1 className="start-title">{saved ? 'Well ridden.' : 'That was a short one.'}</h1>
        {what && (
          <p className="hint summary-what" data-testid="summary-what">
            {what}
          </p>
        )}
        {summary.windLabel && (
          <p className="summary-wind" data-testid="summary-wind">
            <span className="tag tag-accent">{`With wind of ${summary.windLabel}`}</span>
          </p>
        )}
        {!saved && (
          <p className="hint" data-testid="summary-not-saved">
            Rides shorter than 10 seconds are not kept.
          </p>
        )}
      </header>

      <dl className="card summary-facts">
        <Fact label="Time" value={formatDuration(summary.durationS)} testId="summary-duration" />
        <Fact
          label="Distance"
          value={distance ?? '–'}
          unit={distanceUnit}
          testId="summary-distance"
        />
        <Fact
          label="Average power"
          value={summary.avgPowerW === null ? '–' : String(summary.avgPowerW)}
          unit={summary.avgPowerW === null ? undefined : 'W'}
          testId="summary-power"
        />
        <div className="summary-fact" data-testid="summary-points">
          <dt className="tile-label">Points</dt>
          <dd className="summary-value">
            <span className="tile-number">
              {summary.points === null ? '–' : summary.points > 0 ? `+${summary.points}` : '0'}
            </span>
          </dd>
          <dd className="hint" data-testid="summary-week-points">
            {`${weekPoints} this week`}
          </dd>
        </div>
      </dl>

      <SummaryGhost summary={summary} />

      <SummaryEnergy energy={summary.energy} />

      {summary.rumble && (summary.rumble.gainM > 0 || summary.rumble.lossM < 0) ? (
        <p className="hint summary-powerups" data-testid="summary-rumble">
          {summary.rumble.gainM > 0 && (
            <strong data-testid="summary-rumble-gain">
              {formatItemGain(summary.rumble.gainM)}
            </strong>
          )}
          {summary.rumble.gainM > 0 && summary.rumble.lossM < 0 && ' and '}
          {summary.rumble.lossM < 0 && (
            <strong data-testid="summary-rumble-loss">{formatHitLoss(summary.rumble.lossM)}</strong>
          )}
          {` in your race position (${RUMBLE_NAME}). Time, distance, points and bests count your own riding only.`}
        </p>
      ) : null}

      {!summary.rumble && (summary.powerUpGainM ?? 0) > 0 && (
        <p className="hint summary-powerups" data-testid="summary-powerups">
          <strong>{formatRaceGain(summary.powerUpGainM ?? 0)}</strong> in your race position. Time,
          distance, points and bests count your own riding only.
        </p>
      )}

      {summary.bests.length > 0 && (
        <section
          className="card summary-bests"
          aria-labelledby="summary-bests-title"
          data-testid="summary-bests"
        >
          <h2 id="summary-bests-title" className="section-title">
            New personal bests
          </h2>
          <ul className="list">
            {summary.bests.map((b) => (
              <li key={b.key} className="summary-best" data-testid="summary-best">
                <span>{`Best ${BEST_LABEL[b.key]} power`}</span>
                <strong>{`${Math.round(b.powerW)} W`}</strong>
                <span className="hint">{`was ${Math.round(b.previousW)} W`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <FtpOutcomeCard />

      <div className="summary-actions">
        {rideId !== null && (
          <button
            type="button"
            className="btn"
            data-testid="summary-export-fit"
            disabled={exporting}
            onClick={() => {
              setExporting(true);
              void app.exportFit(rideId).finally(() => setExporting(false));
            }}
          >
            {exporting ? 'Exporting…' : 'Export .fit'}
          </button>
        )}
        <span className="summary-actions-gap" />
        <button type="button" className="btn btn-big" data-testid="summary-again" onClick={onAgain}>
          Ride again
        </button>
        <button
          type="button"
          className="btn btn-primary btn-big"
          data-testid="summary-done"
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </div>
  );
}
