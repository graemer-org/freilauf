import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { App } from '../appStore';
import type { ActivityTab } from './ActivityScreen';
import { ActivityScreen } from './ActivityScreen';
import { DevicePicker, DevicesTab } from './DevicesTab';
import { RideReturnBar } from './Header';
import { AppContext, isEditableTarget, useAppState } from './hooks';
import { Notices } from './Notices';
import { readPrefs, writePrefs } from './prefs';
import { RideView } from './RideView';
import { routeActions } from './routesApi';
import { RoutesTab } from './RoutesTab';
import { SettingsTab } from './SettingsTab';
import { StartScreen } from './StartScreen';
import { SummaryScreen } from './SummaryScreen';
import { WorkoutsTab } from './WorkoutsTab';
import './main.css';

/**
 * The main window's screens. The start screen is home; the ride fills the window; the summary
 * follows Finish. Workouts and Routes are pickers inside the start flow; Devices, Activity and
 * Settings are quiet places of their own.
 */
export type ScreenId =
  'start' | 'ride' | 'summary' | 'workouts' | 'routes' | 'devices' | 'activity' | 'settings';

/** A screen, or a sub-place of one (Activity's two tabs, the start screen's group section). */
export type InitialScreen = ScreenId | 'history' | 'community' | 'group';

/** Screens with a Back button (and Escape): everything but start, ride and summary. */
const FOCUSED: ReadonlySet<ScreenId> = new Set([
  'workouts',
  'routes',
  'devices',
  'activity',
  'settings',
]);

const SCREEN_NAME: Record<ScreenId, string> = {
  start: 'Start',
  ride: 'Ride',
  summary: 'Summary',
  workouts: 'Workouts',
  routes: 'Routes',
  devices: 'Devices',
  activity: 'Activity',
  settings: 'Settings',
};

/** Title shown on the focused screens whose content has none of its own. */
const SCREEN_TITLE: Partial<Record<ScreenId, string>> = {
  devices: 'Devices',
  activity: 'Activity',
  settings: 'Settings',
};

function ScreenHead({
  screen,
  backTo,
  onBack,
}: {
  screen: ScreenId;
  backTo: ScreenId;
  onBack: () => void;
}) {
  const title = SCREEN_TITLE[screen];
  return (
    <div className="screen-head">
      <button
        type="button"
        className="btn btn-quiet btn-small back-btn"
        data-testid="screen-back"
        aria-label={`Back to ${SCREEN_NAME[backTo].toLowerCase()}`}
        onClick={onBack}
      >
        <span aria-hidden="true">‹</span> {SCREEN_NAME[backTo]}
      </button>
      {title && <h1 className="screen-title">{title}</h1>}
    </div>
  );
}

function initialStack(initial: InitialScreen | undefined): ScreenId[] {
  switch (initial) {
    case undefined:
    case 'start':
    case 'group':
      return ['start'];
    case 'ride':
    case 'summary':
      return [initial];
    case 'history':
    case 'community':
      return ['start', 'activity'];
    default:
      return ['start', initial];
  }
}

/** Picks the last ride's workout and route again (not an FTP test: nobody repeats one at once). */
function restoreLastChoice(app: App, afterFinish = false): void {
  const s = app.store.getState();
  // Right after Finish the live state may still say "riding" for one tick; the ride is over.
  if (!afterFinish && (s.live?.ride.state ?? 'idle') !== 'idle') return;
  const { lastWorkoutId, lastRouteId } = readPrefs();
  if (
    s.selectedWorkoutId === null &&
    lastWorkoutId !== null &&
    s.workouts.some((e) => e.workout.id === lastWorkoutId && e.ftpTest === undefined)
  ) {
    app.selectWorkout(lastWorkoutId);
  }
  if (
    s.selectedRouteId === null &&
    lastRouteId !== null &&
    s.routes.some((r) => r.id === lastRouteId)
  ) {
    routeActions(app)?.select(lastRouteId);
  }
}

