import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { workoutStats } from '@freilauf/workouts';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { GroupTab } from './GroupTab';
import { workoutSharing } from './groupShare';
import { Brand, DeviceChips } from './Header';
import { useApp, useAppState } from './hooks';
import { needsFirstRun, readPrefs, writePrefs } from './prefs';
import {
  routeActions,
  routeSharing,
  routesOf,
  selectedRouteIdOf,
  sharedRoutesOf,
} from './routesApi';
import { MAX_NAME_LENGTH } from './SettingsTab';
import type { RideKind } from './startView';
import { activeKinds, COMBINED_NOTE, routeLine, trainerNotice, workoutLine } from './startView';
import { WatchRelayBadge } from './WatchRelay';

export interface StartScreenProps {
  onStart: () => void;
  onOpenRide: () => void;
  onPickWorkout: () => void;
  onPickFtpTest: () => void;
  onPickRoute: () => void;
  onOpenDevices: () => void;
  onOpenActivity: () => void;
  onOpenSettings: () => void;
  withGroup: boolean;
  onWithGroup: (group: boolean) => void;
  /** Shell extras (the web build's pop-out button). */
  extras?: ReactNode;
}

// ───────────── what ─────────────

function KindIcon({ kind }: { kind: RideKind }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg className="kind-icon" viewBox="0 0 24 24" aria-hidden="true">
      {kind === 'free' && (
        <>
          <circle cx="12" cy="12" r="8" {...common} />
          <circle cx="12" cy="12" r="2.2" {...common} />
          <path d="M12 4v5.8M12 14.2V20M4 12h5.8M14.2 12H20" {...common} strokeWidth={1.2} />
        </>
      )}
      {kind === 'workout' && (
        <path d="M3 19h18M5 19v-5M9 19V9M13 19v-7M17 19V6" {...common} strokeWidth={2.2} />
      )}
      {kind === 'route' && (
        <>
          <path d="M5 19c2-6 6-3 8-8s4-5 6-6" {...common} />
          <circle cx="5" cy="19" r="1.6" {...common} />
          <circle cx="19" cy="5" r="1.6" {...common} />
        </>
      )}
      {kind === 'ftp' && (
        <>
          <path d="M4.5 16a8 8 0 1 1 15 0" {...common} />
          <path d="M12 14l4-5" {...common} strokeWidth={2.2} />
          <circle cx="12" cy="14" r="1.2" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

function KindCard({
  kind,
  title,
  text,
  active,
  disabled,
  highlight,
  onClick,
}: {
  kind: RideKind;
  title: string;
  text: string;
  active: boolean;
  disabled?: boolean;
  highlight?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`kind-card${active ? ' is-active' : ''}${highlight ? ' is-hinted' : ''}`}
      data-testid={`ride-kind-${kind}`}
      data-active={active || undefined}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="kind-top">
        <KindIcon kind={kind} />
        <span className="kind-check" aria-hidden="true" />
      </span>
      <span className="kind-title">{title}</span>
      <span className="kind-text">{text}</span>
    </button>
  );
}

/** The workout chosen for the next ride, with what the start screen says about it. */
function useChosenWorkout(): { line: string; ftpTest: boolean } | null {
  const id = useAppState((s) => s.selectedWorkoutId);
  const ftpW = useAppState((s) => s.settings?.rider.ftpW ?? DEFAULT_SETTINGS.rider.ftpW);
  const entry = useAppState((s) =>
    id === null ? null : (s.workouts.find((e) => e.workout.id === id) ?? null),
  );
  const shared = useAppState((s) =>
    id === null ? null : (s.sharedWorkouts.find((w) => w.workout.id === id) ?? null),
  );
  return useMemo(() => {
    const workout = entry?.workout ?? shared?.workout ?? null;
    if (!workout) return null;
    const durationS = workoutStats(workout, ftpW).durationS;
    return {
      line: workoutLine(workout.name, durationS, entry?.ftpTest?.openEnded === true),
      ftpTest: entry?.ftpTest !== undefined,
    };
  }, [entry, shared, ftpW]);
}

function WhatSection({
  locked,
  ftpHint,
  onPickWorkout,
  onPickFtpTest,
  onPickRoute,
}: {
  locked: boolean;
  ftpHint: boolean;
  onPickWorkout: () => void;
  onPickFtpTest: () => void;
  onPickRoute: () => void;
}) {
  const app = useApp();
  const workout = useChosenWorkout();
  const routeId = useAppState(selectedRouteIdOf);
  const routes = useAppState(routesOf);
  const route = routeId === null ? null : (routes.find((r) => r.id === routeId) ?? null);
  const hasRoutes = useMemo(() => routeActions(app) !== null, [app]);
  const on = activeKinds(workout, route !== null);
  const chooseFree = (): void => {
    app.selectWorkout(null);
    routeActions(app)?.select(null);
  };
  return (
    <section className="start-section" aria-labelledby="start-what">
      <h1 id="start-what" className="start-title">
        What are you riding today?
      </h1>
      <div className="kind-cards" role="group" aria-labelledby="start-what">
        <KindCard
          kind="free"
          title="Free ride"
          text="Your pace, your gears. Change the gradient as you like."
          active={on.free}
          disabled={locked}
          onClick={chooseFree}
        />
        <KindCard
          kind="workout"
          title="Workout"
          text={
            on.workout && workout
              ? workout.line
              : 'Intervals with targets; the trainer holds the power.'
          }
          active={on.workout}
          onClick={onPickWorkout}
        />
        {hasRoutes && (
          <KindCard
            kind="route"
            title="Route"
            text={route ? routeLine(route) : 'A real road from a GPX file, or a built-in one.'}
            active={on.route}
            onClick={onPickRoute}
          />
        )}
        <KindCard
          kind="ftp"
          title="FTP test"
          text={
            on.ftp && workout
              ? workout.line
              : ftpHint
                ? 'Find your FTP here — 20-minute or ramp test.'
                : 'Measure your FTP: a 20-minute or a ramp test.'
          }
          active={on.ftp}
          highlight={ftpHint && !on.ftp}
          onClick={onPickFtpTest}
        />
      </div>
      <div className="start-choice" data-testid="start-summary" aria-live="polite">
        {workout === null && route === null ? (
          <p>
            <strong>Free ride.</strong>{' '}
            <span className="hint">No targets and no route — gear and gradient are yours.</span>
          </p>
        ) : (
          <>
            {workout && (
              <p className="start-choice-line" data-testid="start-workout-summary">
                <span className="start-choice-label">
                  {workout.ftpTest ? 'FTP test' : 'Workout'}
                </span>
                <strong>{workout.line}</strong>
                <button
                  type="button"
                  className="link"
                  data-testid="start-workout-clear"
                  disabled={locked}
                  onClick={() => app.selectWorkout(null)}
                >
                  Clear
                </button>
              </p>
            )}
            {route && (
              <p className="start-choice-line" data-testid="start-route-summary">
                <span className="start-choice-label">Route</span>
                <strong>{routeLine(route)}</strong>
                <button
                  type="button"
                  className="link"
                  data-testid="start-route-clear"
                  disabled={locked}
                  onClick={() => routeActions(app)?.select(null)}
                >
                  Clear
                </button>
              </p>
            )}
            {workout && route && (
              <p className="hint" data-testid="start-combined-note">
                {COMBINED_NOTE}
              </p>
            )}
          </>
        )}
        {locked && (
          <p className="hint" data-testid="start-locked">
            A ride is in progress — finish it to choose something else.
          </p>
        )}
      </div>
    </section>
  );
}

// ───────────── with whom ─────────────

function SharedOffers() {
  const app = useApp();
  const workouts = useAppState((s) => s.sharedWorkouts);
  const routes = useAppState(sharedRoutesOf);
  const selectedWorkout = useAppState((s) => s.selectedWorkoutId);
  const selectedRoute = useAppState(selectedRouteIdOf);
  const locked = useAppState((s) => (s.live?.ride.state ?? 'idle') !== 'idle');
  const wSharing = useMemo(() => workoutSharing(app), [app]);
  const rSharing = useMemo(() => routeSharing(app), [app]);
  const offers = [
    ...(wSharing
      ? workouts.map((w) => ({
          key: `w-${w.peerId}`,
          text: `${w.peerName} shares the workout “${w.workout.name}”`,
          inUse: selectedWorkout === w.workout.id,
          use: () => wSharing.adopt(w.peerId),
          testId: 'start-shared-workout-use',
        }))
      : []),
    ...(rSharing
      ? routes.map((r) => ({
          key: `r-${r.peerId}`,
          text: `${r.peerName} shares the route “${r.entry.name}”`,
          inUse: selectedRoute === r.entry.id,
          use: () => rSharing.adopt(r.peerId),
          testId: 'start-shared-route-use',
        }))
      : []),
  ];
  if (offers.length === 0) return null;
  return (
    <ul className="list shared-offers" data-testid="start-shared">
      {offers.map((o) => (
        <li key={o.key} className="shared-offer">
          <span>{o.text}</span>
          {o.inUse ? (
            <span className="wo-selected-tag">
              <span aria-hidden="true">✓</span> In use
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              data-testid={o.testId}
              disabled={locked}
              onClick={o.use}
            >
              Use it
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function WithWhomSection({
  withGroup,
  onWithGroup,
  onOpenSettings,
}: {
  withGroup: boolean;
  onWithGroup: (group: boolean) => void;
  onOpenSettings: () => void;
}) {
  const phase = useAppState((s) => s.group.phase);
  const peers = useAppState((s) => (s.group.phase === 'joined' ? s.group.peers.length : 0));
  const inGroup = phase === 'joined' || phase === 'connecting';
  const group = withGroup || inGroup;
  return (
    <section className="start-section" aria-labelledby="start-with">
      <div className="start-section-head">
        <h2 id="start-with" className="section-title">
          With whom
        </h2>
        <div className="seg" role="group" aria-label="With whom">
          <button
            type="button"
            className="seg-item"
            aria-pressed={!group}
            data-testid="with-alone"
            disabled={inGroup}
            title={inGroup ? 'Leave the group ride first' : undefined}
            onClick={() => onWithGroup(false)}
          >
            Alone
          </button>
          <button
            type="button"
            className="seg-item"
            aria-pressed={group}
            data-testid="with-group"
            onClick={() => onWithGroup(true)}
          >
            Group ride
            {phase === 'joined' && (
              <span className="seg-count">{` · ${peers + 1} in the room`}</span>
            )}
          </button>
        </div>
      </div>
      {!group && (
        <p className="hint" data-testid="start-alone">
          Riding alone. Choose “Group ride” to create one or to paste an invite from a friend.
        </p>
      )}
      {group && (
        <div className="start-group card" data-testid="start-group">
          <SharedOffers />
          <GroupTab variant="start" onOpenSettings={onOpenSettings} />
        </div>
      )}
    </section>
  );
}

// ───────────── first run ─────────────

function FirstRun({ onDone, onFtpUnknown }: { onDone: () => void; onFtpUnknown: () => void }) {
  const app = useApp();
  const rider = useAppState((s) => s.settings?.rider ?? DEFAULT_SETTINGS.rider);
  const id = useId();
  const [name, setName] = useState('');
  const [mass, setMass] = useState(String(rider.massKg));
  const [ftp, setFtp] = useState(String(rider.ftpW));
  const [ftpUnknown, setFtpUnknown] = useState(false);
  const nameOk = name.trim().length <= MAX_NAME_LENGTH;
  const massN = Number(mass.replace(',', '.'));
  const massOk = Number.isFinite(massN) && massN >= 20 && massN <= 300;
  const ftpN = Number(ftp);
  const ftpOk = ftpUnknown || (Number.isInteger(ftpN) && ftpN >= 50 && ftpN <= 600);
  const valid = nameOk && massOk && ftpOk;
  const finish = (): void => {
    writePrefs({ firstRunDone: true });
    onDone();
  };
  return (
    <section className="card first-run" aria-labelledby={`${id}-title`} data-testid="first-run">
      <div className="first-run-head">
        <h2 id={`${id}-title`} className="section-title">
          Welcome. Three things about you, once.
        </h2>
        <p className="hint">
          They make the numbers right: your name for group rides, weight for speed on climbs, FTP
          for workout targets. You can change them later in Settings.
        </p>
      </div>
      <form
        className="first-run-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const trimmed = name.trim();
          void app.updateSettings({
            rider: {
              ...(trimmed ? { name: trimmed } : {}),
              massKg: massN,
              ...(ftpUnknown ? {} : { ftpW: ftpN }),
            },
          });
          if (ftpUnknown) onFtpUnknown();
          finish();
        }}
      >
        <label className="first-run-field">
          <span>Name</span>
          <input
            type="text"
            data-testid="first-run-name"
            autoComplete="nickname"
            maxLength={MAX_NAME_LENGTH}
            placeholder={rider.name}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <label className="first-run-field">
          <span>Weight (kg)</span>
          <input
            type="text"
            inputMode="decimal"
            data-testid="first-run-mass"
            aria-invalid={!massOk || undefined}
            value={mass}
            onChange={(e) => setMass(e.currentTarget.value)}
          />
        </label>
        <div className="first-run-field">
          <label htmlFor={`${id}-ftp`}>FTP (W)</label>
          <input
            id={`${id}-ftp`}
            type="text"
            inputMode="numeric"
            data-testid="first-run-ftp"
            aria-invalid={!ftpOk || undefined}
            aria-describedby={`${id}-ftp-note`}
            disabled={ftpUnknown}
            value={ftpUnknown ? String(rider.ftpW) : ftp}
            onChange={(e) => setFtp(e.currentTarget.value)}
          />
          <label className="check-row first-run-unknown">
            <input
              type="checkbox"
              data-testid="first-run-ftp-unknown"
              checked={ftpUnknown}
              onChange={(e) => setFtpUnknown(e.currentTarget.checked)}
            />{' '}
            I don’t know my FTP
          </label>
        </div>
        <p id={`${id}-ftp-note`} className="hint first-run-note">
          {ftpUnknown
            ? `We keep ${rider.ftpW} W for now. The FTP test card below measures yours.`
            : !massOk
              ? 'Enter a weight from 20 to 300 kg.'
              : !ftpOk
                ? 'Enter an FTP from 50 to 600 W.'
                : 'FTP: roughly the power you can hold for an hour.'}
        </p>
        <div className="button-row first-run-actions">
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="first-run-save"
            disabled={!valid}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            data-testid="first-run-skip"
            onClick={finish}
          >
            Skip
          </button>
        </div>
      </form>
    </section>
  );
}

// ───────────── devices and start ─────────────

function DeviceLine({ onOpenDevices }: { onOpenDevices: () => void }) {
  const app = useApp();
  const simMode = useAppState((s) => s.simMode);
  const state = useAppState((s) => s.live?.devices.trainer?.state ?? null);
  const remembered = useAppState((s) => s.settings?.devices.trainer !== undefined);
  const busy = useAppState((s) => s.busy.trainer);
  const notice = trainerNotice(state, remembered, busy, simMode);
  return (
    <div className="start-devices">
      <button
        type="button"
        className="device-line"
        data-testid="start-devices"
        aria-label="Devices: show status and pairing"
        onClick={onOpenDevices}
      >
        <DeviceChips />
        <WatchRelayBadge />
        <span className="device-line-more" aria-hidden="true">
          Devices ›
        </span>
      </button>
      {notice && (
        <p
          className={notice.tone === 'warn' ? 'callout-warn start-trainer' : 'hint start-trainer'}
          role="status"
          data-testid="start-device-warning"
          data-tone={notice.tone}
        >
          {notice.text}{' '}
          {notice.action === 'pair' && (
            <button
              type="button"
              className="link"
              data-testid="start-pair-trainer"
              onClick={() => void app.pairDevice('trainer')}
            >
              Pair a trainer
            </button>
          )}
          {notice.action === 'retry' && (
            <button
              type="button"
              className="link"
              data-testid="start-retry-trainer"
              onClick={() => void app.retryDevice('trainer')}
            >
              Look for it again
            </button>
          )}
        </p>
      )}
    </div>
  );
}

export function StartScreen(props: StartScreenProps) {
  const rider = useAppState((s) => s.settings?.rider);
  const riding = useAppState((s) => (s.live?.ride.state ?? 'idle') !== 'idle');
  const [firstRun, setFirstRun] = useState(() => needsFirstRun(readPrefs(), rider));
  const [ftpHint, setFtpHint] = useState(false);
  return (
    <div className="start" data-testid="start-screen">
      <header className="start-head">
        <Brand />
        <nav className="start-nav" aria-label="More">
          {props.extras}
          <button
            type="button"
            className="btn btn-quiet btn-small"
            data-testid="nav-activity"
            onClick={props.onOpenActivity}
          >
            Activity
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-small"
            data-testid="nav-settings"
            onClick={props.onOpenSettings}
          >
            Settings
          </button>
        </nav>
      </header>
      <div className="start-body">
        {firstRun && !riding && (
          <FirstRun onDone={() => setFirstRun(false)} onFtpUnknown={() => setFtpHint(true)} />
        )}
        <WhatSection
          locked={riding}
          ftpHint={ftpHint}
          onPickWorkout={props.onPickWorkout}
          onPickFtpTest={props.onPickFtpTest}
          onPickRoute={props.onPickRoute}
        />
        <WithWhomSection
          withGroup={props.withGroup}
          onWithGroup={props.onWithGroup}
          onOpenSettings={props.onOpenSettings}
        />
      </div>
      <footer className="start-bar">
        <DeviceLine onOpenDevices={props.onOpenDevices} />
        <div className="start-go">
          <button
            type="button"
            className="btn btn-primary btn-hero"
            data-testid="start-riding"
            onClick={props.onStart}
          >
            {riding ? 'Return to ride' : 'Start riding'}
          </button>
          {!riding && (
            <button
              type="button"
              className="link start-open-ride"
              data-testid="start-open-ride"
              onClick={props.onOpenRide}
            >
              Open the ride view without recording
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
