import type { CountdownSeconds } from '../../../shared/contract';
import { COUNTDOWN_CHOICES } from '../../../shared/contract';
import { Segmented } from './CommunityTab';
import { useApp, useAppState } from './hooks';

type Choice = `${CountdownSeconds}`;

const OPTIONS: readonly { value: Choice; label: string }[] = COUNTDOWN_CHOICES.map((s) => ({
  value: `${s}`,
  label: s === 0 ? 'Off' : `${s} s`,
}));

/** Settings → Ride: the countdown before a ride starts or resumes. */
export function RideSettings() {
  const app = useApp();
  const countdownS = useAppState((s) => s.settings?.ride?.countdownS ?? null);
  if (countdownS === null) return null;
  return (
    <section className="settings-section" aria-labelledby="set-ride" data-testid="settings-ride">
      <h2 id="set-ride" className="section-title section-head">
        Ride
      </h2>
      <div className="card rows">
        <div className="field field-countdown">
          <div className="field-text">
            <span className="field-label">Countdown before the start</span>
            <span className="field-hint">
              After Start and Resume, so you can sit down properly. Time and recording begin at
              zero; pressing Start again, Space or Esc cancels.
            </span>
          </div>
          <div className="field-control">
            <Segmented
              label="Countdown before the start"
              testId="settings-countdown"
              options={OPTIONS}
              value={`${countdownS}`}
              onChange={(v) =>
                void app.updateSettings({ ride: { countdownS: Number(v) as CountdownSeconds } })
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}