function Shell({
  app,
  initial,
  extras,
}: {
  app: App;
  initial: InitialScreen | undefined;
  extras: ReactNode;
}) {
  const [stack, setStack] = useState<ScreenId[]>(() => initialStack(initial));
  const [activityTab, setActivityTab] = useState<ActivityTab>(
    initial === 'community' ? 'community' : 'history',
  );
  const [withGroup, setWithGroup] = useState(
    () => initial === 'group' || app.store.getState().group.phase !== 'idle',
  );
  // Opening Workouts for an FTP test scrolls to the tests.
  const [ftpFocus, setFtpFocus] = useState(false);
  const screen = stack[stack.length - 1] ?? 'start';
  const backTo = stack[stack.length - 2] ?? 'start';

  const go = (next: ScreenId, opts: { ftp?: boolean } = {}): void => {
    setFtpFocus(opts.ftp === true);
    setStack((s) => (s[s.length - 1] === next ? s : [...s, next]));
  };
  const reset = (next: ScreenId): void => {
    setFtpFocus(false);
    setStack(next === 'start' ? ['start'] : [next]);
  };
  const back = (): void => {
    setFtpFocus(false);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : ['start']));
  };
  const toRide = (): void => reset('ride');
  const startRiding = (): void => {
    const live = app.store.getState().live;
    // Starts after the countdown (Settings → Ride); one that already runs is not cancelled.
    if ((live?.ride.state ?? 'idle') === 'idle' && !live?.countdown) app.startRide();
    reset('ride');
  };

  // Once per launch: the last choice is preselected.
  useEffect(() => {
    restoreLastChoice(app);
  }, [app]);

  // A ride that starts (button, controller, group countdown): remember what it was; from the
  // start screen, show it.
  const rideState = useAppState((s) => s.live?.ride.state ?? 'idle');
  const prevRide = useRef(rideState);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const prev = prevRide.current;
    prevRide.current = rideState;
    if (prev !== 'idle' || rideState !== 'riding') return;
    const s = app.store.getState();
    writePrefs({ lastWorkoutId: s.selectedWorkoutId, lastRouteId: s.selectedRouteId });
    if (screenRef.current === 'start') reset('ride');
  }, [app, rideState]);

  // A countdown begins (group start, the controller's start button): the ride view shows it.
  const countdown = useAppState((s) => (s.live?.countdown ?? null) !== null);
  useEffect(() => {
    if (countdown && (screenRef.current === 'start' || screenRef.current === 'summary'))
      reset('ride');
  }, [countdown]);

  // Escape goes back from the pickers and the other focused screens.
  useEffect(() => {
    if (!FOCUSED.has(screen)) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isEditableTarget(e.target)) return;
      if (app.store.getState().picker) return;
      e.preventDefault();
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, screen]);

  // Each screen starts at the top (the scrolling element is shared).
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    mainRef.current?.scrollTo?.(0, 0);
  }, [screen, activityTab]);

  const leaveSummary = (): void => {
    if (app.store.getState().ftpOutcome) app.dismissFtpOutcome();
  };

  return (
    <div className={`app app-${screen}`}>
      <div className="chrome">{screen !== 'ride' && <RideReturnBar onReturn={toRide} />}</div>
      <main
        ref={mainRef}
        className={`app-main screen-${screen}`}
        id={`panel-${screen}`}
        aria-label={SCREEN_NAME[screen]}
        data-testid={`panel-${screen}`}
      >
        {FOCUSED.has(screen) && <ScreenHead screen={screen} backTo={backTo} onBack={back} />}
        {screen === 'start' && (
          <StartScreen
            onStart={startRiding}
            onOpenRide={toRide}
            onPickWorkout={() => go('workouts')}
            onPickFtpTest={() => go('workouts', { ftp: true })}
            onPickRoute={() => go('routes')}
            onOpenDevices={() => go('devices')}
            onOpenActivity={() => go('activity')}
            onOpenSettings={() => go('settings')}
            withGroup={withGroup}
            onWithGroup={setWithGroup}
            extras={extras}
          />
        )}
        {screen === 'ride' && (
          <RideView
            onLeave={() => reset('start')}
            onFinished={() => {
              // The summary says it already; the "Ride saved." toast would only repeat it.
              for (const n of app.store.getState().notices) {
                if (n.kind === 'info' && /^Ride (saved|was shorter)/.test(n.message)) {
                  app.dismissNotice(n.id);
                }
              }
              reset('summary');
            }}
            onOpenWorkouts={() => go('workouts')}
            onOpenDevices={() => go('devices')}
            onOpenSettings={() => go('settings')}
            extras={extras}
          />
        )}
        {screen === 'summary' && (
          <SummaryScreen
            onDone={() => {
              leaveSummary();
              reset('start');
              restoreLastChoice(app, true);
            }}
            onAgain={() => {
              leaveSummary();
              const { lastWorkoutId } = readPrefs();
              if (lastWorkoutId !== null && app.store.getState().selectedWorkoutId === null) {
                app.selectWorkout(lastWorkoutId);
              }
              // The finished ride is over even if the live state has not ticked yet.
              app.startRide();
              reset('ride');
            }}
          />
        )}
        {screen === 'workouts' && (
          <WorkoutsTab
            onGoToRide={back}
            onOpenSettings={() => go('settings')}
            focusFtpTests={ftpFocus}
          />
        )}
        {screen === 'routes' && <RoutesTab onGoToRide={back} />}
        {screen === 'devices' && <DevicesTab />}
        {screen === 'activity' && (
          <ActivityScreen
            tab={activityTab}
            onTab={setActivityTab}
            onOpenGroup={() => {
              setWithGroup(true);
              reset('start');
            }}
            onOpenFtpTests={() => go('workouts', { ftp: true })}
          />
        )}
        {screen === 'settings' && (
          <SettingsTab onOpenFtpTests={() => go('workouts', { ftp: true })} />
        )}
      </main>
      <DevicePicker />
      <Notices />
    </div>
  );
}

function Gate({
  app,
  initial,
  extras,
}: {
  app: App;
  initial: InitialScreen | undefined;
  extras: ReactNode;
}) {
  const loaded = useAppState((s) => s.settings !== null && s.live !== null);
  if (!loaded) {
    return (
      <div className="app app-loading" data-testid="app-loading" role="status">
        <span className="spinner" aria-hidden="true" /> Starting…
        <Notices />
      </div>
    );
  }
  return <Shell app={app} initial={initial} extras={extras} />;
}

export interface MainAppProps {
  /** Must be a stable instance for the window's lifetime. */
  app: App;
  /** Screen shown first; the start screen by default. */
  initialScreen?: InitialScreen;
  /** Extra controls for the start screen and the ride view's toolbar (the web pop-out). */
  extras?: ReactNode;
}

/** Root of the main window. */
export function MainApp({ app, initialScreen, extras }: MainAppProps) {
  return (
    <AppContext value={app}>
      <Gate app={app} initial={initialScreen} extras={extras} />
    </AppContext>
  );
}
