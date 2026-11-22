import type {
  BlePeripheral,
  BleTransport,
  Controller,
  DeviceKind,
  HeartRateSensor,
  Trainer,
} from '@freilauf/devices';
import { BleHeartRateSensor, FtmsTrainer, ZwiftRideController } from '@freilauf/devices';
import type { SimulatedRig } from '@freilauf/sim';
import { createSimulatedRig } from '@freilauf/sim';
import { createStore } from 'zustand/vanilla';
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
import { RideController } from '../core/rideController';
import type { GroupLink } from '../core/rideController';
import { WorkoutLibrary } from '../core/workoutLibrary';
import type { ImportResult, KeyValueStorage, WorkoutEntry } from '../core/workoutLibrary';

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
}

/** Group rides are plugged in from outside so this module stays independent of the p2p wiring. */
export interface GroupConnector {
  create(name: string, signallingUrl: string): Promise<JoinedGroup>;
  join(codeOrLink: string, name: string, signallingUrl: string): Promise<JoinedGroup>;
}
export interface JoinedGroup extends GroupLink {
  readonly joinLink: string;
  leave(): void;
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
  /** Where imported workouts are kept. Defaults to localStorage; null = memory only. */
  storage?: KeyValueStorage | null;
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
  readonly store = createStore<AppState>(() => ({
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
  }));

  readonly #api: FreilaufApi;
  readonly #groupConnector: GroupConnector | null;
  readonly #library: WorkoutLibrary;
  readonly #createTransport: (api: FreilaufApi) => AppBluetoothTransport;
  #transport: AppBluetoothTransport | null = null;
  #controller: RideController | null = null;
  #devices: Partial<Record<DeviceKind, AnyDevice>> = {};
  #rig: SimulatedRig | null = null;
  #group: JoinedGroup | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #noticeId = 0;
  #cleanup: (() => void)[] = [];

  constructor(
    api: FreilaufApi,
    groupConnector: GroupConnector | null = null,
    options: AppOptions = {},
  ) {
    this.#api = api;
    this.#groupConnector = groupConnector;
    this.#createTransport =
      options.createTransport ?? ((a) => new WebBluetoothTransport(a.bluetooth));
    this.#library = new WorkoutLibrary(
      options.storage === undefined ? defaultStorage() : options.storage,
    );
    this.store.setState({ workouts: this.#library.list() });
  }

  async init(): Promise<void> {
    const settings = await this.#api.settings.get();
    const simMode = this.#api.simMode;
    this.store.setState({ settings, simMode });

    this.#controller = new RideController({
      settings,
      onLive: (live) => {
        this.store.setState({ live });
        this.#api.live.publish(live);
      },
      saveRide: (ride, finished) => this.#api.rides.save(ride, finished),
      onError: (message) => this.notify('error', message),
    });

