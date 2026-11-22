import type {
  BlePeripheral,
  BleTransport,
  Controller,
  ControllerButton,
  DeviceKind,
  HeartRateSensor,
  Trainer,
} from '@freilauf/devices';
import { BleHeartRateSensor, FtmsTrainer, ZwiftRideController } from '@freilauf/devices';
import type { SimulatedRig } from '@freilauf/sim';
import { createSimulatedRig } from '@freilauf/sim';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type {
  DeepPartial,
  FtpTestOutcome,
  FreilaufApi,
  LiveState,
  PickerDevice,
  RideListItem,
  Settings,
} from '../../shared/contract';
import { WebBluetoothTransport } from '../ble/webBluetoothTransport';
import { connectErrorNotice } from '../core/connectError';
import { ControllerCapture } from '../core/controllerCapture';
import { DeviceMonitor } from '../core/deviceMonitor';
import { describeError, describeUrl, maskCode } from '../core/logFormat';
import { Logger } from '../core/logger';
import type { ScopedLog } from '../core/logger';
import { RideController } from '../core/rideController';
import type { ShiftSource } from '../core/rideController';
import type { Workout } from '@freilauf/workouts';
import type { GroupLink } from '../core/rideController';
import { decodeWorkout } from '@freilauf/workouts';
import { WorkoutLibrary } from '../core/workoutLibrary';
import type { ImportResult, KeyValueStorage, WorkoutEntry } from '../core/workoutLibrary';
import { CommunityService } from '../core/communityService';
import type {
  CommunityActionResult,
  CommunityGroupLink,
  CommunityView,
  CreateChallengeInput,
  LeaderboardView,
  LeaderboardViewQuery,
} from '../core/communityService';
import type { Visibility } from '@freilauf/community';
import { utf8Length } from '@freilauf/community';

export type GroupStatus =
  | { phase: 'idle' }
  | { phase: 'connecting' }
  | { phase: 'joined'; roomCode: string; joinLink: string }
  | { phase: 'error'; message: string };

export interface Notice {
  id: number;
  kind: 'error' | 'info';
  message: string;
}

export interface AppState {
  ready: boolean;
  simMode: boolean;
  settings: Settings | null;
  live: LiveState | null;
  /** Open while the user is choosing a device to pair. */
  picker: { kind: DeviceKind; devices: PickerDevice[] } | null;
  /** Kinds for which a pairing/reconnect attempt is in flight. */
  busy: Partial<Record<DeviceKind, 'pairing' | 'searching'>>;
  rides: RideListItem[];
  group: GroupStatus;
  notices: Notice[];
  overlayEditMode: boolean;
  /** Sim mode only: the simulated rider's effort in watts. */
  simEffortW: number;
  /** FTP tests, built-in and imported workouts. */
  workouts: WorkoutEntry[];
  /** The workout chosen for the next/current ride; null = free ride. */
  selectedWorkoutId: string | null;
  /** Result of the FTP test just finished, until accepted or dismissed. */
  ftpOutcome: FtpTestOutcome | null;
  /** Workouts other riders in the group are offering. */
  sharedWorkouts: SharedWorkout[];
  /** The workout this rider is offering to the group, if any. */
  sharingWorkoutId: string | null;
  /** Seconds until a synchronised group start; null when none is pending. */
  groupCountdownS: number | null;
  /**
   * Points, totals, friends, leaderboard and challenges (docs/community.md). Replaced only when
   * something visible changed — never by the 4 Hz live tick — and sub-objects keep their
   * identity while unchanged, so selectors like `s => s.community.leaderboard` are cheap.
   */
  community: CommunityView;
  /** The controller button pressed last (live indicator in Settings); null until one is. */
  lastButton: LastButton | null;
}

export interface LastButton {
  button: ControllerButton;
  /** Local clock time of the press. */
  at: number;
}

/** Reports each press (not the release) of a controller button. */
export function watchButtonPresses(
  controller: Pick<Controller, 'onButton'>,
  onPress: (press: LastButton) => void,
  now: () => number = Date.now,
): () => void {
  return controller.onButton((e) => {
    if (e.pressed) onPress({ button: e.button, at: now() });
  });
}

export interface SharedWorkout {
  peerId: string;
  peerName: string;
  workout: Workout;
}

