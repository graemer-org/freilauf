import type { CountdownSeconds, PowerSmoothingSeconds } from '../../../shared/contract';
import { COUNTDOWN_CHOICES, POWER_SMOOTHING_CHOICES } from '../../../shared/contract';
import { Segmented } from './CommunityTab';
import { GhostSettingsToggle } from './GhostUi';
import { useApp, useAppState } from './hooks';

type Choice = `${CountdownSeconds}`;

const OPTIONS: readonly { value: Choice; label: string }[] = COUNTDOWN_CHOICES.map((s) => ({
  value: `${s}`,
  label: s === 0 ? 'Off' : `${s} s`,
}));

type SmoothingChoice = `${PowerSmoothingSeconds}`;

export const SMOOTHING_OPTIONS: readonly { value: SmoothingChoice; label: string }[] =
  POWER_SMOOTHING_CHOICES.map((s) => ({ value: `${s}`, label: s === 0 ? 'Off' : `${s} s` }));

/** Settings → Ride: the countdown before a ride starts or resumes, and power smoothing. */
export function RideSettings() {
  const app = useApp();
  const countdownS = useAppState((s) => s.settings?.ride?.countdownS ?? null);
  const smoothingS = useAppState((s) => s.settings?.ride?.powerSmoothingS ?? 3);
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
        <div className="field field-power-smoothing">
          <div className="field-text">
            <span className="field-label">Power smoothing</span>
            <span className="field-hint">
              Averages the power shown (the big number, W/kg and the overlay) over this time, so it
              jumps less. Recording, trainer control and workouts use the measured power.
            </span>
          </div>
          <div className="field-control">
            <Segmented
              label="Power smoothing"
              testId="settings-power-smoothing"
              options={SMOOTHING_OPTIONS}
              value={`${smoothingS}`}
              onChange={(v) =>
                void app.updateSettings({
                  ride: { powerSmoothingS: Number(v) as PowerSmoothingSeconds },
                })
              }
            />
          </div>
        </div>
        <GhostSettingsToggle />
      </div>
    </section>
  );
}
