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
  GhostChoice,
  FreilaufApi,
  LiveState,
  PickerDevice,
  RideListItem,
  Settings,
  WatchRelayStatus,
} from '../../shared/contract';
import { WebBluetoothTransport } from '../ble/webBluetoothTransport';
import { connectErrorNotice } from '../core/connectError';
import {
  classifyGroupError,
  describeGroupFailure,
  groupNotes,
  peerViews,
  relayStateFrom,
  resolveHostTarget,
  resolveJoinTarget,
} from '../core/groupConnection';
import type {
  GroupFailure,
  GroupNote,
  HostTarget,
  JoinTarget,
  PeerSample,
  PeerView,
  RelayLinkState,
} from '../core/groupConnection';
import { probeSignallingServer } from '../core/signallingProbe';
import type { ProbeResult } from '../core/signallingProbe';
import { ControllerCapture } from '../core/controllerCapture';
import { DeviceMonitor } from '../core/deviceMonitor';
import { describeError, describeUrl, maskCode } from '../core/logFormat';
import { Logger } from '../core/logger';
import type { ScopedLog } from '../core/logger';
import { RideController } from '../core/rideController';
import type { ShiftSource } from '../core/rideController';
import type { EpisodeOptions, EpisodePlan, Workout } from '@freilauf/workouts';
import type { GroupLink } from '../core/rideController';
import type { GroupRules } from '@freilauf/p2p';
import type { GroupMode } from '../../shared/powerUps';
import {
  decodeWorkout,
  generateEpisodeWorkout,
  isEpisodeWorkoutId,
  normalizeEpisodeOptions,
} from '@freilauf/workouts';
import { WorkoutLibrary } from '../core/workoutLibrary';
import type { RouteTrack, SceneryModel, WindProfile } from '@freilauf/routes';
import {
  DEFAULT_WEATHER_START,
  formatWeatherSpan,
  routeTimesSpan,
  weatherDayLabel,
  windConditionsKey,
} from '@freilauf/routes';
import { matchTrackToRoute, routeBaseId } from '@freilauf/routes';
import type { GhostTrace, RecordedRide } from '@freilauf/session';
import { decodeFitTrack, downsampleTrace, rideGhost, rideRouteInfo } from '@freilauf/session';
import type { GhostCandidate, GhostResult } from '../core/ghost';
import {
  bestGhost,
  clockTime,
  ghostCandidates,
  ghostLabel,
  resolveGhostChoice,
} from '../core/ghost';
import { RouteLibrary } from '../core/routeLibrary';
import type { RouteEntry, RouteImportResult } from '../core/routeLibrary';
import { decodeSharedRoutes, shareRouteInGroup } from '../core/routeSharing';
import { SceneryService, type SceneryStatus } from '../core/sceneryService';
import { WeatherService, type WeatherStatus } from '../core/weatherService';
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
import { lowBatteryNotice } from './batteryStatus';
import { summarizeRide } from './rideSummary';
import type { RideSummary } from './rideSummary';

export type { RouteEntry, RouteImportResult } from '../core/routeLibrary';
export type { SceneryStatus } from '../core/sceneryService';
export type { WeatherStatus } from '../core/weatherService';
export type { RideBest, RideSummary } from './rideSummary';

/** A route another rider in the group is offering. */
export interface SharedRoute {
  peerId: string;
  peerName: string;
  entry: RouteEntry;
}

export type GroupStatus =
  | { phase: 'idle' }
  | { phase: 'connecting'; action: 'create' | 'join' }
  | {
      phase: 'joined';
      roomCode: string;
      /** The invite: `freilauf://join/<CODE>#<SECRET>` (own server: `…<CODE>?s=<server>`). */
      joinLink: string;
      /** The invite to read out: `ABC-DEF-GHJK-MNPQ-RSTU` (own server: `ABC-DEF`). */
      inviteCode: string;
      /** Public relays (default) or an own signalling server. */
      transport: 'relays' | 'self-hosted';
      /** Relay rides: whether the relays are reached yet. Own server: always 'ready'. */
      relay: RelayLinkState;
      /** Created the room (host) or joined it (guest). */
      role: 'host' | 'guest';
      /** Own server only: the server the room lives on (for a guest with a link: the host's). */
      signallingUrl: string;
      /** The other riders in the room and whether a direct connection exists. */
      peers: PeerView[];
      /** Non-fatal trouble of the last minute (wrong secret, no direct path, …). */
      notes: GroupNote[];
    }
  | {
      phase: 'error';
      /** Headline and explanation in one line (notices, logs). */
      message: string;
      failure: GroupFailure;
      /** What was tried, so the Group tab can offer it again. */
      action: 'create' | 'join';
      input: string;
    };

export interface Notice {
  id: number;
  /** info fades on its own, warn after a while, error stays until dismissed. */
  kind: 'error' | 'warn' | 'info';
  message: string;
}

/** Simulation mode: power-up spacing and challenge windows for tests (see `#powerUpTuning`). */
export const POWER_UP_TUNING_KEY = 'freilauf.powerUps.tuning';

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
  /**
   * The workout fitted to an episode, when that is the selected one (docs/workouts.md); kept up
   * to date when "hard now" re-fits it during the ride.
   */
  episodePlan?: EpisodePlan | null;
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
  /**
   * Where the two analog levers are, −1 … 1 (live lever display in Settings).
   * Null without a controller. Updated at most every LEVER_UPDATE_MS, so it is
   * safe to select narrowly (`s => s.levers?.left`).
   */
  levers: LeverPositionsState | null;
  /** Built-in and imported routes (docs/routes.md). */
  routes: RouteEntry[];
  /** The route chosen for the next/current ride; null = none (free road). */
  selectedRouteId: string | null;
  /** The full track of the selected route (scene, map); null without one. */
  routeTrack: RouteTrack | null;
  /** Routes other riders in the group are offering. */
  sharedRoutes: SharedRoute[];
  /** The route this rider is offering to the group, if any. */
  sharingRouteId: string | null;
  /** What the ride finished last came to (post-ride summary); null before the first finish. */
  lastRide: RideSummary | null;
  /** Share with my watch: what the relay is doing (main process; unavailable in the browser). */
  watchRelay?: WatchRelayStatus;
  /** The host's switch: power-ups allowed in the group ride this rider creates (default on). */
  groupPowerUps?: boolean;
  /** The host's choice: how the group ride this rider creates plays (default normal). */
  groupMode?: GroupMode;
  /** The ghost rider of the selected route (docs/ghost.md); absent = none. */
  ghost?: GhostState;
  /**
   * Scenery along routes (docs/routes.md): what is stored or being loaded, per route id
   * (routes without any are absent).
   */
  scenery?: Record<string, SceneryStatus>;
  /** The selected route's stored scenery, for the ride scenes; null without one. */
  routeScenery?: SceneryModel | null;
  /**
   * The weather of a day along routes (docs/routes.md, "The weather of that day"): what is
   * stored or being loaded, per route id (absent = none).
   */
  weather?: Record<string, WeatherStatus>;
  /** The selected route's stored wind profile (whether or not it is ridden with); null = none. */
  routeWind?: WindProfile | null;
}