/** Group rides are plugged in from outside so this module stays independent of the p2p wiring. */
export interface GroupConnector {
  create(name: string, signallingUrl: string): Promise<JoinedGroup>;
  join(codeOrLink: string, name: string, signallingUrl: string): Promise<JoinedGroup>;
}
export interface JoinedGroup extends GroupLink, CommunityGroupLink {
  readonly joinLink: string;
  leave(): void;
  /** Offers an encoded workout to the group. Returns null, or why it was refused. */
  shareWorkout(text: string): string | null;
  stopSharingWorkout(): void;
  /** Encoded workouts currently offered by other riders. */
  getSharedWorkouts(): { peerId: string; peerName: string; text: string }[];
  onSharedWorkoutsChange(listener: () => void): () => void;
  /** Tells everyone to start in inMs milliseconds. */
  announceStart(inMs: number): boolean;
  onStart(listener: (startsInMs: number, peerName: string) => void): () => void;
}

/**
 * What the app needs from a Bluetooth transport. `WebBluetoothTransport`
 * (Electron, in-app chooser) is the default; other hosts inject their own
 * through `AppOptions.createTransport` (e.g. the browser build, where the
 * browser shows its own chooser).
 */
export interface AppBluetoothTransport extends BleTransport {
  /**
   * False when the platform shows its own device chooser: the in-app picker
   * (`AppState.picker`) then never opens. Default true.
   */
  readonly usesInAppPicker?: boolean;
  pick?(deviceId: string): void;
  cancelPicker?(): void;
}

export interface AppOptions {
  /** Replaces the default `WebBluetoothTransport` (not used in sim mode). */
  createTransport?: (api: FreilaufApi) => AppBluetoothTransport;
  /** Where imported workouts and community data are kept. Defaults to localStorage; null = memory only. */
  storage?: KeyValueStorage | null;
  /** Clock for the community features (tests). Default Date.now. */
  now?: () => number;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage access denied
  }
}

const TICK_MS = 250;

type AnyDevice = Trainer | HeartRateSensor | Controller;

/**
 * The main window's application object: owns devices, the ride controller
 * and the group, and exposes plain state for React through a zustand store.
 */
