import { useState } from 'react';
import { useApp, useAppState } from './hooks';
import { formatFtpChange } from './workoutView';

/**
 * After an FTP test: the measured result, offered as the new FTP. Part of the post-ride summary
 * (it used to be a modal on top of the ride).
 */
export function FtpOutcomeCard() {
  const app = useApp();
  const outcome = useAppState((s) => s.ftpOutcome);
  const ftpW = useAppState((s) => s.settings?.rider.ftpW ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);

  if (!outcome) {
    if (saved === null) return null;
    return (
      <section className="card ftp-card is-saved" data-testid="ftp-saved" role="status">
        <span className="tile-label">FTP test</span>
        <p className="ftp-saved-text">
          Saved: your FTP is now <strong>{`${ftpW ?? saved} W`}</strong>. Every workout follows it.
        </p>
      </section>
    );
  }

  const basisLabel = outcome.kind === 'ramp' ? 'Best minute' : '20-minute average';
  const factor = outcome.kind === 'ramp' ? '75 %' : '95 %';
  const testName = outcome.kind === 'ramp' ? 'Ramp test' : '20-minute test';

  return (
    <section
      className="card ftp-card"
      aria-labelledby="ftp-outcome-title"
      aria-describedby="ftp-outcome-desc"
      data-testid="ftp-outcome"
      data-valid={outcome.valid}
    >
      <div>
        <span className="tile-label">{testName}</span>
        <h2 id="ftp-outcome-title" className="section-title">
          {outcome.valid ? 'Your new FTP estimate' : 'No FTP result this time'}
        </h2>
      </div>

      {outcome.valid ? (
        <>
          <div className="ftp-card-body">
            <p className="ftp-result" data-testid="ftp-outcome-value">
              <span className="ftp-result-number">{Math.round(outcome.ftpW)}</span>
              <span className="tile-unit">W</span>
            </p>
            <dl className="ftp-facts" id="ftp-outcome-desc">
              <div>
                <dt>{basisLabel}</dt>
                <dd>{`${Math.round(outcome.basisPowerW)} W`}</dd>
              </div>
              <div>
                <dt>{`FTP = ${factor} of it`}</dt>
                <dd>{`${Math.round(outcome.ftpW)} W`}</dd>
              </div>
              <div>
                <dt>Previous FTP</dt>
                <dd>{`${Math.round(outcome.previousFtpW)} W`}</dd>
              </div>
              <div>
                <dt>Change</dt>
                <dd data-testid="ftp-outcome-change">
                  {formatFtpChange(outcome.previousFtpW, outcome.ftpW)}
                </dd>
              </div>
            </dl>
          </div>
          <p className="hint">Saving updates the targets of every workout to the new FTP.</p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="ftp-accept"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                const value = Math.round(outcome.ftpW);
                void app
                  .acceptFtpOutcome()
                  .then(() => setSaved(value))
                  .finally(() => setSaving(false));
              }}
            >
              Save as my FTP
            </button>
            <button
              type="button"
              className="btn"
              data-testid="ftp-dismiss"
              onClick={() => app.dismissFtpOutcome()}
            >
              Not now
            </button>
          </div>
        </>
      ) : (
        <>
          <p id="ftp-outcome-desc" className="ftp-reason" data-testid="ftp-outcome-reason">
            {outcome.reason ?? 'The test did not record enough data for a result.'}
          </p>
          {outcome.basisPowerW > 0 && (
            <p className="hint">
              {basisLabel} measured: {Math.round(outcome.basisPowerW)} W. Your FTP stays at{' '}
              {Math.round(outcome.previousFtpW)} W.
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="btn"
              data-testid="ftp-dismiss"
              onClick={() => app.dismissFtpOutcome()}
            >
              Close
            </button>
          </div>
        </>
      )}
    </section>
  );
}
