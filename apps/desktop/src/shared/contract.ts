/**
 * Contract between the Electron main process, the main window and the
 * overlay window. Types only (plus defaults) — importable from all three.
 */
import type { ConnectionState, ControllerButton, DeviceKind } from '@freilauf/devices';
import type { GroupRider } from '@freilauf/p2p';
import type { RecordedRide, RideSnapshot } from '@freilauf/session';

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
  | 'intervalRemaining';

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
};

export interface Settings {
  rider: {
    name: string;
    massKg: number;
    bikeMassKg: number;
    /** Functional threshold power in watts; workouts are scaled by it. */
    ftpW: number;
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
  };
  overlay: OverlaySettings;
  group: { signallingUrl: string };
}

export const DEFAULT_SETTINGS: Settings = {
  rider: { name: 'Rider', massKg: 75, bikeMassKg: 8, ftpW: 200 },
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
    },
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
  group: { signallingUrl: 'ws://localhost:8787' },
};

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface DeviceStatus {
  name: string;
  state: ConnectionState;
}

/** Everything the overlay renders; published by the main window ~4×/s. */
export interface LiveState {
  ride: RideSnapshot;
  devices: Record<DeviceKind, DeviceStatus | null>;
  group: { roomCode: string; riders: GroupRider[] } | null;
  localName: string;
  /** Present while a structured workout is loaded for the current ride. */
  workout?: WorkoutLive | null;
  /** Steering from the controller paddles, −1 (full left) … 1 (full right); 0 without paddles. */
  steering?: number;
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
    /** Writes the ride JSON (atomic). Called periodically while riding and once at the end. */
    save(ride: RecordedRide, finished: boolean): Promise<void>;
    /** Encodes and writes the .fit next to the JSON, then offers "Save as…". Returns the path or null. */
    exportFit(id: string): Promise<string | null>;
    delete(id: string): Promise<void>;
    openFolder(): Promise<void>;
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
