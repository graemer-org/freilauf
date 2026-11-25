/**
 * Contract between the Electron main process, the main window and the
 * overlay window. Types only (plus defaults) — importable from all three.
 */
import type {
  ConnectionState,
  ControllerButton,
  DeviceKind,
  RelayServiceKind,
} from '@freilauf/devices';
import type { GroupRider } from '@freilauf/p2p';
import type { RoutePosition } from '@freilauf/routes';
import type { RecordedRide, RideSnapshot } from '@freilauf/session';
import type { GroupMode, PowerUpLive } from './powerUps';

export type StatId =
  | 'power'
  | 'power3s'
  | 'wattsPerKg'
  | 'cadence'
  | 'speed'
  | 'heartRate'
  | 'gear'
  | 'time'
  | 'distance'
  | 'gradient'
  | 'targetPower'
  | 'intervalRemaining'
  | 'routeRemaining'
  | 'ascentRemaining'
  | 'elevation'
  | 'calories'
  | 'fatGrams';

export const ALL_STATS: readonly StatId[] = [
  'power',
  'power3s',
  'wattsPerKg',
  'cadence',
  'speed',
  'heartRate',
  'gear',
  'time',
  'distance',
  'gradient',
  'targetPower',
  'intervalRemaining',
  'routeRemaining',
  'ascentRemaining',
  'elevation',
  'calories',
  'fatGrams',
];