    this.#cleanup.push(
      this.#api.settings.onChange((next) => {
        this.store.setState({ settings: next });
        this.#controller?.updateSettings(next);
      }),
      this.#api.overlay.onEditMode((overlayEditMode) => this.store.setState({ overlayEditMode })),
      this.#api.bluetooth.onPickerDevices((devices) => {
        const picker = this.store.getState().picker;
        if (picker) this.store.setState({ picker: { ...picker, devices } });
      }),
    );

    this.#timer = setInterval(() => this.#controller?.tick(), TICK_MS);
    this.store.setState({ ready: true });
    void this.refreshRides();

    if (simMode) {
      this.#startSimulation();
    } else {
      this.#transport = this.#createTransport(this.#api);
      void this.#reconnectRemembered(settings);
    }
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    for (const off of this.#cleanup) off();
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
    try {
      const peripheral = await this.#transport.requestDevice(kind);
      this.store.setState({ picker: null });
      await this.#attach(kind, peripheral);
      await this.#api.settings.update({
        devices: { [kind]: { id: peripheral.id, name: peripheral.name } },
      });
    } catch (err) {
      // NotFoundError = the user closed the picker; not worth a message.
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
        this.notify('error', `Could not connect: ${errorMessage(err)}`);
      }
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
    try {
      const peripheral = await this.#transport.findKnownDevice(kind, id);
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
      this.notify('error', `Could not reconnect ${kind}: ${errorMessage(err)}`);
    } finally {
      this.#setBusy(kind, null);
    }
  }

  async #attach(kind: DeviceKind, peripheral: BlePeripheral): Promise<void> {
    await this.#detach(kind);
    const device = this.#createDriver(kind, peripheral);
    this.#devices[kind] = device;
    this.#setControllerDevice(device);
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
    if (this.#api.bleLogEnabled) {
      controller.onRawFrame((frame) => {
        const hex = [...frame.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        this.#api.diagnostics.bleLog(`controller ${frame.characteristic} ${hex}`);
      });
    }
    return controller;
  }

  async #detach(kind: DeviceKind): Promise<void> {
    const device = this.#devices[kind];
    if (!device) return;
    delete this.#devices[kind];
    this.#controller?.setDevice(kind, null);
    await device.disconnect().catch(() => undefined);
  }

  #setControllerDevice(device: AnyDevice): void {
    if (device.kind === 'trainer') this.#controller?.setDevice('trainer', device);
    else if (device.kind === 'heartRate') this.#controller?.setDevice('heartRate', device);
    else this.#controller?.setDevice('controller', device);
  }

  #startSimulation(): void {
    const rig = createSimulatedRig({ trainer: { riderEffortW: this.store.getState().simEffortW } });
    this.#rig = rig;
    for (const device of [rig.trainer, rig.heartRate, rig.controller]) {
      this.#devices[device.kind] = device;
      this.#setControllerDevice(device);
      device.connect().catch((err: unknown) => this.notify('error', errorMessage(err)));
    }
  }

  setSimEffort(watts: number): void {
    this.store.setState({ simEffortW: watts });
    this.#rig?.trainer.setRiderEffort(watts);
  }

  /** Sim mode only: drop a simulated device to see the recovery UI. */
  simulateDrop(kind: DeviceKind): void {
    this.#rig?.[kind].simulateDrop();
  }

  // ───────────── ride ─────────────

  startRide(): void {
    this.#controller?.start();
  }

  pauseRide(): void {
    this.#controller?.pause();
  }

  async finishRide(): Promise<void> {
    try {
      const finished = await this.#controller?.finish();
      this.store.setState({ selectedWorkoutId: null, ftpOutcome: finished?.ftpTest ?? null });
      if (finished) this.notify('info', 'Ride saved.');
      else this.notify('info', 'Ride was shorter than 10 seconds and was not saved.');
    } catch (err) {
      this.notify('error', `Could not save the ride: ${errorMessage(err)}`);
    }
    await this.refreshRides();
  }

  shift(delta: number): void {
    this.#controller?.shift(delta);
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
    await this.#api.rides
      .delete(id)
      .catch((err: unknown) => this.notify('error', errorMessage(err)));
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
    this.#group?.leave();
    this.#group = null;
    this.#controller?.setGroup(null);
    this.store.setState({ group: { phase: 'idle' } });
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
    try {
      const group = await enter(
        this.#groupConnector,
        settings.rider.name,
        settings.group.signallingUrl,
      );
      this.#group = group;
      this.#controller?.setGroup(group);
      this.store.setState({
        group: { phase: 'joined', roomCode: group.roomCode, joinLink: group.joinLink },
      });
    } catch (err) {
      this.store.setState({ group: { phase: 'error', message: errorMessage(err) } });
    }
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
    const notice = { id: ++this.#noticeId, kind, message };
    this.store.setState({ notices: [...notices, notice].slice(-5) });
  }

  dismissNotice(id: number): void {
    this.store.setState({ notices: this.store.getState().notices.filter((n) => n.id !== id) });
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
