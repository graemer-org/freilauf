import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useApp, useAppState } from './hooks';
import { formatFtpChange } from './workoutView';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** After an FTP test: the measured result, offered as the new FTP. */
export function FtpOutcomeDialog() {
  const app = useApp();
  const outcome = useAppState((s) => s.ftpOutcome);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const open = outcome !== null;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first =
      dialog?.querySelector<HTMLElement>('.btn-primary') ?? dialog?.querySelector('button');
    (first ?? dialog)?.focus();
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      app.dismissFtpOutcome();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, app]);

  if (!outcome) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Escape is handled on window (works even if focus left the sheet).
    if (e.key !== 'Tab') return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstItem = items[0] as HTMLElement;
    const lastItem = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === firstItem) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  };

  const basisLabel = outcome.kind === 'ramp' ? 'Best minute' : '20-minute average';
  const factor = outcome.kind === 'ramp' ? '75 %' : '95 %';
  const testName = outcome.kind === 'ramp' ? 'Ramp test' : '20-minute test';

  return (
    <div className="modal-backdrop">
      <div
        className="modal ftp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ftp-outcome-title"
        aria-describedby="ftp-outcome-desc"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
        data-testid="ftp-outcome"
        data-valid={outcome.valid}
      >
        <div>
          <span className="tile-label">{testName}</span>
          <h2 id="ftp-outcome-title" className="modal-title">
            {outcome.valid ? 'Your new FTP estimate' : 'No FTP result this time'}
          </h2>
        </div>

        {outcome.valid ? (
          <>
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
            <p className="hint">Saving updates the targets of every workout to the new FTP.</p>
            <div className="button-row end">
              <button
                type="button"
                className="btn"
                data-testid="ftp-dismiss"
                onClick={() => app.dismissFtpOutcome()}
              >
                Not now
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="ftp-accept"
                disabled={saving}
                onClick={() => {
                  setSaving(true);
                  void app.acceptFtpOutcome().finally(() => setSaving(false));
                }}
              >
                Save as my FTP
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
            <div className="button-row end">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="ftp-dismiss"
                onClick={() => app.dismissFtpOutcome()}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