/** What the start screen offers and the next ride races as a ghost. */
export interface GhostState {
  /** routeBaseId of the selected route; null without a route (no ghost on a free ride). */
  routeId: string | null;
  /** Earlier rides of the route that can be raced, newest first. */
  candidates: GhostCandidate[];
  /** The fastest full ride among them in the next ride's conditions, if any. */
  bestRideId: string | null;
  /** The next ride's conditions: the wind's key, or null without wind (absent = null). */
  conditions?: string | null;
  /** The choice in effect: remembered per route, or 'import' while a ride file is used. */
  choice: GhostChoice | 'import';
  /** What the next ride races; null = no ghost. */
  active: {
    kind: 'best' | 'last' | 'ride' | 'import';
    rideId: string | null;
    label: string;
  } | null;
  /** A ride file imported for this route (kept in memory only, never stored). */
  imported: { name: string; label: string; note: string | null } | null;
  loading: boolean;
  /** Why the last import or load failed, in plain words. */
  error: string | null;
}

export const NO_GHOST: GhostState = {
  routeId: null,
  candidates: [],
  bestRideId: null,
  choice: 'best',
  active: null,
  imported: null,
  loading: false,
  error: null,
};

/** Ghost traces kept in memory (from stored rides), most recently used last. */
const GHOST_CACHE_SIZE = 8;

export interface LeverPositionsState {
  left: number;
  right: number;
  /** Local clock time of the last change. */
  at: number;
}

/** The lever display in Settings updates at most this often (20 Hz). */
export const LEVER_UPDATE_MS = 50;

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