export interface OverlayTile {
  stat: StatId;
  size: 's' | 'm' | 'l';
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlaySettings {
  visible: boolean;
  /** null until the user moved it; main picks a default on the primary display. */
  bounds: Bounds | null;
  /** Opacity of the dark tile backdrop, 0…1. Text is always fully opaque. */
  backdropOpacity: number;
  tiles: OverlayTile[];
  showGroup: boolean;
  /** Electron accelerator toggling edit mode (click-through off). */
  editHotkey: string;
}

export interface RememberedDevice {
  id: string;
  name: string;
}

/** What a controller button can do. Steering actions apply while the button is held. */
export type ControllerAction =
  | 'shiftUp'
  | 'shiftDown'
  | 'gradientUp'
  | 'gradientDown'
  | 'startPause'
  | 'workoutSkip'
  | 'workoutBack'
  | 'intensityUp'
  | 'intensityDown'
  | 'steerLeft'
  | 'steerRight'
  | 'usePowerUp'
  | 'none';

/** @deprecated use ControllerAction */
export type ShiftAction = ControllerAction;

export const CONTROLLER_ACTION_LABELS: Record<ControllerAction, string> = {
  none: 'Nothing',
  shiftUp: 'Shift up (harder)',
  shiftDown: 'Shift down (easier)',
  gradientUp: 'Gradient +0.5 %',
  gradientDown: 'Gradient −0.5 %',
  startPause: 'Start / pause ride',
  workoutSkip: 'Workout: skip step',
  workoutBack: 'Workout: restart step',
  intensityUp: 'Workout: intensity +5 %',
  intensityDown: 'Workout: intensity −5 %',
  steerLeft: 'Steer left (hold)',
  steerRight: 'Steer right (hold)',
  usePowerUp: 'Use power-up',
};

/**
 * What one direction of a handlebar lever does. Each grip has one analog
 * lever that moves both ways (−100 … +100); each direction gets a function.
 */
export type LeverFunction = 'steerLeft' | 'steerRight' | 'brake' | 'none';

export const LEVER_FUNCTION_LABELS: Record<LeverFunction, string> = {
  none: 'Nothing',
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  brake: 'Brake',
};

/** The two directions of one grip's lever: towards + and towards −. */
export interface LeverAssignment {
  positive: LeverFunction;
  negative: LeverFunction;
}

export interface LeverSettings {
  left: LeverAssignment;
  right: LeverAssignment;
  /**
   * Fraction of full travel around rest that does nothing (0 … 0.5). The
   * levers jitter by ±1–2 % at rest; above the dead zone the output rises
   * proportionally to 100 % at full travel.
   */
  deadzone: number;
}

/**
 * Default lever meaning: worked out from one hardware capture and confirmed by the tester
 * (docs/protocols/zwift-ride.md), mirror-symmetric between the grips —
 * right lever + = steer right, − = brake; left lever − = steer left, + = brake.
 */
export const DEFAULT_LEVERS: LeverSettings = {
  left: { positive: 'brake', negative: 'steerLeft' },
  right: { positive: 'steerRight', negative: 'brake' },
  deadzone: 0.05,
};

/** Rider sex for the heart-rate energy estimate; 'undisclosed' = prefer not to say. */
export type RiderSex = 'female' | 'male' | 'undisclosed';

export interface Settings {
  rider: {
    name: string;
    massKg: number;
    bikeMassKg: number;
    /** Functional threshold power in watts; workouts are scaled by it. */
    ftpW: number;
    /**
     * Optional, only for the heart-rate energy estimate (docs/energy.md): age in years
     * (10–100) and sex. null = not given; then that estimate is not shown.
     */
    ageYears?: number | null;
    sex?: RiderSex | null;
  };
  /** Devices to reconnect to on start. */
  devices: Partial<Record<DeviceKind, RememberedDevice>>;
  shifting: {
    /** Chainring/cog ratio physically on the bike; see ADR 0002. */
    physicalRatio: number;
    /** Mass the trainer assumes in sim mode; null = same as rider + bike. */
    trainerMassKg: number | null;
    /** Controller button → action. Configurable because the bit table is unverified. */
    buttons: Partial<Record<ControllerButton, ShiftAction>>;
    /** What the two analog levers do, per direction. */
    levers: LeverSettings;
  };
  overlay: OverlaySettings;
  /**
   * Group rides. By default riders find each other through public relay
   * servers and need no setup (docs/group-rides.md). Advanced:
   * - `useOwnServer`: create rides on (and join bare codes through) the
   *   signalling server at `signallingUrl` instead. Old-style invite links
   *   (`…?s=<server>`) use their own server either way.
   * - `relayUrls`: relays to use instead of the built-in ones ([] = built-in).
   *   Every rider in a group needs at least one relay in common.
   */
  group: { useOwnServer: boolean; signallingUrl: string; relayUrls: string[] };
  /** Riding routes (docs/routes.md, docs/adr/0004-routes.md). */
  route: {
    /**
     * Trainer difficulty in percent (0 … 100, default 100): the share of each route gradient
     * the trainer makes the rider feel. Speed, distance and the recording always use the
     * real gradient. Descents are scaled alike.
     */
    difficulty: number;
  };
  /** Power-ups (docs/power-ups.md): never change the recording, only the race position. */
  powerUps: { enabled: boolean; challenges: boolean };
  /** Riding: the countdown before a ride starts or resumes (docs/getting-started.md). */
  ride: {
    /** Seconds counted down after Start / Resume before time and recording begin; 0 = off. */
    countdownS: CountdownSeconds;
  };
  /** Share with my watch: publish the live values as Bluetooth sensors (docs/watch-relay.md). */
  watchRelay: WatchRelaySettings;
}

/** Which groups of live values to publish as a Bluetooth sensor; see docs/adr/0005-sensor-relay.md. */
export interface WatchRelaySettings {
  /** Off by default: the computer only advertises while this is on. */
  enabled: boolean;
  /**
   * heartRate: Heart Rate service. power: Cycling Power (power + cadence). speedCadence: Cycling
   * Speed and Cadence (virtual speed and distance + cadence). trainer: Fitness Machine (Indoor
   * Bike Data), off by default (see the ADR).
   */
  share: Record<RelayServiceKind, boolean>;
}

export const DEFAULT_WATCH_RELAY: WatchRelaySettings = {
  enabled: false,
  share: { heartRate: true, power: true, speedCadence: true, trainer: false },
};

/** What "Share with my watch" is doing right now (main → main window). */
export type WatchRelayStatus =
  /** Not possible in this build or on this operating system; the switch is disabled. */
  | { state: 'unavailable'; reason: string; browser?: boolean }
  | { state: 'off' }
  | { state: 'starting' }
  /** The helper ran but this computer's Bluetooth cannot act as a sensor. */
  | { state: 'unsupported'; reason: string }
  /** Advertising; `devices` watches are subscribed (0 = waiting for a watch). */
  | {
      state: 'sharing';
      devices: number;
      sharing: RelayServiceKind[];
      /** The name the watch most likely sees (the computer's name). */
      computerName: string;
    }
  | { state: 'error'; message: string; retrying: boolean };

export const DEFAULT_SETTINGS: Settings = {
  rider: { name: 'Rider', massKg: 75, bikeMassKg: 8, ftpW: 200, ageYears: null, sex: null },
  devices: {},
  shifting: {
    physicalRatio: 2.4,
    trainerMassKg: null,
    buttons: {
      shiftUpRight: 'shiftUp',
      shiftDownRight: 'shiftUp',
      shiftUpLeft: 'shiftDown',
      shiftDownLeft: 'shiftDown',
      up: 'gradientUp',
      down: 'gradientDown',
      left: 'steerLeft',
      right: 'steerRight',
      powerUpLeft: 'usePowerUp',
      powerUpRight: 'usePowerUp',
    },
    levers: DEFAULT_LEVERS,
  },
  overlay: {
    visible: true,
    bounds: null,
    backdropOpacity: 0.55,
    tiles: [
      { stat: 'power3s', size: 'l' },
      { stat: 'heartRate', size: 'm' },
      { stat: 'cadence', size: 'm' },
      { stat: 'speed', size: 'm' },
      { stat: 'gear', size: 'm' },
      { stat: 'time', size: 's' },
      { stat: 'distance', size: 's' },
    ],
    showGroup: true,
    editHotkey: 'CommandOrControl+Shift+O',
  },
  group: { useOwnServer: false, signallingUrl: '', relayUrls: [] },
  route: { difficulty: 100 },
  powerUps: { enabled: true, challenges: true },
  ride: { countdownS: 3 },
  watchRelay: DEFAULT_WATCH_RELAY,
};

/**
 * The default until group rides got their setup screen. It only ever worked
 * for trying group rides on one computer, so settings that still hold it are
 * loaded as "not set up" (`migrateSettings` in main/settings.ts).
 */
export const LEGACY_DEFAULT_SIGNALLING_URL = 'ws://localhost:8787';

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface DeviceStatus {
  name: string;
  state: ConnectionState;
}

/** The countdown lengths offered in Settings (0 = off). */
export const COUNTDOWN_CHOICES = [0, 3, 5, 10] as const;
export type CountdownSeconds = (typeof COUNTDOWN_CHOICES)[number];

/**
 * A countdown before the ride starts ('start'), resumes after a pause ('resume') or starts for
 * everyone in a group ('group', the synchronised "Start together"). Nothing is recorded while
 * it runs; the ride starts (or resumes) when it reaches zero.
 */
export interface RideCountdown {
  kind: 'start' | 'resume' | 'group';
  /** Seconds left (fractional; the digit shown is its ceiling). */
  remainingS: number;
  /** Seconds the countdown started from. */
  totalS: number;
}

/** Everything the overlay renders; published by the main window ~4×/s. */
export interface LiveState {
  ride: RideSnapshot;
  devices: Record<DeviceKind, DeviceStatus | null>;
  /** `mode`: how the group ride plays (the host's choice; absent = normal). */
  group: { roomCode: string; riders: GroupRider[]; mode?: GroupMode } | null;
  localName: string;
  /** Present while a structured workout is loaded for the current ride. */
  workout?: WorkoutLive | null;
  /**
   * Steering from the controller levers or held steer buttons, −1 (full left)
   * … 1 (full right); 0 without either.
   */
  steering?: number;
  /** Present while a route is loaded for the current ride. */
  route?: RoutePosition | null;
  /** Present while a route is loaded: how it drives the trainer (see RouteControl). */
  routeControl?: RouteControl | null;
  /** Brake from the controller levers or the brake key, 0 (none) … 1 (full). */
  braking?: number;
  /** Power-ups of the current ride (docs/power-ups.md); absent before the ride starts. */
  powerUps?: PowerUpLive | null;
  /** Energy estimates of the current ride so far (docs/energy.md); absent before the ride. */
  energy?: LiveEnergy | null;
  /** Present while a countdown runs before the ride starts or resumes. */
  countdown?: RideCountdown | null;
}

/**
 * Energy of the ride so far (EnergyTotals of @freilauf/session). `kcal` is the number to show
 * (from power, else from heart rate); null = nothing to show.
 */
export interface LiveEnergy {
  kcal: number | null;
  source: 'power' | 'heartRate' | null;
  kcalPower: number | null;
  kcalHr: number | null;
  fatG: number | null;
  carbG: number | null;
}

/** How a loaded route drives the trainer. */
export interface RouteControl {
  /**
   * Always true while a route is loaded: the route sets the gradient and the manual gradient
   * controls (buttons, keys, `setGradient`) are ignored.
   */
  gradientLocked: true;
  /** Settings.route.difficulty in effect, 0 … 100. */
  difficulty: number;
  /**
   * The gradient last sent to the trainer (road gradient × difficulty, before virtual gearing);
   * null while an ERG workout segment holds the power instead.
   */
  trainerGradePercent: number | null;
  /** Where on the route this ride starts (or started), metres; 0 = the start (docs/routes.md). */
  startM: number;
  /** Jumps along the route during this ride; 0 before the ride. */
  jumps: number;
  /** Where the last jump went (m), or null. */
  lastJumpM: number | null;
}

/** The running workout as shown in the main window and overlay. */
export interface WorkoutLive {
  id: string;
  name: string;
  /** 'erg': the trainer holds targetPowerW. 'free': simulation mode, rider paces. */
  mode: 'erg' | 'free';
  /** e.g. "Interval 3/8 · on" */
  label: string;
  targetPowerW: number | null;
  cadenceRpm?: number;
  elapsedS: number;
  totalDurationS: number;
  segmentElapsedS: number;
  segmentRemainingS: number;
  totalRemainingS: number;
  next?: { label: string; targetPowerW: number | null; durationS: number };
  /** Coaching text to show right now, if any. */
  cue?: string;
  /** 1 = as written; the rider can scale all targets 0.5–1.5. */
  intensity: number;
  finished: boolean;
  /** Set when the workout is an FTP test. */
  ftpTest?: 'twentyMinute' | 'ramp';
  /** False before the ride starts (workout selected, waiting). */
  started: boolean;
}

/** Result of an FTP test, offered to the rider after the ride. */
export interface FtpTestOutcome {
  kind: 'twentyMinute' | 'ramp';
  valid: boolean;
  /** Why the result is not valid, in plain words. */
  reason?: string;
  ftpW: number;
  /** 20-minute average or best one-minute power, depending on the test. */
  basisPowerW: number;
  previousFtpW: number;
}

/** A device offered by Chromium's Bluetooth chooser (select-bluetooth-device). */
export interface PickerDevice {
  id: string;
  name: string;
}

export interface RideListItem {
  id: string;
  name: string;
  startedAt: number;
  durationS: number;
  distanceM: number;
  avgPowerW: number;
  /**
   * Energy from power in kcal (docs/energy.md); absent in lists saved before it existed and
   * for rides without power.
   */
  kcal?: number;
  /** False while the ride is still an autosave of a session in progress or crashed. */
  finished: boolean;
}

/** Exposed by the preload script as `window.freilauf` in both windows. */
export interface FreilaufApi {
  /** True when started with FREILAUF_SIM=1: use simulated devices. */
  readonly simMode: boolean;
  readonly bleLogEnabled: boolean;
  readonly window: 'main' | 'overlay';

