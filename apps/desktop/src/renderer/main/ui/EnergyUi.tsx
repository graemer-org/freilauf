/**
 * Energy estimates in the UI (docs/energy.md): the rider's optional age and sex in Settings,
 * the post-ride energy block and the "how is this estimated" disclosure.
 */
import { useId } from 'react';
import type { LiveEnergy, RiderSex, Settings } from '../../../shared/contract';
import { NumberField } from './fields';
import { formatKcal } from './format';
import { useApp, useAppState } from './hooks';

const SEX_LABEL: Record<RiderSex, string> = {
  female: 'Female',
  male: 'Male',
  undisclosed: 'Prefer not to say',
};

/** One line next to the fields: what age and sex are for. */
export const AGE_SEX_HINT =
  'Optional. Only used for the heart-rate calorie estimate; without both it is not shown.';

/** A <select> for the rider's sex, styled like the other fields. */
export function SexSelect({
  value,
  onChange,
  testId,
  hint,
}: {
  value: RiderSex | null;
  onChange: (sex: RiderSex | null) => void;
  testId?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-text">
        <label htmlFor={id}>Sex</label>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      <div className="field-control">
        <select
          id={id}
          data-testid={testId}
          value={value ?? ''}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onChange(v === '' ? null : (v as RiderSex));
          }}
        >
          <option value="">Not set</option>
          {(Object.keys(SEX_LABEL) as RiderSex[]).map((s) => (
            <option key={s} value={s}>
              {SEX_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Age and sex rows for the rider section of Settings. */
export function RiderEnergyFields({ rider }: { rider: Settings['rider'] }) {
  const app = useApp();
  return (
    <>
      <NumberField
        label="Age"
        unit="years"
        testId="settings-age"
        value={rider.ageYears ?? null}
        min={10}
        max={100}
        step={1}
        allowEmpty
        placeholder="Not set"
        hint={AGE_SEX_HINT}
        onCommit={(v) => {
          void app.updateSettings({ rider: { ageYears: v === null ? null : Math.round(v) } });
        }}
      />
      <SexSelect
        value={rider.sex ?? null}
        testId="settings-sex"
        onChange={(sex) => {
          void app.updateSettings({ rider: { sex } });
        }}
      />
    </>
  );
}

/** "How is this estimated?" — short and honest. */
export function EnergyInfo() {
  return (
    <details className="disclosure energy-info" data-testid="energy-info">
      <summary>How these numbers are estimated</summary>
      <div className="energy-info-body">
        <p>
          <strong>Calories from power</strong> are the measured work divided by a typical efficiency
          of the body on a bike (24 %): kJ ÷ (4.184 × 0.24), so 1 kJ of work is about 1 kcal. Your
          own efficiency lies somewhere around 20–25 %, so the true value can be some 10–20 % off
          either way.
        </p>
        <p>
          <strong>The heart-rate cross-check</strong> uses the published Keytel et al. (2005)
          equations from heart rate, weight, age and sex. They read high at low heart rates. If the
          ride has no power at all, this is the calorie number shown.
        </p>
        <p>
          <strong>Fat and carbohydrate</strong> are split by how hard you rode relative to your FTP:
          mostly fat when easy, mostly carbohydrate near and above threshold. This depends a lot on
          training and diet, so treat it as a rough estimate.
        </p>
        <p>
          Watches and apps from big manufacturers use their own unpublished heart-rate methods, so
          their numbers differ.
        </p>
      </div>
    </details>
  );
}

function Fact({
  label,
  value,
  unit,
  note,
  testId,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  testId: string;
}) {
  return (
    <div className="summary-fact" data-testid={testId}>
      <dt className="tile-label">{label}</dt>
      <dd className="summary-value">
        <span className="tile-number">{value}</span>
        {unit && <span className="tile-unit">{unit}</span>}
      </dd>
      {note && <dd className="hint">{note}</dd>}
    </div>
  );
}

const whole = (v: number | null): string => (v === null ? '–' : String(Math.round(v)));

/** The post-ride energy block; nothing when there is nothing to estimate from. */
export function SummaryEnergy({ energy }: { energy: LiveEnergy | null | undefined }) {
  const profileMissing = useAppState(
    (s) =>
      s.settings !== null && (s.settings.rider.ageYears == null || !isSex(s.settings.rider.sex)),
  );
  if (!energy || energy.kcal === null) return null;
  const fromHr = energy.source === 'heartRate';
  return (
    <section
      className="card summary-energy"
      aria-labelledby="summary-energy-title"
      data-testid="summary-energy"
      data-source={energy.source ?? ''}
      // Unrounded values, for checks against the recorded ride (e2e).
      data-kcal={energy.kcal}
      data-fat-g={energy.fatG ?? undefined}
      data-carb-g={energy.carbG ?? undefined}
    >
      <h2 id="summary-energy-title" className="section-title">
        Energy
      </h2>
      <dl className="summary-facts">
        <Fact
          label={fromHr ? 'Calories (from heart rate)' : 'Calories'}
          value={whole(energy.kcal)}
          unit="kcal"
          note={fromHr ? 'No power was measured.' : 'From your power'}
          testId="summary-kcal"
        />
        {!fromHr && (
          <Fact
            label="Heart-rate cross-check"
            value={whole(energy.kcalHr)}
            unit={energy.kcalHr === null ? undefined : 'kcal'}
            note={
              energy.kcalHr === null
                ? profileMissing
                  ? 'Add age and sex in Settings'
                  : 'No heart rate'
                : undefined
            }
            testId="summary-kcal-hr"
          />
        )}
        {energy.fatG !== null && (
          <Fact label="Fat" value={whole(energy.fatG)} unit="g" testId="summary-fat" />
        )}
        {energy.carbG !== null && (
          <Fact label="Carbohydrate" value={whole(energy.carbG)} unit="g" testId="summary-carb" />
        )}
      </dl>
      {energy.fatG !== null && (
        <p className="hint summary-energy-note" data-testid="summary-energy-rough">
          Fat and carbohydrate are a rough estimate: they depend strongly on training and diet.
        </p>
      )}
      <EnergyInfo />
    </section>
  );
}

function isSex(v: unknown): boolean {
  return v === 'female' || v === 'male';
}

/** `≈ 612 kcal` for lists; empty string when unknown. */
export function kcalLabel(kcal: number | null | undefined): string {
  return typeof kcal === 'number' && Number.isFinite(kcal) && kcal > 0 ? formatKcal(kcal) : '';
}