export class App {
  readonly #community: CommunityService;
  readonly store: StoreApi<AppState>;
  static #initialState = (community: CommunityView): AppState => ({
    ready: false,
    simMode: false,
    settings: null,
    live: null,
    picker: null,
    busy: {},
    rides: [],
    group: { phase: 'idle' },
    notices: [],
    overlayEditMode: false,
    simEffortW: 180,
    workouts: [],
    selectedWorkoutId: null,
    ftpOutcome: null,
    sharedWorkouts: [],
    sharingWorkoutId: null,
    groupCountdownS: null,
    community,
    lastButton: null,
  });

  readonly #api: FreilaufApi;
  readonly #groupConnector: GroupConnector | null;
  readonly #library: WorkoutLibrary;
  readonly #createTransport: (api: FreilaufApi) => AppBluetoothTransport;
  #transport: AppBluetoothTransport | null = null;
  #controller: RideController | null = null;
  #devices: Partial<Record<DeviceKind, AnyDevice>> = {};
  #rig: SimulatedRig | null = null;
  #group: JoinedGroup | null = null;
  #groupCleanup: (() => void)[] = [];
  /** Local clock time of a pending synchronised start. */
  #startAt: number | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #noticeId = 0;
  #cleanup: (() => void)[] = [];
  /** Diagnostic log (docs/diagnostics.md). */
  readonly #logger: Logger;
  readonly #bleLog: ScopedLog;
  readonly #deviceMonitor: DeviceMonitor;
  #capture: ControllerCapture | null = null;
  #buttonWatch: (() => void) | null = null;
  #lastCaptureFlush = 0;
  #groupPeers = new Set<string>();
  /** At least one other rider was in the group at some point during the current ride. */
  #rideHadCompany = false;

  constructor(
    api: FreilaufApi,
    groupConnector: GroupConnector | null = null,
    options: AppOptions = {},
  ) {
    this.#api = api;
    this.#groupConnector = groupConnector;
    this.#logger = new Logger(api.diagnostics);
    this.#bleLog = this.#logger.scope('ble');
    this.#deviceMonitor = new DeviceMonitor(this.#bleLog);
    this.#createTransport =
      options.createTransport ??
      ((a) => new WebBluetoothTransport(a.bluetooth, undefined, this.#logger.scope('ble')));
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.#library = new WorkoutLibrary(storage);
    this.#community = new CommunityService({
      storage,
      now: options.now,
      log: this.#logger.scope('community'),
      onNotice: (kind, message) => this.notify(kind, message),
    });
    this.store = createStore<AppState>(() => App.#initialState(this.#community.view));
    this.store.setState({ workouts: this.#library.list() });
    this.#community.subscribe((community) => this.store.setState({ community }));
  }

  async init(): Promise<void> {
    const settings = await this.#api.settings.get();
    const simMode = this.#api.simMode;
    this.store.setState({ settings, simMode });
    this.#logger.setSecrets({ riderName: settings.rider.name });
    this.#community.setDisplayName(settings.rider.name);
    this.#logger.log('info', 'renderer', 'main window app starting', {
      simMode,
      userAgent: globalThis.navigator?.userAgent,
      language: globalThis.navigator?.language,
    });

    this.#controller = new RideController({
      settings,
      log: this.#logger.scope('ride'),
      onLive: (live) => {
        this.store.setState({ live });
        this.#api.live.publish(live);
      },
      saveRide: (ride, finished) => this.#api.rides.save(ride, finished),
      onError: (message) => this.notify('error', message),
    });

    this.#cleanup.push(
      this.#api.settings.onChange((next) => {
        this.#logger.setSecrets({ riderName: next.rider.name });
        this.store.setState({ settings: next });
        this.#community.setDisplayName(next.rider.name);
        this.#controller?.updateSettings(next);
      }),
      this.#api.overlay.onEditMode((overlayEditMode) => this.store.setState({ overlayEditMode })),
      this.#api.bluetooth.onPickerDevices((devices) => {
        const picker = this.store.getState().picker;
        if (picker) this.store.setState({ picker: { ...picker, devices } });
      }),
    );

    this.#timer = setInterval(() => {
      this.#tickCountdown();
      this.#controller?.tick();
      this.#tickDiagnostics();
      this.#community.tick(); // no-op until the minute changes
    }, TICK_MS);
    this.store.setState({ ready: true });
    void this.refreshRides().then(() =>
      // Once per installation: rides saved before the community features existed.
      this.#community.backfill(
        { list: () => this.#api.rides.list(), load: (id) => this.#api.rides.load(id) },
        settings.rider.ftpW,
      ),
    );

    if (simMode) {
      this.#startSimulation();
    } else {
      this.#transport = this.#createTransport(this.#api);
      void this.#reconnectRemembered(settings);
    }
  }

  dispose(): void {
    this.#logger.log('info', 'renderer', 'main window closing');
    this.#capture?.flush();
    this.#deviceMonitor.dispose();
    if (this.#timer) clearInterval(this.#timer);
    for (const off of this.#cleanup) off();
    this.#buttonWatch?.();
    this.#community.dispose(); // withdraws its documents and writes pending changes
    this.#group?.leave();
    this.#controller?.dispose();
    void this.#rig?.dispose();
  }

  // ───────────── devices ─────────────

  async pairDevice(kind: DeviceKind): Promise<void> {
    if (!this.#transport || this.store.getState().picker) return;
    // With a platform chooser (browser) the in-app picker must stay closed,
    // or the UI would show an empty modal next to the browser's own dialog.
    if (this.#transport.usesInAppPicker !== false) {
      this.store.setState({ picker: { kind, devices: [] } });
    }
    this.#setBusy(kind, 'pairing');
    const started = Date.now();
    this.#bleLog.info(`pair ${kind}: started`);
    try {
      const peripheral = await this.#transport.requestDevice(kind);
      this.store.setState({ picker: null });
      await this.#attach(kind, peripheral);
      await this.#api.settings.update({
        devices: { [kind]: { id: peripheral.id, name: peripheral.name } },
      });
      this.#bleLog.info(`pair ${kind}: connected "${peripheral.name}"`, {
        id: peripheral.id,
        ms: Date.now() - started,
      });
    } catch (err) {
      // A closed picker (cancel) gives no notice; everything else says what to do.
      const notice = connectErrorNotice(err, kind, 'pair');
      this.#bleLog[notice ? 'error' : 'info'](`pair ${kind}: ${notice ? 'failed' : 'cancelled'}`, {
        ms: Date.now() - started,
        error: describeError(err),
      });
      if (notice) this.notify('error', notice);
    } finally {
      this.store.setState({ picker: null });
      this.#setBusy(kind, null);
    }
  }

  pickDevice(deviceId: string): void {
    this.#transport?.pick?.(deviceId);
  }

  cancelPicker(): void {
    this.#transport?.cancelPicker?.();
  }

  /** Disconnects and forgets the device. */
  async forgetDevice(kind: DeviceKind): Promise<void> {
    await this.#detach(kind);
    await this.#api.settings.forgetDevice(kind);
  }

  /** Looks again for a remembered device that was not found on start. */
  async retryDevice(kind: DeviceKind): Promise<void> {
    const remembered = this.store.getState().settings?.devices[kind];
    if (remembered) await this.#reconnect(kind, remembered.id);
  }

  async #reconnectRemembered(settings: Settings): Promise<void> {
    // Sequential: Chromium allows one chooser at a time (the transport queues anyway).
    for (const kind of ['trainer', 'heartRate', 'controller'] as const) {
      const remembered = settings.devices[kind];
      if (remembered) await this.#reconnect(kind, remembered.id);
    }
  }

  async #reconnect(kind: DeviceKind, id: string): Promise<void> {
    if (!this.#transport || this.#devices[kind] || this.store.getState().busy[kind]) return;
    this.#setBusy(kind, 'searching');
    const started = Date.now();
    this.#bleLog.info(`reconnect ${kind}: looking for remembered device`, { id });
    try {
      const peripheral = await this.#transport.findKnownDevice(kind, id);
      if (!peripheral) {
        this.#bleLog.warn(
          `reconnect ${kind}: not found (off, asleep, out of range or connected elsewhere)`,
          {
            id,
            ms: Date.now() - started,
          },
        );
      }
      if (peripheral) {
        await this.#attach(kind, peripheral);
        // A transport may hand back the device under a new id (the browser
        // build re-pairs through its chooser when it cannot re-acquire it).
        if (peripheral.id !== id) {
          await this.#api.settings.update({
            devices: { [kind]: { id: peripheral.id, name: peripheral.name } },
          });
        }
      }
    } catch (err) {
      const notice = connectErrorNotice(err, kind, 'reconnect');
      this.#bleLog[notice ? 'error' : 'info'](`reconnect ${kind}: failed`, {
        id,
        ms: Date.now() - started,
        error: describeError(err),
      });
      if (notice) this.notify('error', notice);
    } finally {
      this.#setBusy(kind, null);
    }
  }

  async #attach(kind: DeviceKind, peripheral: BlePeripheral): Promise<void> {
    await this.#detach(kind);
    const device = this.#createDriver(kind, peripheral);
    this.#devices[kind] = device;
    this.#setControllerDevice(device);
    this.#deviceMonitor.watch(device);
    try {
      await device.connect();
    } catch (err) {
      await this.#detach(kind);
      throw err;
    }
  }

  #createDriver(kind: DeviceKind, peripheral: BlePeripheral): AnyDevice {
    if (kind === 'trainer') return new FtmsTrainer(peripheral);
    if (kind === 'heartRate') return new BleHeartRateSensor(peripheral);
    const controller = new ZwiftRideController(peripheral);
    // Always-on protocol capture; FREILAUF_BLE_LOG=1 adds every raw frame.
    this.#capture?.flush();
    const capture = new ControllerCapture({
      log: this.#logger.scope('controller'),
      raw: this.#api.bleLogEnabled,
    });
    this.#capture = capture;
    controller.onRawFrame((frame) => capture.frame(frame));
    controller.onBattery((percent) => capture.battery(percent));
    return controller;
  }

  async #detach(kind: DeviceKind): Promise<void> {
    const device = this.#devices[kind];
    if (!device) return;
    delete this.#devices[kind];
    this.#controller?.setDevice(kind, null);
    if (kind === 'controller') this.#capture?.flush();
    this.#bleLog.info(`${kind} "${device.name}": detaching`);
    await device.disconnect().catch(() => undefined);
    this.#deviceMonitor.unwatch(kind);
  }

  #setControllerDevice(device: AnyDevice): void {
    if (device.kind === 'trainer') this.#controller?.setDevice('trainer', device);
    else if (device.kind === 'heartRate') this.#controller?.setDevice('heartRate', device);
    else {
      this.#controller?.setDevice('controller', device);
      this.#buttonWatch?.();
      this.#buttonWatch = watchButtonPresses(device, (lastButton) =>
        this.store.setState({ lastButton }),
      );
    }
  }

  #startSimulation(): void {
    const rig = createSimulatedRig({ trainer: { riderEffortW: this.store.getState().simEffortW } });
    this.#rig = rig;
    this.#bleLog.info('simulation mode: using simulated trainer, heart rate and controller');
    for (const device of [rig.trainer, rig.heartRate, rig.controller]) {
      this.#devices[device.kind] = device;
      this.#setControllerDevice(device);
      this.#deviceMonitor.watch(device);
      device.connect().catch((err: unknown) => {
        this.#bleLog.error(`simulated ${device.kind} failed to connect`, {
          error: describeError(err),
        });
        this.notify('error', errorMessage(err));
      });
    }
  }

  setSimEffort(watts: number): void {
    this.store.setState({ simEffortW: watts });
    this.#rig?.trainer.setRiderEffort(watts);
  }

  /** Sim mode only: drop a simulated device to see the recovery UI. */
  simulateDrop(kind: DeviceKind): void {
    this.#bleLog.info(`simulation: dropping the ${kind} link`);
    this.#rig?.[kind].simulateDrop();
  }

  // ───────────── ride ─────────────

  startRide(): void {
    if (this.#controller?.rideState === 'idle') this.#rideHadCompany = false;
    this.#controller?.start();
  }

  pauseRide(): void {
    this.#controller?.pause();
  }

  async finishRide(): Promise<void> {
    try {
      const groupRide = this.#rideHadCompany || this.#groupPeers.size > 0;
      const ftpW = this.store.getState().settings?.rider.ftpW ?? 0;
      const finished = await this.#controller?.finish();
      this.#rideHadCompany = false;
      // The FTP in force during the ride (an FTP test result is only accepted afterwards).
      if (finished) this.#community.recordRide(finished.ride, { ftpW, groupRide });
      this.store.setState({ selectedWorkoutId: null, ftpOutcome: finished?.ftpTest ?? null });
      if (finished) this.notify('info', 'Ride saved.');
      else this.notify('info', 'Ride was shorter than 10 seconds and was not saved.');
    } catch (err) {
      this.notify('error', `Could not save the ride: ${errorMessage(err)}`);
    }
    await this.refreshRides();
  }

  /** `source` is for the diagnostic log: 'ui' (buttons), 'keyboard', … */
  shift(delta: number, source: ShiftSource = 'ui'): void {
    this.#controller?.shift(delta, source);
  }

  setGradient(gradePercent: number): void {
    this.#controller?.setGradient(gradePercent);
  }

  // ───────────── workouts ─────────────

  /** Chooses the workout for the next ride (null = free ride). Ignored while riding. */
  selectWorkout(id: string | null): boolean {
    const entry = id === null ? null : this.#library.get(id);
    if (id !== null && !entry) return false;
    if (!this.#controller?.selectWorkout(entry?.workout ?? null, entry?.ftpTest ?? null)) {
      this.notify('info', 'Finish the current ride before changing the workout.');
      return false;
    }
    this.store.setState({ selectedWorkoutId: id });
    return true;
  }

  /** Imports a workout from file contents (.zwo or our own format). */
  importWorkout(text: string): ImportResult {
    const result = this.#library.importText(text);
    if (result.ok) this.store.setState({ workouts: this.#library.list() });
    return result;
  }

  deleteWorkout(id: string): void {
    if (this.store.getState().selectedWorkoutId === id && !this.selectWorkout(null)) return;
    if (this.#library.remove(id)) this.store.setState({ workouts: this.#library.list() });
  }

  /** File name and contents for saving or sending a workout. */
  exportWorkout(id: string, format: 'freilauf' | 'zwo'): { fileName: string; text: string } | null {
    return this.#library.export(id, format);
  }

  skipWorkoutSegment(): void {
    this.#controller?.skipWorkoutSegment();
  }

  restartWorkoutSegment(): void {
    this.#controller?.restartWorkoutSegment();
  }

  setWorkoutIntensity(factor: number): void {
    this.#controller?.setWorkoutIntensity(factor);
  }

  /** Saves the FTP test result as the rider's new FTP. */
  async acceptFtpOutcome(): Promise<void> {
    const outcome = this.store.getState().ftpOutcome;
    if (!outcome?.valid) return;
    await this.updateSettings({ rider: { ftpW: outcome.ftpW } });
    this.store.setState({ ftpOutcome: null });
  }

  dismissFtpOutcome(): void {
    this.store.setState({ ftpOutcome: null });
  }

  // ───────────── rides ─────────────

  async refreshRides(): Promise<void> {
    try {
      this.store.setState({ rides: await this.#api.rides.list() });
    } catch (err) {
      this.notify('error', `Could not list rides: ${errorMessage(err)}`);
    }
  }

  async exportFit(id: string): Promise<void> {
    try {
      const path = await this.#api.rides.exportFit(id);
      if (path) this.notify('info', `Exported to ${path}`);
    } catch (err) {
      this.notify('error', `Export failed: ${errorMessage(err)}`);
    }
  }

  async deleteRide(id: string): Promise<void> {
    const deleted = await this.#api.rides.delete(id).then(
      () => true,
      (err: unknown) => {
        this.notify('error', errorMessage(err));
        return false;
      },
    );
    if (deleted) this.#community.removeRide(id);
    await this.refreshRides();
  }

  openRidesFolder(): void {
    void this.#api.rides.openFolder();
  }

  // ───────────── group ─────────────

  async createGroup(): Promise<void> {
    await this.#enterGroup((c, name, url) => c.create(name, url));
  }

  async joinGroup(codeOrLink: string): Promise<void> {
    await this.#enterGroup((c, name, url) => c.join(codeOrLink, name, url));
  }

  leaveGroup(): void {
    if (this.#group)
      this.#logger.log('info', 'p2p', 'left the group', { peers: this.#groupPeers.size });
    this.#groupPeers = new Set();
    for (const off of this.#groupCleanup) off();
    this.#groupCleanup = [];
    this.#community.detach();
    this.#group?.leave();
    this.#group = null;
    this.#startAt = null;
    this.#controller?.setGroup(null);
    this.store.setState({
      group: { phase: 'idle' },
      sharedWorkouts: [],
      sharingWorkoutId: null,
      groupCountdownS: null,
    });
  }

  /** Offers one of the rider's workouts to everyone in the group. */
  shareWorkout(id: string): void {
    const exported = this.#library.export(id, 'freilauf');
    if (!this.#group || !exported) return;
    // The workout takes precedence over community extras (challenges, relays) in the budget.
    this.#community.makeRoom(utf8Length(exported.text));
    const refused = this.#group.shareWorkout(exported.text);
    this.#community.resync();
    if (refused) this.notify('error', `Could not share the workout (${refused}).`);
    else this.store.setState({ sharingWorkoutId: id });
  }

  stopSharingWorkout(): void {
    this.#group?.stopSharingWorkout();
    this.#community.resync();
    this.store.setState({ sharingWorkoutId: null });
  }

  /** Adds a workout offered by another rider to the library and selects it. */
  useSharedWorkout(peerId: string): void {
    const shared = this.store.getState().sharedWorkouts.find((s) => s.peerId === peerId);
    if (!shared) return;
    const added = this.#library.add(shared.workout);
    if (!added.ok) {
      this.notify('error', added.errors.join(' '));
      return;
    }
    this.store.setState({ workouts: this.#library.list() });
    this.selectWorkout(shared.workout.id);
  }

  /** Starts the ride for everyone in the group after a countdown. */
  startTogether(seconds: number): void {
    if (!this.#group || this.#controller?.rideState !== 'idle') return;
    const ms = Math.max(1, Math.min(600, seconds)) * 1000;
    if (!this.#group.announceStart(ms)) {
      this.notify('error', 'Could not announce the start to the group.');
      return;
    }
    this.#startAt = Date.now() + ms;
    this.#tickCountdown();
  }

  cancelGroupStart(): void {
    // Only cancels locally; the others still start.
    this.#startAt = null;
    this.store.setState({ groupCountdownS: null });
  }

  #tickCountdown(): void {
    if (this.#startAt === null) return;
    const remainingMs = this.#startAt - Date.now();
    if (remainingMs > 0) {
      const groupCountdownS = Math.ceil(remainingMs / 1000);
      if (groupCountdownS !== this.store.getState().groupCountdownS) {
        this.store.setState({ groupCountdownS });
      }
      return;
    }
    this.#startAt = null;
    this.store.setState({ groupCountdownS: null });
    if (this.#controller?.rideState === 'idle') this.startRide();
  }

  #refreshSharedWorkouts(): void {
    const sharedWorkouts: SharedWorkout[] = [];
    for (const doc of this.#group?.getSharedWorkouts() ?? []) {
      // Text from another rider: only a workout that validates is shown.
      const decoded = decodeWorkout(doc.text);
      if (decoded.ok) {
        sharedWorkouts.push({
          peerId: doc.peerId,
          peerName: doc.peerName,
          workout: decoded.workout,
        });
      }
    }
    this.store.setState({ sharedWorkouts });
  }

  async #enterGroup(
    enter: (c: GroupConnector, name: string, signallingUrl: string) => Promise<JoinedGroup>,
  ): Promise<void> {
    const settings = this.store.getState().settings;
    if (!this.#groupConnector || !settings || this.store.getState().group.phase === 'connecting') {
      return;
    }
    this.leaveGroup();
    this.store.setState({ group: { phase: 'connecting' } });
    const started = Date.now();
    this.#logger.log('info', 'p2p', 'entering a group', {
      signalling: describeUrl(settings.group.signallingUrl),
    });
    try {
      const group = await enter(
        this.#groupConnector,
        settings.rider.name,
        settings.group.signallingUrl,
      );
      this.#logger.setSecrets({ codes: [group.roomCode] });
      this.#logger.log('info', 'p2p', `joined room ${maskCode(group.roomCode)}`, {
        ms: Date.now() - started,
      });
      this.#group = group;
      this.#controller?.setGroup(group);
      this.#community.attach(group);
      this.#groupCleanup = [
        group.onSharedWorkoutsChange(() => this.#refreshSharedWorkouts()),
        group.onStart((startsInMs, peerName) => {
          // A start only makes sense for someone who is not riding yet.
          if (this.#controller?.rideState !== 'idle') return;
          this.#startAt = Date.now() + Math.max(0, startsInMs);
          this.notify('info', `${peerName} started a group countdown.`);
          this.#tickCountdown();
        }),
      ];
      this.#refreshSharedWorkouts();
      this.store.setState({
        group: { phase: 'joined', roomCode: group.roomCode, joinLink: group.joinLink },
      });
    } catch (err) {
      this.#logger.log('error', 'p2p', 'could not enter the group', {
        ms: Date.now() - started,
        error: describeError(err),
      });
      this.store.setState({ group: { phase: 'error', message: errorMessage(err) } });
    }
  }

  // ───────────── community (docs/community.md) ─────────────
  // State: `state.community` (CommunityView). Every action re-publishes to the group at once
  // and returns `{ ok: true }` or `{ ok: false, error }` with a message for the rider.

  /** Chooses the leaderboard shown in `state.community.leaderboard` (remembered). */
  setLeaderboardView(query: Partial<LeaderboardViewQuery>): CommunityActionResult {
    return this.#community.setLeaderboardView(query);
  }

  /** Any other leaderboard, computed on demand (e.g. a challenge's participants). */
  communityLeaderboard(query: LeaderboardViewQuery): LeaderboardView {
    return this.#community.leaderboard(query);
  }

  /** What a friend may see of me: 'none' | 'totals' | 'everything'. */
  setContactVisibility(riderId: string, visibility: Visibility): CommunityActionResult {
    return this.#community.setContactVisibility(riderId, visibility);
  }

  /** Local name for a friend; null (or '') shows their own name again. */
  renameContact(riderId: string, alias: string | null): CommunityActionResult {
    return this.#community.renameContact(riderId, alias);
  }

  /** Removes a friend — which blocks them (see docs/community.md). */
  removeContact(riderId: string): CommunityActionResult {
    return this.#community.removeContact(riderId);
  }

  unblockContact(riderId: string): CommunityActionResult {
    return this.#community.unblockContact(riderId);
  }

  /** Visibility new friends get on the first shared session (default 'totals'). */
  setDefaultVisibility(visibility: Visibility): void {
    this.#community.setDefaultVisibility(visibility);
  }

  /** "Friends of friends may see my totals" (default off). */
  setFriendsOfFriends(allowed: boolean): void {
    this.#community.setFriendsOfFriends(allowed);
  }

  createChallenge(input: CreateChallengeInput): CommunityActionResult {
    return this.#community.createChallenge(input);
  }

  inviteToChallenge(challengeId: string, riderId: string): CommunityActionResult {
    return this.#community.inviteToChallenge(challengeId, riderId);
  }

  respondToChallenge(
    challengeId: string,
    response: 'accepted' | 'declined',
  ): CommunityActionResult {
    return this.#community.respondToChallenge(challengeId, response);
  }

  leaveChallenge(challengeId: string): CommunityActionResult {
    return this.#community.leaveChallenge(challengeId);
  }

  cancelChallenge(challengeId: string): CommunityActionResult {
    return this.#community.cancelChallenge(challengeId);
  }

  // ───────────── settings / misc ─────────────

  async updateSettings(patch: DeepPartial<Settings>): Promise<void> {
    await this.#api.settings
      .update(patch)
      .catch((err: unknown) =>
        this.notify('error', `Could not save settings: ${errorMessage(err)}`),
      );
  }

  setOverlayEditMode(edit: boolean): void {
    this.#api.overlay.setEditMode(edit);
  }

  notify(kind: Notice['kind'], message: string): void {
    const notices = this.store.getState().notices;
    // The same failure repeating (e.g. every autosave) must not flood the UI.
    if (notices.some((n) => n.message === message)) return;
    this.#logger.log(kind === 'error' ? 'warn' : 'info', 'renderer', `notice shown: ${message}`);
    const notice = { id: ++this.#noticeId, kind, message };
    this.store.setState({ notices: [...notices, notice].slice(-5) });
  }

  dismissNotice(id: number): void {
    this.store.setState({ notices: this.store.getState().notices.filter((n) => n.id !== id) });
  }

  // ───────────── diagnostic log ─────────────

  /** Opens the folder with the log files (browser: explains where the log is). */
  async openLogFolder(): Promise<void> {
    try {
      await this.#api.diagnostics.openLogFolder();
    } catch (err) {
      this.notify('error', `Could not open the log folder: ${errorMessage(err)}`);
    }
  }

  /** Saves the whole log (all rotated files) as one text file. Returns the path, or null. */
  async exportLog(): Promise<string | null> {
    try {
      this.#capture?.flush();
      const path = await this.#api.diagnostics.exportLog();
      if (path) this.notify('info', `Log saved to ${path}`);
      return path;
    } catch (err) {
      this.notify('error', `Could not export the log: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Copies the most recent part of the log to the clipboard. */
  async copyRecentLog(maxBytes = 256 * 1024): Promise<boolean> {
    try {
      this.#capture?.flush();
      const text = await this.#api.diagnostics.readRecent(maxBytes);
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard) throw new Error('the clipboard is not available');
      await clipboard.writeText(text);
      this.notify(
        'info',
        `Copied the last ${Math.max(1, Math.round(text.length / 1024))} KB of the log to the clipboard.`,
      );
      return true;
    } catch (err) {
      this.notify('error', `Could not copy the log: ${errorMessage(err)}`);
      return false;
    }
  }

  /** Periodic device summaries, capture counters and group peer changes. */
  #tickDiagnostics(): void {
    try {
      this.#deviceMonitor.tick();
      const now = Date.now();
      if (now - this.#lastCaptureFlush >= 30_000) {
        this.#lastCaptureFlush = now;
        this.#capture?.flush();
      }
      if (this.#group) {
        const ids = new Set(this.#group.getRiders().map((r) => r.peerId));
        for (const id of ids) {
          if (!this.#groupPeers.has(id)) {
            this.#logger.log('info', 'p2p', `peer connected (${id.slice(0, 6)})`, {
              peers: ids.size,
            });
          }
        }
        for (const id of this.#groupPeers) {
          if (!ids.has(id)) {
            this.#logger.log('info', 'p2p', `peer disconnected (${id.slice(0, 6)})`, {
              peers: ids.size,
            });
          }
        }
        this.#groupPeers = ids;
        if (ids.size > 0 && this.#controller && this.#controller.rideState !== 'idle') {
          this.#rideHadCompany = true;
        }
      }
    } catch {
      // diagnostics must never break the tick
    }
  }

  #setBusy(kind: DeviceKind, value: 'pairing' | 'searching' | null): void {
    const busy = { ...this.store.getState().busy };
    if (value) busy[kind] = value;
    else delete busy[kind];
    this.store.setState({ busy });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