  settings: {
    get(): Promise<Settings>;
    /** Deep-merges the patch (arrays replace), persists, broadcasts. Returns the result. */
    update(patch: DeepPartial<Settings>): Promise<Settings>;
    /** Removes a remembered device (a DeepPartial patch cannot delete keys). */
    forgetDevice(kind: DeviceKind): Promise<Settings>;
    onChange(listener: (settings: Settings) => void): () => void;
  };

  live: {
    /** Main window → main process → overlay. */
    publish(state: LiveState): void;
    onState(listener: (state: LiveState) => void): () => void;
  };

  overlay: {
    setEditMode(edit: boolean): void;
    /** Fires on hotkey or setEditMode; also delivers the current value on subscribe. */
    onEditMode(listener: (edit: boolean) => void): () => void;
    /** Overlay window only, in edit mode: custom resize grip (transparent windows have no native one). */
    setBounds(bounds: Bounds): void;
    getBounds(): Promise<Bounds>;
  };

  bluetooth: {
    /**
     * Grants this window a transient user activation so requestDevice() can
     * be called without a click (used for reconnect on start).
     */
    grantUserGesture(): Promise<void>;
    /**
     * Tells main how to answer the NEXT chooser: with a device id, main
     * selects it as soon as it is seen (or cancels after timeoutMs); with
     * null the list is forwarded to onPickerDevices for the user to choose.
     */
    prepareChooser(autoSelect: { deviceId: string; timeoutMs: number } | null): Promise<void>;
    onPickerDevices(listener: (devices: PickerDevice[]) => void): () => void;
    pick(deviceId: string): void;
    cancelPicker(): void;
  };