export interface WatchLeversOptions {
  now?: () => number;
  /** Minimum time between two reports; the last position is always reported (trailing). */
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Reports the lever positions, throttled to one report per `intervalMs`
 * (the final position of a movement is never lost). When the controller is
 * no longer connected, the levers are reported at rest at once.
 */
export function watchLevers(
  controller: Pick<Controller, 'onPaddle' | 'onState'>,
  onChange: (levers: LeverPositionsState) => void,
  options: WatchLeversOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? LEVER_UPDATE_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pos = { left: 0, right: 0 };
  let reported = { left: 0, right: 0 };
  let lastReport = -Infinity;
  let timer: unknown = null;
  const report = (): void => {
    timer = null;
    if (pos.left === reported.left && pos.right === reported.right) return;
    lastReport = now();
    reported = { ...pos };
    onChange({ left: pos.left, right: pos.right, at: lastReport });
  };
  const offPaddle = controller.onPaddle(({ side, value }) => {
    pos[side] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    if (timer !== null) return;
    const wait = lastReport + interval - now();
    if (wait <= 0) report();
    else timer = setTimer(report, wait);
  });
  const offState = controller.onState((state) => {
    if (state === 'connected') return;
    pos.left = 0;
    pos.right = 0;
    if (timer !== null) clearTimer(timer);
    report();
  });
  return () => {
    offPaddle();
    offState();
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}

export interface SharedWorkout {
  peerId: string;
  peerName: string;
  workout: Workout;
}

/** Group rides are plugged in from outside so this module stays independent of the p2p wiring. */
export interface GroupConnector {
  create(name: string, target: HostTarget): Promise<JoinedGroup>;
  join(target: JoinTarget, name: string): Promise<JoinedGroup>;
}

/** A line for the diagnostic log from the group's transport. */
export interface GroupLogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, string | number | boolean | null | string[]>;
}

export interface JoinedGroup extends GroupLink, CommunityGroupLink {
  readonly joinLink: string;
  readonly inviteCode?: string;
  /** Relay rides: the invite secret (masked in the log). */
  readonly secret?: string;
  readonly transport?: 'relays' | 'self-hosted';
  /** 'connecting' | 'joined' | 'reconnecting' | 'closed' (see GroupRide.signallingState). */
  getConnectionState?(): string;
  /** Codes of non-fatal problems of the last minute (GroupRide.getProblems). */
  getProblems?(): string[];
  /** The group ended by itself (e.g. no relay reachable). */
  onFailure?(listener: (failure: { code: string; message: string }) => void): () => void;
  onLog?(listener: (line: GroupLogLine) => void): () => void;
  /** Connection status of every other rider in the room (for the Group tab). */
  getPeerStatuses?(): PeerSample[];
  leave(): void;
  /** Offers an encoded route to the group. Returns null, or why it was refused. */
  shareRoute?(text: string): string | null;
  stopSharingRoute?(): void;
  /** Encoded routes currently offered by other riders. */
  getSharedRoutes?(): { peerId: string; peerName: string; text: string }[];
  onSharedRoutesChange?(listener: () => void): () => void;
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
  /** "Test connection" for a signalling server (tests). Default: a real WebSocket probe. */
  probeSignalling?: (url: string) => Promise<ProbeResult>;
  /** Scenery fetch tuning (tests: no pauses or backoff). */
  sceneryFetch?: Partial<import('@freilauf/routes').FetchSceneryOptions>;
  /** Weather fetch tuning (tests: no pauses or backoff, a fixed clock). */
  weatherFetch?: Partial<import('@freilauf/routes').FetchWeatherOptions>;
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
    episodePlan: null,
    ftpOutcome: null,
    sharedWorkouts: [],
    sharingWorkoutId: null,
    groupCountdownS: null,
    community,
    lastButton: null,
    levers: null,
    routes: [],
    selectedRouteId: null,
    routeTrack: null,
    sharedRoutes: [],
    sharingRouteId: null,
    lastRide: null,
    watchRelay: { state: 'off' },
    groupPowerUps: true,
    groupMode: 'normal',
    ghost: NO_GHOST,
    scenery: {},
    routeScenery: null,
    weather: {},
    routeWind: null,
  });

  readonly #api: FreilaufApi;
  readonly #groupConnector: GroupConnector | null;
  readonly #library: WorkoutLibrary;
  /** The episode plan revision last taken from the live state. */
  #episodeRevision = 0;
  readonly #routes: RouteLibrary;
  /** Decoded routes offered by the group, by peer (for useSharedRoute). */
  #sharedRouteTracks = new Map<string, RouteTrack>();
  readonly #createTransport: (api: FreilaufApi) => AppBluetoothTransport;
  readonly #probeSignalling: (url: string) => Promise<ProbeResult>;
  /** When each not-yet-connected group peer was first seen (see `peerViews`). */
  #peerFirstSeen = new Map<string, number>();
  #transport: AppBluetoothTransport | null = null;
  #controller: RideController | null = null;
  #devices: Partial<Record<DeviceKind, AnyDevice>> = {};
  #rig: SimulatedRig | null = null;
  #group: JoinedGroup | null = null;
  #groupCleanup: (() => void)[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #noticeId = 0;
  #cleanup: (() => void)[] = [];
  /** Diagnostic log (docs/diagnostics.md). */
  readonly #logger: Logger;
  readonly #bleLog: ScopedLog;
  readonly #deviceMonitor: DeviceMonitor;
  #capture: ControllerCapture | null = null;
  #buttonWatch: (() => void) | null = null;
  #leverWatch: (() => void) | null = null;
  #lastCaptureFlush = 0;
  #groupPeers = new Set<string>();
  /** At least one other rider was in the group at some point during the current ride. */
  #rideHadCompany = false;
  /** Ghost traces of stored rides by ride id (memory only; see GHOST_CACHE_SIZE). */
  #ghostTraces = new Map<string, GhostTrace | null>();
  /** The imported ride file's trace, for the route it was matched to (memory only). */
  #importedGhost: { routeId: string; trace: GhostTrace } | null = null;
  /** Increases with every ghost refresh, so a slow load cannot overwrite a newer choice. */
  #ghostToken = 0;
  /** Scenery along routes (docs/adr/0011-osm-scenery.md). */
  readonly #scenery: SceneryService;
  #sceneryToken = 0;
  /** The weather of a day along routes (docs/adr/0012-historical-wind.md). */
  readonly #weather: WeatherService;

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
    this.#probeSignalling =
      options.probeSignalling ??
      ((url) => probeSignallingServer(url, { online: () => globalThis.navigator?.onLine }));
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.#library = new WorkoutLibrary(storage);
    this.#routes = new RouteLibrary(storage);
    this.#community = new CommunityService({
      storage,
      now: options.now,
      log: this.#logger.scope('community'),
      onNotice: (kind, message) => this.notify(kind, message),
    });
    this.store = createStore<AppState>(() => App.#initialState(this.#community.view));
    this.#scenery = new SceneryService({
      api: api.scenery,
      log: this.#logger.scope('scenery'),
      onStatus: (scenery) => {
        this.store.setState({ scenery });
        // Loaded (or removed) for the selected route: the scenes pick it up.
        const id = this.store.getState().selectedRouteId;
        if (id && (scenery[id]?.state ?? 'none') !== (this.#sceneryShown ?? 'none'))
          void this.#refreshRouteScenery();
      },
      onNotice: (kind, message) => this.notify(kind, message),
      ...(options.sceneryFetch ? { fetchOptions: options.sceneryFetch } : {}),
    });
    this.#weather = new WeatherService({
      api: api.weather,
      storage,
      log: this.#logger.scope('weather'),
      onStatus: (weather) => {
        const id = this.store.getState().selectedRouteId;
        const before = id ? (this.store.getState().weather?.[id]?.state ?? 'none') : 'none';
        this.store.setState({ weather });
        // Loaded (or removed) for the selected route: the next ride picks it up.
        if (id && (weather[id]?.state ?? 'none') !== before) {
          this.#refreshRouteWind();
          void this.#refreshGhost();
        }
      },
      onNotice: (kind, message) => this.notify(kind, message),
      ...(options.weatherFetch ? { fetchOptions: options.weatherFetch } : {}),
    });
    this.store.setState({ workouts: this.#library.list(), routes: this.#routes.list() });
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
        // The group's "Start together" countdown runs in the controller like the local one.
        const groupCountdownS =
          live.countdown?.kind === 'group' ? Math.ceil(live.countdown.remainingS) : null;
        // "Hard now" re-fitted the episode workout: its chart follows.
        const revision = live.workout?.episode?.revision;
        const episodePlan =
          revision !== undefined && revision !== this.#episodeRevision
            ? (this.#controller?.episodePlan ?? null)
            : undefined;
        if (revision !== undefined) this.#episodeRevision = revision;
        if (groupCountdownS !== this.store.getState().groupCountdownS) {
          this.store.setState({ live, groupCountdownS, ...(episodePlan ? { episodePlan } : {}) });
        } else this.store.setState({ live, ...(episodePlan ? { episodePlan } : {}) });
        this.#api.live.publish(live);
      },
      onRideStart: () => {
        // Every new ride, however it was started (button, Space, controller, group countdown).
        this.#rideHadCompany = false;
        this.#controller?.setPowerUpTuning(this.#powerUpTuning());
        // Once per ride, at its start: a device that may not last the ride.
        const lowBattery = lowBatteryNotice(this.#devices);
        if (lowBattery) this.notify('warn', lowBattery);
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
        this.#refreshRouteWind();
        void this.#refreshGhost();
      }),
      this.#api.overlay.onEditMode((overlayEditMode) => this.store.setState({ overlayEditMode })),
      this.#api.watchRelay.onStatus((watchRelay) => this.store.setState({ watchRelay })),
      this.#api.bluetooth.onPickerDevices((devices) => {
        const picker = this.store.getState().picker;
        if (picker) this.store.setState({ picker: { ...picker, devices } });
      }),
    );

    this.#timer = setInterval(() => {
      this.#controller?.tick();
      this.#tickDiagnostics();
      this.#refreshPeers(); // "connecting" turns into "trouble" after a while
      this.#community.tick(); // no-op until the minute changes
    }, TICK_MS);
    this.store.setState({ ready: true });
    void this.#scenery.init().then(() => this.#refreshRouteScenery());
    this.#weather.init(this.#routes.list().map((e) => e.id));
    this.#refreshRouteWind();
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
    this.#leverWatch?.();
    this.#scenery.dispose();
    this.#weather.dispose();
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
    // Battery levels are logged by the device monitor (all devices), with the raw frame here.
    controller.onRawFrame((frame) => capture.frame(frame));
    return controller;
  }

  async #detach(kind: DeviceKind): Promise<void> {
    const device = this.#devices[kind];
    if (!device) return;
    delete this.#devices[kind];
    this.#controller?.setDevice(kind, null);
    if (kind === 'controller') {
      this.#capture?.flush();
      this.#leverWatch?.();
      this.#leverWatch = null;
      this.store.setState({ levers: null });
    }
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
      this.#leverWatch?.();
      this.store.setState({ levers: { left: 0, right: 0, at: Date.now() } });
      this.#leverWatch = watchLevers(device, (levers) => this.store.setState({ levers }));
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

  /** Sim mode only: move a simulated lever (−1 … 1), as if the rider held it there. */
  setSimLever(side: 'left' | 'right', value: number): void {
    this.#rig?.controller.setPaddle(side, value);
  }

  /**
   * Sim mode only: a simulated device's battery level in % (null: none). `side` sets one
   * controller grip.
   */
  setSimBattery(kind: DeviceKind, percent: number | null, side?: 'left' | 'right'): void {
    this.#rig?.[kind].setBattery(percent, side);
  }

  /** Sim mode only: drop a simulated device to see the recovery UI. */
  simulateDrop(kind: DeviceKind): void {
    this.#bleLog.info(`simulation: dropping the ${kind} link`);
    this.#rig?.[kind].simulateDrop();
  }

  // ───────────── ride ─────────────

  /**
   * Start / Resume: after the countdown in Settings.ride (0 = at once). Asked again while a
   * countdown runs (also a group's), it cancels the countdown instead.
   */
  startRide(): void {
    this.#controller?.requestStart();
  }

  /** Pauses at once; during a countdown, cancels it. */
  pauseRide(): void {
    this.#controller?.pause();
  }

  /** Cancels a running countdown (Escape); false when none runs. */
  cancelCountdown(): boolean {
    return this.#controller?.cancelCountdown() ?? false;
  }

  async finishRide(): Promise<void> {
    this.store.setState({ lastRide: null });
    try {
      const groupRide = this.#rideHadCompany || this.#groupPeers.size > 0;
      const before = this.store.getState();
      const ftpW = before.settings?.rider.ftpW ?? 0;
      const finished = await this.#controller?.finish();
      this.#rideHadCompany = false;
      // The FTP in force during the ride (an FTP test result is only accepted afterwards).
      if (finished) this.#community.recordRide(finished.ride, { ftpW, groupRide });
      const rides = this.#community.state.ledger.rides;
      const lastRide = summarizeRide({
        live: before.live?.ride ?? null,
        ride: finished?.ride ?? null,
        facts: finished ? (rides[finished.ride.id] ?? null) : null,
        previous: Object.values(rides),
        workoutName: before.live?.workout?.name ?? null,
        routeName: before.routeTrack?.name ?? null,
        rider: before.settings?.rider ?? null,
        ghost: finished?.ghost ?? null,
        routeTime: routeTimeOf(finished?.ride ?? null, before.ghost?.candidates ?? []),
        windLabel: finished?.ride.route?.weather?.label ?? null,
        powerUpGainM: finished?.powerUps?.raceOffsetM ?? before.live?.powerUps?.raceOffsetM ?? 0,
        rumble:
          finished?.powerUps?.mode === 'rumble'
            ? { gainM: finished.powerUps.gainM ?? 0, lossM: finished.powerUps.lossM ?? 0 }
            : before.live?.powerUps?.rumble
              ? {
                  gainM: before.live.powerUps.rumble.gainM,
                  lossM: before.live.powerUps.rumble.lossM,
                }
              : null,
      });
      this.store.setState({
        selectedWorkoutId: null,
        episodePlan: null,
        ftpOutcome: finished?.ftpTest ?? null,
        lastRide,
      });
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

  /** Manual gradient; ignored while a route is loaded (LiveState.routeControl). */
  setGradient(gradePercent: number): void {
    this.#controller?.setGradient(gradePercent);
  }

  /** Brake key held (true) or released (false). Slows the virtual bike only. */
  setBrakeKey(held: boolean): void {
    this.#controller?.setBrake(held ? 1 : 0, 'keyboard');
  }

  // ───────────── power-ups (docs/power-ups.md) ─────────────

  /** Uses the held power-up (P key, the on-screen item). */
  usePowerUp(source: ShiftSource = 'ui'): boolean {
    return this.#controller?.usePowerUp(source) ?? false;
  }

  /** Rumble: uses the left (0) or right (1) item (P / L, the on-screen slots). */
  useItem(slot: number, source: ShiftSource = 'ui'): boolean {
    return this.#controller?.useItem(slot, source) ?? false;
  }

  dismissPowerUpChallenge(): void {
    this.#controller?.dismissPowerUpChallenge();
  }

  /** The host's switch for the group ride (only the host's counts; see GroupRules). */
  setGroupPowerUps(on: boolean): void {
    this.store.setState({ groupPowerUps: on });
    this.#sendHostRules();
  }

  /**
   * The host's choice of mode (docs/rumble.md): before creating the ride, for the ride to
   * be created; as the host of a ride, for everyone at once. Guests cannot change it.
   */
  setGroupMode(mode: GroupMode): void {
    this.store.setState({ groupMode: mode });
    this.#sendHostRules();
  }

  /** The rules this rider sends as the host (none as a guest or alone). */
  #hostRules(): GroupRules {
    const s = this.store.getState();
    return { powerUps: s.groupPowerUps !== false, mode: s.groupMode ?? 'normal' };
  }

  #sendHostRules(): void {
    const group = this.store.getState().group;
    if (group.phase === 'joined' && group.role === 'host') {
      this.#controller?.setGroupRules(this.#hostRules());
    }
  }

  /**
   * Simulation mode only: shorter pick-up spacing and challenge windows from localStorage
   * (`freilauf.powerUps.tuning`, JSON; used by the end-to-end tests). Null otherwise.
   */
  #powerUpTuning(): unknown {
    if (!this.store.getState().simMode) return null;
    try {
      const raw = globalThis.localStorage?.getItem(POWER_UP_TUNING_KEY);
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null;
    }
  }

  // ───────────── workouts ─────────────

  /**
   * Chooses the workout for the next ride (null = free ride). Ignored while riding. An episode
   * workout's id ("episode-…") selects one fitted to the last episode choices again.
   */
  selectWorkout(id: string | null): boolean {
    if (isEpisodeWorkoutId(id)) {
      return this.selectEpisode(this.store.getState().settings?.episode ?? null);
    }
    const entry = id === null ? null : this.#library.get(id);
    if (id !== null && !entry) return false;
    if (!this.#controller?.selectWorkout(entry?.workout ?? null, entry?.ftpTest ?? null)) {
      this.notify('info', 'Finish the current ride before changing the workout.');
      return false;
    }
    this.store.setState({ selectedWorkoutId: id, episodePlan: null });
    return true;
  }

  /**
   * "Fit to an episode": generates the workout for these choices, selects it for the next ride
   * and remembers the choices (Settings.episode). Ignored while riding.
   */
  selectEpisode(options: Partial<EpisodeOptions> | null): boolean {
    const chosen = normalizeEpisodeOptions(
      options ?? {},
      normalizeEpisodeOptions(this.store.getState().settings?.episode ?? null),
    );
    const plan = generateEpisodeWorkout(chosen);
    if (!this.#controller?.selectWorkout(plan.workout, null, plan)) {
      this.notify('info', 'Finish the current ride before changing the workout.');
      return false;
    }
    this.#episodeRevision = 0;
    this.store.setState({ selectedWorkoutId: plan.workout.id, episodePlan: plan });
    const saved = this.store.getState().settings?.episode;
    if (
      !saved ||
      saved.lengthMin !== chosen.lengthMin ||
      saved.effort !== chosen.effort ||
      saved.pattern !== chosen.pattern
    ) {
      void this.updateSettings({ episode: chosen });
    }
    return true;
  }

  /** "Hard now" in a running episode workout (H key, the workout panel, a controller button). */
  hardNow(source: ShiftSource = 'ui'): boolean {
    return this.#controller?.hardNow(source).ok ?? false;
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

  // ───────────── routes (docs/routes.md) ─────────────

  /**
   * Chooses the route for the next ride (null = none). Ignored while riding. Combines with a
   * selected workout; the route stays selected after the ride.
   */
  selectRoute(id: string | null): boolean {
    const found = id === null ? null : this.#routes.get(id);
    if (id !== null && !found) return false;
    const startM = id === null ? 0 : this.#routes.startOf(id);
    if (!this.#controller?.selectRoute(found?.track ?? null, startM)) {
      this.notify('info', 'Finish the current ride before changing the route.');
      return false;
    }
    this.store.setState({ selectedRouteId: id, routeTrack: found?.track ?? null });
    this.#refreshRouteWind();
    void this.#refreshGhost();
    void this.#refreshRouteScenery();
    return true;
  }

  // ───────────── the weather of a day (docs/adr/0012-historical-wind.md) ─────────────

  /**
   * The selected route's stored wind for the next ride: handed to the ride when it fits the
   * route and "Ride with that day's wind" is on for it (the default). Never fetches.
   */
  #refreshRouteWind(): void {
    const s = this.store.getState();
    const id = s.selectedRouteId;
    const track = s.routeTrack;
    const profile = id ? this.#weather.profile(id) : null;
    const fits =
      profile && track && Math.abs(profile.totalDistanceM - track.totalDistanceM) < 1 + track.stepM;
    const routeWind = fits ? profile : null;
    if ((s.routeWind ?? null) !== routeWind) this.store.setState({ routeWind });
    const c = this.#controller;
    if (!c || c.rideState !== 'idle') return;
    const on = routeWind && id ? s.settings?.weather?.rideWithWind[id] !== false : false;
    if (on && routeWind) {
      const key = windConditionsKey(routeWind);
      if (c.wind?.key !== key || c.wind.profile !== routeWind) {
        c.setWind({ profile: routeWind, key, label: weatherDayLabel(routeWind) });
      }
    } else if (c.wind) c.setWind(null);
    c.setWindShelter(s.routeScenery ?? null);
  }

  /** "Ride with that day's wind" on the start screen, remembered per route. */
  async setRideWithWind(id: string, on: boolean): Promise<void> {
    if ((this.#controller?.rideState ?? 'idle') !== 'idle') return;
    this.#logger.log('info', 'weather', on ? 'riding with wind' : 'riding without wind', { id });
    await this.updateSettings({ weather: { rideWithWind: { [id]: on } } });
    this.#refreshRouteWind();
    await this.#refreshGhost();
  }

  /** When the recorded ride of an imported route took place (from its GPX), or null. */
  recordedRideTime(id: string): { startMs: number; endMs: number; label: string } | null {
    const times = this.#routes.timesOf(id);
    if (!times) return null;
    const span = routeTimesSpan(times);
    const offset = -new Date(span.startMs).getTimezoneOffset() * 60;
    return { ...span, label: formatWeatherSpan(span.startMs, span.endMs, offset) };
  }

  /**
   * Loads the weather of a day along an imported route once and stores it (the rider asked:
   * on import or in the route's details). Without `day` the recorded ride's times are used
   * (a GPX with times); with it, that day from `day.time` (default 10:00) at a constant
   * 25 km/h. Returns false when there is nothing to load for (no times and no day given).
   */
  loadWeather(id: string, day?: { date: string; time?: string } | null): boolean {
    const found = this.#routes.get(id);
    if (!found || found.entry.source !== 'imported') return false;
    if (day && day.date) {
      this.#weather.load(found.track, {
        kind: 'chosen',
        date: day.date,
        time: day.time || DEFAULT_WEATHER_START,
      });
      return true;
    }
    const times = this.#routes.timesOf(id);
    if (!times) return false;
    this.#weather.load(found.track, { kind: 'recorded', times });
    return true;
  }

  cancelWeather(id: string): void {
    this.#weather.cancel(id);
  }

  removeWeather(id: string): void {
    if (
      (this.#controller?.rideState ?? 'idle') !== 'idle' &&
      this.store.getState().selectedRouteId === id
    ) {
      this.notify('info', 'Finish the current ride before removing its weather.');
      return;
    }
    this.#weather.remove(id);
  }

  // ───────────── scenery along routes (docs/adr/0011-osm-scenery.md) ─────────────

  /** The scenery state last handed to the scenes ('ready' or 'none'), for onStatus. */
  #sceneryShown: SceneryStatus['state'] | null = null;

  /** Loads the selected route's stored scenery for the scenes (never fetches). */
  async #refreshRouteScenery(): Promise<void> {
    const token = ++this.#sceneryToken;
    const id = this.store.getState().selectedRouteId;
    const status = id ? this.#scenery.status(id) : null;
    this.#sceneryShown = status?.state ?? null;
    if (!id || status?.state !== 'ready') {
      if (status?.state === 'loading' || status?.state === 'queued') return; // keep the old one
      if (this.store.getState().routeScenery) this.store.setState({ routeScenery: null });
      return;
    }
    const model = await this.#scenery.model(id);
    if (token !== this.#sceneryToken) return;
    const track = this.store.getState().routeTrack;
    // Built for this route (same length): otherwise the places would not match the road.
    const fits =
      model && track && Math.abs(model.totalDistanceM - track.totalDistanceM) < 1 + track.stepM;
    this.store.setState({ routeScenery: fits ? model : null });
    // Woods and houses beside the road shelter it from the wind.
    this.#controller?.setWindShelter(fits ? model : null);
  }

  /**
   * Loads the surroundings of an imported route from the map server once and stores them
   * (the rider asked for it: on import or in the route's details). Built-in routes have none.
   */
  loadScenery(id: string): boolean {
    const found = this.#routes.get(id);
    if (!found || found.entry.source !== 'imported') return false;
    this.#scenery.load(found.track);
    return true;
  }

  cancelScenery(id: string): void {
    this.#scenery.cancel(id);
  }

  async removeScenery(id: string): Promise<void> {
    await this.#scenery.remove(id);
    if (this.store.getState().selectedRouteId === id) await this.#refreshRouteScenery();
  }

  /** Summary of a route's stored scenery (loads and decodes it once). */
  async scenerySummary(id: string): Promise<void> {
    await this.#scenery.model(id);
  }

  /**
   * Where the next ride on route `id` starts (m along it; 0 = from the beginning), remembered
   * for later rides. Not while riding (use jumpTo then). Returns the start point in effect, or
   * null when it was not changed.
   */
  setRouteStart(id: string, distanceM: number): number | null {
    if ((this.#controller?.rideState ?? 'idle') !== 'idle') {
      this.notify('info', 'Finish the current ride before changing where the route starts.');
      return null;
    }
    const startM = this.#routes.setStart(id, distanceM);
    if (startM === null) return null;
    if (this.#routes.saveFailed) {
      this.notify(
        'error',
        'The start point could not be saved permanently (storage full or blocked).',
      );
    }
    if (this.store.getState().selectedRouteId === id) this.#controller?.setRouteStart(startM);
    this.#logger.log('info', 'routes', 'route start point set', {
      id,
      startKm: Math.round(startM / 100) / 10,
    });
    this.store.setState({ routes: this.#routes.list() });
    return startM;
  }

  /**
   * Moves the rider to another place on the selected route (docs/routes.md, "Choosing where to start, and jumping"). Before
   * the ride this sets (and remembers) the start point; during the ride only the place on the
   * route changes. Returns the place in effect, or null without a selected route.
   */
  jumpTo(distanceM: number): number | null {
    const id = this.store.getState().selectedRouteId;
    if (id === null) return null;
    if ((this.#controller?.rideState ?? 'idle') === 'idle') {
      return this.setRouteStart(id, distanceM);
    }
    return this.#controller?.jumpTo(distanceM) ?? null;
  }

  /** Imports a GPX file (or our own route format). `fileName` names a GPX without a name. */
  importRoute(
    text: string,
    fileName?: string,
    options: {
      scenery?: boolean;
      weather?: boolean;
      weatherDay?: { date: string; time?: string };
    } = {},
  ):
    | { ok: true; entry: RouteEntry; warnings: string[]; weather?: string }
    | { ok: false; errors: string[] } {
    const log = this.#logger.scope('routes');
    const result: RouteImportResult = this.#routes.importText(text, fileName);
    if (!result.ok) {
      log.warn('route import refused', { bytes: text.length, errors: result.errors });
      return result;
    }
    const { entry, warnings, stats } = result;
    log.info(`route imported: ${entry.name}`, {
      id: entry.id,
      bytes: text.length,
      distanceKm: Math.round(entry.totalDistanceM / 10) / 100,
      ascentM: Math.round(entry.ascentM),
      loop: entry.loop,
      ...(stats
        ? {
            points: stats.inputPoints,
            duplicates: stats.duplicatesDropped,
            spikes: stats.spikesDropped,
            rawAscentM: Math.round(stats.rawAscentM),
          }
        : {}),
      storedKChars: Math.round(this.#routes.storedChars / 1000),
      warnings,
    });
    this.store.setState({ routes: this.#routes.list() });
    // A re-import of the selected route replaces its track (for the next ride).
    if (this.store.getState().selectedRouteId === entry.id) this.selectRoute(entry.id);
    // Only when the rider ticked "Load surroundings" (off by default).
    if (options.scenery === true) this.loadScenery(entry.id);
    // Only when the rider ticked "Load the weather of that day" (off by default): the
    // recorded day if the file has times, else the day chosen next to the option.
    let weather: string | undefined;
    if (options.weather === true && entry.source === 'imported') {
      const recorded = result.times ? this.recordedRideTime(entry.id) : null;
      if (recorded) {
        this.loadWeather(entry.id);
        weather = `Weather of the recorded ride: ${recorded.label}.`;
      } else if (options.weatherDay?.date) {
        this.loadWeather(entry.id, options.weatherDay);
        weather = `No times in this file: weather of ${options.weatherDay.date}, from ${options.weatherDay.time || DEFAULT_WEATHER_START}.`;
      } else {
        weather = 'No times in this file: choose a day in the route’s Details to load its weather.';
      }
    }
    return { ok: true, entry, warnings, ...(weather ? { weather } : {}) };
  }

  deleteRoute(id: string): void {
    if (this.store.getState().selectedRouteId === id && !this.selectRoute(null)) return;
    if (this.store.getState().sharingRouteId === id) this.stopSharingRoute();
    if (this.#routes.remove(id)) {
      this.#logger.log('info', 'routes', 'route deleted', { id });
      this.store.setState({ routes: this.#routes.list() });
      if (this.#scenery.status(id).state !== 'none') void this.#scenery.remove(id);
      if (this.#weather.status(id).state !== 'none') this.#weather.remove(id);
    }
  }

  /** The full track of a library route (exact elevation and gradient for the Routes tab). */
  routeTrackFor(id: string): RouteTrack | null {
    return this.#routes.get(id)?.track ?? null;
  }

  /** GPX file name and contents of a route (the prepared, smoothed track). */
  exportRoute(id: string): { fileName: string; text: string } | null {
    return this.#routes.export(id);
  }

  /** Offers a route to the group, at a resolution that fits the group's document budget. */
  shareRoute(id: string): void {
    const found = this.#routes.get(id);
    const group = this.#group;
    if (!group || !found) return;
    const log = this.#logger.scope('routes');
    const prepared = shareRouteInGroup(group, this.#community, found.track);
    if (!prepared.ok) {
      log.warn('route not shared', { id, reason: prepared.reason });
      this.store.setState({ sharingRouteId: null });
      this.notify('error', `Could not share the route: ${prepared.reason}.`);
      return;
    }
    log.info(`route shared: ${found.track.name}`, {
      id,
      bytes: prepared.bytes,
      stepM: Math.round(prepared.stepM * 10) / 10,
    });
    this.store.setState({ sharingRouteId: id });
  }

  stopSharingRoute(): void {
    this.#group?.stopSharingRoute?.();
    this.#community.resync();
    this.store.setState({ sharingRouteId: null });
  }

  /** Adds a route offered by another rider to the library and selects it. */
  useSharedRoute(peerId: string): void {
    const track = this.#sharedRouteTracks.get(peerId);
    if (!track) return;
    const added = this.#routes.add(track);
    if (!added.ok) {
      this.notify('error', added.errors.join(' '));
      return;
    }
    this.#logger.log('info', 'routes', `shared route added: ${track.name}`, { id: track.id });
    this.store.setState({ routes: this.#routes.list() });
    this.selectRoute(track.id);
  }

  #refreshSharedRoutes(): void {
    const decoded = decodeSharedRoutes(this.#group?.getSharedRoutes?.() ?? []);
    this.#sharedRouteTracks = new Map(decoded.map((d) => [d.peerId, d.track]));
    this.store.setState({
      sharedRoutes: decoded.map((d) => ({
        peerId: d.peerId,
        peerName: d.peerName,
        entry: this.#routes.describe(d.track),
      })),
    });
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
    await this.#refreshGhost();
  }

  // ───────────── ghost rider (docs/ghost.md) ─────────────

  /** Chooses the ghost for the selected route ('best', 'last', 'ride:<id>', 'none'); remembered. */
  async chooseGhost(choice: GhostChoice): Promise<void> {
    const routeId = this.#ghostState().routeId;
    if (routeId === null || (this.#controller?.rideState ?? 'idle') !== 'idle') return;
    this.#importedGhost = null;
    this.#ghostLog.info('ghost chosen', { choice: choice.startsWith('ride:') ? 'ride' : choice });
    await this.updateSettings({ ghost: { sources: { [routeId]: choice } } });
    await this.#refreshGhost(choice);
  }

  /** The ghost switch (Settings and the start screen). */
  async setGhostEnabled(on: boolean): Promise<void> {
    await this.updateSettings({ ghost: { enabled: on } });
    await this.#refreshGhost();
  }

  /**
   * Imports a ride file (.fit) as the ghost of the selected route: placed on the route by its
   * GPS track (Freilauf's .fit files have no route id; positions decide). Kept in memory only.
   * Returns null, or why it cannot be used.
   */
  async importGhost(bytes: Uint8Array, fileName: string): Promise<string | null> {
    const track = this.store.getState().routeTrack;
    if (!track) return 'Choose a route first: a ghost races you along a route.';
    if ((this.#controller?.rideState ?? 'idle') !== 'idle') {
      return 'Finish the current ride before changing the ghost.';
    }
    const fail = (reason: string): string => {
      this.#ghostLog.info('ghost file refused', { bytes: bytes.byteLength, reason });
      this.store.setState({ ghost: { ...this.#ghostState(), error: reason } });
      return reason;
    };
    const decoded = decodeFitTrack(bytes);
    if (!decoded.ok) return fail(decoded.reason);
    const positioned = decoded.points.flatMap((p) =>
      p.lat !== undefined && p.lon !== undefined
        ? [{ timeS: p.timeS, lat: p.lat, lon: p.lon }]
        : [],
    );
    const matched = matchTrackToRoute(track, positioned);
    if (!matched.ok) return fail(matched.reason);
    const trace = downsampleTrace(matched.points);
    const routeId = routeBaseId(track.id);
    this.#importedGhost = { routeId, trace };
    const name = cleanFileName(fileName);
    const L = track.totalDistanceM;
    const whole = matched.fromM <= 50 + (track.loop ? Math.floor(matched.fromM / L) * L : 0);
    const part = matched.toM - matched.fromM;
    const note =
      part >= L - 60 && whole
        ? null
        : `Follows ${(part / 1000).toFixed(1)} of ${(L / 1000).toFixed(1)} km of the route`;
    const label = `${name} · ${clockTime((trace.timeS.at(-1) ?? 0) - (trace.timeS[0] ?? 0))}`;
    this.#ghostLog.info('ghost file imported', {
      bytes: bytes.byteLength,
      points: trace.distanceM.length,
      share: Math.round(matched.share * 100) / 100,
      meanOffM: Math.round(matched.meanOffM),
      partKm: Math.round(part / 100) / 10,
    });
    this.store.setState({
      ghost: { ...this.#ghostState(), imported: { name, label, note }, error: null },
    });
    await this.#refreshGhost('import');
    return null;
  }

  #ghostState(): GhostState {
    return this.store.getState().ghost ?? NO_GHOST;
  }

  get #ghostLog(): ScopedLog {
    return this.#logger.scope('ghost');
  }

  /**
   * Works out the ghost of the selected route from the ride history and the remembered choice,
   * loads its trace (from the stored ride) and hands it to the controller. Never during a ride.
   */
  async #refreshGhost(choiceNow?: GhostChoice | 'import'): Promise<void> {
    const s = this.store.getState();
    const g = this.#ghostState();
    if ((this.#controller?.rideState ?? 'idle') !== 'idle') return;
    const track = s.routeTrack;
    const token = ++this.#ghostToken;
    if (!track) {
      this.#importedGhost = null;
      this.#controller?.setGhost(null);
      if (g !== NO_GHOST) this.store.setState({ ghost: NO_GHOST });
      return;
    }
    const routeId = routeBaseId(track.id);
    const shape = { lengthM: track.totalDistanceM, loop: track.loop };
    const settings = s.settings?.ghost;
    const enabled = settings?.enabled !== false;
    const candidates = ghostCandidates(s.rides, routeId);
    // Like with like: the best time among rides in the same conditions (wind or not).
    const conditions = this.#controller?.wind?.key ?? null;
    const bestRideId = bestGhost(candidates, conditions)?.rideId ?? null;
    const sameRoute = g.routeId === routeId;
    if (this.#importedGhost && this.#importedGhost.routeId !== routeId) this.#importedGhost = null;
    const imported = this.#importedGhost && sameRoute ? g.imported : null;
    const choice: GhostChoice | 'import' =
      choiceNow ??
      (imported && g.choice === 'import' ? 'import' : (settings?.sources[routeId] ?? 'best'));
    const base: GhostState = {
      routeId,
      candidates,
      bestRideId,
      conditions,
      choice,
      active: null,
      imported,
      loading: false,
      error: choiceNow === undefined && sameRoute ? g.error : null,
    };
    if (enabled && choice === 'import' && this.#importedGhost && imported) {
      const ok = this.#controller?.setGhost({
        routeId,
        trace: this.#importedGhost.trace,
        label: imported.label,
      });
      this.store.setState({
        ghost: {
          ...base,
          active: ok ? { kind: 'import', rideId: null, label: imported.label } : null,
        },
      });
      return;
    }
    const resolved = resolveGhostChoice(
      choice === 'import' ? 'best' : choice,
      candidates,
      enabled,
      conditions,
    );
    if (resolved.kind === 'none') {
      this.#controller?.setGhost(null);
      this.store.setState({ ghost: base });
      return;
    }
    const rideId = resolved.ride.rideId;
    const label = ghostLabel(resolved, shape, Date.now(), conditions);
    let trace = this.#ghostTraces.get(rideId);
    if (trace === undefined) {
      this.store.setState({ ghost: { ...base, loading: true } });
      const ride = await this.#api.rides.load(rideId).catch(() => null);
      trace = ride ? (rideGhost(ride)?.trace ?? null) : null;
      this.#ghostTraces.set(rideId, trace);
      while (this.#ghostTraces.size > GHOST_CACHE_SIZE) {
        this.#ghostTraces.delete(this.#ghostTraces.keys().next().value!);
      }
      if (token !== this.#ghostToken) return; // a newer choice or route meanwhile
    }
    if (!trace) {
      this.#controller?.setGhost(null);
      this.store.setState({
        ghost: { ...base, error: 'That ride could not be read as a ghost.' },
      });
      return;
    }
    const ok = this.#controller?.setGhost({ routeId, trace, label }) ?? false;
    this.store.setState({
      ghost: { ...base, active: ok ? { kind: resolved.kind, rideId, label } : null },
    });
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
    if (deleted) {
      this.#community.removeRide(id);
      this.#ghostTraces.delete(id);
    }
    await this.refreshRides();
  }

  openRidesFolder(): void {
    void this.#api.rides.openFolder();
  }

  // ───────────── group ─────────────

  /** Creates a ride: over the public relays, or on the own server (Settings → Group, advanced). */
  async createGroup(): Promise<void> {
    await this.#enterGroup('create', '');
  }

  /** Joins with an invite link or code (relays), an old-style link or a bare code (own server). */
  async joinGroup(codeOrLink: string): Promise<void> {
    await this.#enterGroup('join', codeOrLink);
  }

  /**
   * "Test connection": whether a Freilauf signalling server answers at `url`.
   * Joins no room. The result is also written to the diagnostic log.
   */
  async testSignallingServer(url: string): Promise<ProbeResult> {
    const result = await this.#probeSignalling(url.trim());
    this.#logger.log(result.kind === 'ok' ? 'info' : 'warn', 'p2p', 'signalling server test', {
      signalling: describeUrl(url.trim()),
      result: result.kind,
      ...(result.kind === 'ok' ? { ms: result.ms } : {}),
      ...(result.kind === 'wrong-path' ? { suggestion: describeUrl(result.suggestion) } : {}),
    });
    return result;
  }

  leaveGroup(): void {
    if (this.#group)
      this.#logger.log('info', 'p2p', 'left the group', { peers: this.#groupPeers.size });
    this.#groupPeers = new Set();
    this.#peerFirstSeen = new Map();
    for (const off of this.#groupCleanup) off();
    this.#groupCleanup = [];
    this.#community.detach();
    this.#group?.leave();
    this.#group = null;
    this.#cancelGroupCountdown();
    this.#controller?.setGroup(null);
    this.#controller?.setGroupRules(null);
    this.#sharedRouteTracks = new Map();
    this.store.setState({
      group: { phase: 'idle' },
      sharedWorkouts: [],
      sharingWorkoutId: null,
      sharedRoutes: [],
      sharingRouteId: null,
      groupCountdownS: null,
    });
  }

  /** Offers one of the rider's workouts to everyone in the group. */
  shareWorkout(id: string): void {
    const exported = this.#library.export(id, 'freilauf');
    if (!this.#group || !exported) return;
    // The workout takes precedence over community extras (challenges, relays) in the budget.
    this.#community.makeRoom(utf8Length(exported.text), 1);
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
    // Replaces a local countdown; at zero the ride starts at once (no second countdown).
    this.#controller?.startGroupCountdown(ms);
  }

  cancelGroupStart(): void {
    // Only cancels locally; the others still start.
    this.#cancelGroupCountdown();
  }

  #cancelGroupCountdown(): void {
    if (this.#controller?.countdown?.kind === 'group') this.#controller.cancelCountdown();
    this.store.setState({ groupCountdownS: null });
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

  async #enterGroup(action: 'create' | 'join', input: string): Promise<void> {
    const settings = this.store.getState().settings;
    if (!this.#groupConnector || !settings || this.store.getState().group.phase === 'connecting') {
      return;
    }
    this.leaveGroup();
    this.store.setState({ group: { phase: 'connecting', action } });
    const started = Date.now();
    let signallingUrl = '';
    let transport: 'relays' | 'self-hosted' = 'relays';
    try {
      let group: JoinedGroup;
      if (action === 'create') {
        const target = resolveHostTarget(settings.group);
        transport = target.transport;
        if (target.transport === 'self-hosted') signallingUrl = target.signallingUrl;
        this.#logger.log('info', 'p2p', 'creating a group', {
          transport,
          ...(target.transport === 'self-hosted'
            ? { signalling: describeUrl(signallingUrl) }
            : { relays: target.relayUrls.length > 0 ? 'custom' : 'built-in' }),
        });
        group = await this.#groupConnector.create(settings.rider.name, target);
      } else {
        const target = resolveJoinTarget(input, settings.group);
        transport = target.transport;
        this.#logger.setSecrets({
          codes:
            target.transport === 'relays' ? [target.roomCode, target.secret] : [target.roomCode],
        });
        if (target.transport === 'self-hosted') {
          signallingUrl = target.signallingUrl;
          this.#logger.log('info', 'p2p', 'joining a group', {
            transport,
            signalling: describeUrl(signallingUrl),
            serverFrom: target.fromLink ? 'invite link' : 'settings',
          });
        } else {
          this.#logger.log('info', 'p2p', 'joining a group', {
            transport,
            relays: target.relayUrls.length > 0 ? 'custom' : 'built-in',
          });
        }
        group = await this.#groupConnector.join(target, settings.rider.name);
      }
      this.#logger.setSecrets({
        codes: group.secret ? [group.roomCode, group.secret] : [group.roomCode],
      });
      this.#logger.log('info', 'p2p', `joined room ${maskCode(group.roomCode)}`, {
        ms: Date.now() - started,
        transport: group.transport ?? transport,
      });
      this.#group = group;
      this.#controller?.setGroup(group);
      this.#controller?.setGroupRules(action === 'create' ? this.#hostRules() : null);
      this.#community.attach(group);
      this.#groupCleanup = [
        group.onSharedWorkoutsChange(() => this.#refreshSharedWorkouts()),
        group.onSharedRoutesChange?.(() => this.#refreshSharedRoutes()) ?? (() => {}),
        group.onStart((startsInMs, peerName) => {
          // A start only makes sense for someone who is not riding yet.
          if (this.#controller?.rideState !== 'idle') return;
          this.notify('info', `${peerName} started a group countdown.`);
          this.#controller?.startGroupCountdown(Math.max(0, startsInMs));
        }),
        group.onPeersChange(() => this.#refreshPeers()),
        group.onLog?.((line) => this.#logger.log(line.level, 'p2p', line.message, line.data)) ??
          (() => {}),
        group.onFailure?.((failure) => {
          // Deferred: the group is still unwinding the call that reported it.
          queueMicrotask(() => {
            if (this.#group === group) this.#groupFailed(group, action, input, failure, started);
          });
        }) ?? (() => {}),
      ];
      this.#refreshSharedWorkouts();
      this.#refreshSharedRoutes();
      this.store.setState({
        group: {
          phase: 'joined',
          roomCode: group.roomCode,
          joinLink: group.joinLink,
          inviteCode: group.inviteCode ?? group.roomCode,
          transport: group.transport ?? transport,
          relay:
            (group.transport ?? transport) === 'relays'
              ? relayStateFrom(group.getConnectionState?.() ?? 'connecting')
              : 'ready',
          role: action === 'create' ? 'host' : 'guest',
          signallingUrl,
          peers: [],
          notes: [],
        },
      });
      this.#refreshPeers();
    } catch (err) {
      await this.#showGroupError(err, { action, input, started, signallingUrl, transport });
    }
  }

  /** The group ended by itself after it was entered (relays: e.g. none reachable). */
  #groupFailed(
    group: JoinedGroup,
    action: 'create' | 'join',
    input: string,
    failure: { code: string; message: string },
    started: number,
  ): void {
    for (const off of this.#groupCleanup) off();
    this.#groupCleanup = [];
    this.#community.detach();
    group.leave();
    this.#group = null;
    this.#cancelGroupCountdown();
    this.#controller?.setGroup(null);
    this.#groupPeers = new Set();
    this.#peerFirstSeen = new Map();
    this.#sharedRouteTracks = new Map();
    this.store.setState({
      sharedWorkouts: [],
      sharingWorkoutId: null,
      sharedRoutes: [],
      sharingRouteId: null,
      groupCountdownS: null,
    });
    void this.#showGroupError(failure, {
      action,
      input,
      started,
      signallingUrl: '',
      transport: group.transport ?? 'relays',
      force: true,
    });
  }

  async #showGroupError(
    err: unknown,
    ctx: {
      action: 'create' | 'join';
      input: string;
      started: number;
      signallingUrl: string;
      transport: 'relays' | 'self-hosted';
      /** Show it even though the phase is no longer `connecting` (failed after joining). */
      force?: boolean;
    },
  ): Promise<void> {
    const { action, input, started, signallingUrl, transport } = ctx;
    const online: boolean | undefined = globalThis.navigator?.onLine;
    const code = (err as { code?: unknown } | null)?.code;
    // Own server: every failure to reach it ends in the same timeout; a probe tells them apart.
    let probe: ProbeResult | null = null;
    if (
      transport === 'self-hosted' &&
      signallingUrl &&
      (code === 'join-timeout' || code === 'connect-failed') &&
      online !== false
    ) {
      probe = await this.#probeSignalling(signallingUrl).catch(() => null);
    }
    const kind = classifyGroupError(err, { online, probe });
    const failure = describeGroupFailure(kind, { online, probe, signallingUrl, action });
    this.#logger.log('error', 'p2p', 'could not enter the group', {
      action,
      transport,
      ms: Date.now() - started,
      signalling: signallingUrl ? describeUrl(signallingUrl) : '(none)',
      failure: kind,
      probe: probe?.kind ?? null,
      online: online ?? null,
      error: describeError(err),
    });
    const phase = this.store.getState().group.phase;
    if (phase !== 'connecting' && !(ctx.force && phase === 'joined')) return;
    this.store.setState({
      group: {
        phase: 'error',
        message: `${failure.title}. ${failure.message}`,
        failure,
        action,
        input,
      },
    });
  }

  /** Re-reads the other riders' connection status; only publishes when something changed. */
  #refreshPeers(): void {
    const group = this.#group;
    const current = this.store.getState().group;
    if (!group || current.phase !== 'joined') return;
    const peers = group.getPeerStatuses
      ? peerViews(group.getPeerStatuses(), this.#peerFirstSeen, Date.now())
      : current.peers;
    const relay =
      current.transport === 'relays'
        ? relayStateFrom(group.getConnectionState?.() ?? 'connecting')
        : 'ready';
    const notes = groupNotes(group.getProblems?.() ?? []);
    if (relay !== current.relay) {
      this.#logger.log(relay === 'reconnecting' ? 'warn' : 'info', 'p2p', `relays ${relay}`);
    }
    for (const n of notes) {
      if (!current.notes.some((c) => c.code === n.code)) {
        this.#logger.log('warn', 'p2p', `group note shown: ${n.code}`);
      }
    }
    if (
      relay === current.relay &&
      JSON.stringify(peers) === JSON.stringify(current.peers) &&
      JSON.stringify(notes) === JSON.stringify(current.notes)
    ) {
      return;
    }
    for (const p of peers) {
      const before = current.peers.find((q) => q.peerId === p.peerId)?.state;
      if (before !== p.state && p.state !== 'connecting') {
        this.#logger.log(p.state === 'trouble' ? 'warn' : 'info', 'p2p', `peer ${p.state}`, {
          peer: p.peerId.slice(0, 4),
        });
      }
    }
    this.store.setState({ group: { ...current, peers, relay, notes } });
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
    this.#logger.log(kind === 'info' ? 'info' : 'warn', 'renderer', `notice shown: ${message}`);
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

/** A file name as a ghost's name: without folders and extension, bounded. */
function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const stem = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return (stem || 'Imported ride').slice(0, 40);
}

/**
 * This ride's time for the whole route and the best before it (from the ride history), for
 * the summary's "new best time" line; null when the ride did not cover the whole route.
 */
function routeTimeOf(
  ride: RecordedRide | null,
  earlier: readonly GhostCandidate[],
): { timeS: number; previousS: number | null } | null {
  const info = ride ? rideRouteInfo(ride) : null;
  if (!info || info.fullTimeS === null) return null;
  // Only rides in the same conditions: with this day's wind, or without wind.
  const previous =
    bestGhost(
      earlier.filter((c) => c.rideId !== ride!.id),
      info.weather?.key ?? null,
    )?.fullTimeS ?? null;
  return { timeS: info.fullTimeS, previousS: previous };
}