  rides: {
    list(): Promise<RideListItem[]>;
    /**
     * The full recorded ride (all samples), or null if there is none with that id or its file
     * is unreadable. Used to compute community facts for rides saved before that feature.
     */
    load(id: string): Promise<RecordedRide | null>;
    /** Writes the ride JSON (atomic). Called periodically while riding and once at the end. */
    save(ride: RecordedRide, finished: boolean): Promise<void>;
    /** Encodes and writes the .fit next to the JSON, then offers "Save as…". Returns the path or null. */
    exportFit(id: string): Promise<string | null>;
    delete(id: string): Promise<void>;
    openFolder(): Promise<void>;
  };

  /** Share with my watch (desktop on Windows; the browser build reports it as unavailable). */
  watchRelay: {
    getStatus(): Promise<WatchRelayStatus>;
    /** Fires on every status change; also delivers the current value on subscribe. */
    onStatus(listener: (status: WatchRelayStatus) => void): () => void;
  };

  diagnostics: {
    /**
     * Appends a raw line to the diagnostic log at debug level (source "ble").
     * Kept for compatibility; prefer log().
     */
    bleLog(line: string): void;
    /** Path of the current log file (`userData/logs/freilauf.log`). */
    logFilePath(): Promise<string>;
    /**
     * Writes one event to the always-on diagnostic log. Fire-and-forget,
     * batched; never throws. `source` is a short lowercase tag such as
     * "ble", "ride", "p2p", "renderer". `context` must be JSON-serialisable;
     * it is redacted and truncated before it is written (docs/diagnostics.md).
     */
    log(level: LogLevel, source: string, message: string, context?: LogContext): void;
    /** Where the log files are and how big they are (current file first). */
    getLogInfo(): Promise<LogInfo>;
    /** Opens the log folder in the file manager. */
    openLogFolder(): Promise<void>;
    /**
     * Asks where to save, then writes one text file with the rotated logs and
     * the current one (oldest first, newest last). Returns the path, or null
     * when the user cancelled.
     */
    exportLog(): Promise<string | null>;
    /** The last `maxBytes` (capped at 1 MB) of the log, starting at a line boundary. */
    readRecent(maxBytes: number): Promise<string>;
  };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

export interface LogInfo {
  /** Folder that holds the log files. */
  directory: string;
  /** Current file first, then the rotated ones (newest to oldest). */
  files: { name: string; bytes: number }[];
}
