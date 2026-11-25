/**
 * "Share with my watch": drives the sensor-relay helper process. No Electron
 * and no child_process here (sensorRelay.ts does the wiring), so the whole
 * lifecycle is unit-tested with a fake helper and fake timers.
 *
 * Lifecycle: configure(settings) → spawn the helper → wait for `ready`
 * (protocol check) → `start` with the chosen services → `started` →
 * updates every UPDATE_MS from the latest live values → `subscribers` events
 * count the connected watches. Turning it off sends `stop` and `quit` and
 * closes stdin. If the helper dies it is restarted with backoff; an
 * "unsupported" answer or a protocol mismatch is final until the rider turns
 * sharing off and on again. Everything relevant goes to the diagnostic log
 * (source "relay").
 */
import type { RelayInput, RelayServiceKind } from '@freilauf/devices';
import {
  RELAY_SERVICE_KINDS,
  RELAY_SERVICE_UUID,
  SensorRelayModel,
  fromRelayHex,
  relayServices,
} from '@freilauf/devices';
import type { LiveState, WatchRelaySettings, WatchRelayStatus } from '../shared/contract';
import type { MainLog } from './logFile';
import type { RelayEvent } from './sensorRelayProtocol';
import {
  LineSplitter,
  SENSOR_RELAY_PROTOCOL,
  commandLine,
  notifyCommand,
  parseRelayEvent,
  startCommand,
} from './sensorRelayProtocol';

/** Update interval: at most 4 notifications per second per characteristic. */
export const UPDATE_MS = 250;
/** Live values older than this count as "none" (the main window stopped publishing). */
export const LIVE_STALE_MS = 3000;
/** How long a fresh helper may take to say `ready`. */
export const READY_TIMEOUT_MS = 5000;
/** After `quit` and closing stdin, how long until the helper is killed. */
export const KILL_AFTER_MS = 2000;
/** Restart delays after the helper died (or a start failed); the last one repeats. */
export const RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
/** Consecutive failures without a successful start before giving up. */
export const MAX_RESTARTS = 8;
/** How often a one-line summary of what is being relayed is logged. */
export const SUMMARY_MS = 60_000;

/** The helper process as the controller sees it. */
export interface HelperProcess {
  /** Writes one line to the helper's stdin; false if it could not be written. */
  write(line: string): boolean;
  /** Closes stdin (the helper stops and exits on EOF). */
  end(): void;
  kill(): void;
}

export interface HelperCallbacks {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  /** The process is gone (exit or spawn error). Called once. */
  exit(info: { code: number | null; signal: string | null; error?: string }): void;
}

export interface SensorRelayDeps {
  /**
   * Starts the helper. Throws or reports `exit` with an error when it cannot
   * be started. Null when this build/OS has no helper (`unavailableReason`).
   */
  spawn: ((callbacks: HelperCallbacks) => HelperProcess) | null;
  unavailableReason: string;
  /** The values to relay right now, or null when there are none. */
  input(nowMs: number): RelayInput | null;
  computerName: string;
  log: MainLog;
  onStatus(status: WatchRelayStatus): void;
  now?: () => number;
}

/** The kinds to share, in the stable order of RELAY_SERVICE_KINDS. */
export function sharedKinds(settings: WatchRelaySettings): RelayServiceKind[] {
  return RELAY_SERVICE_KINDS.filter((k) => settings.share[k]);
}

/**
 * The relay's input from the main window's live state. Speed is the ride's
 * virtual speed (0 unless riding); distance only advances while riding, so a
 * paused ride stops the wheel. No live state, or one older than
 * LIVE_STALE_MS: null (the model then sends zero power and no new turns).
 */
export function relayInputFromLive(live: LiveState | null, ageMs: number): RelayInput | null {
  if (!live || !(ageMs <= LIVE_STALE_MS)) return null;
  const r = live.ride;
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const hr = r.heartRateBpm;
  return {
    heartRateBpm: hr !== null && Number.isFinite(hr) && hr > 0 ? hr : null,
    powerW: Math.max(0, finite(r.powerW)),
    cadenceRpm: Math.max(0, finite(r.cadenceRpm)),
    speedMps: r.state === 'riding' ? Math.max(0, finite(r.speedMps)) : 0,
    distanceM: finite(r.distanceM),
  };
}

type Phase =
  /** No helper (off, unsupported, gave up, or waiting to restart). */
  | 'idle'
  /** Spawned, waiting for `ready`. */
  | 'waitingReady'
  /** `start` sent, waiting for `started`. */
  | 'starting'
  /** Services published; updates flow. */
  | 'running';

const KIND_BY_UUID = new Map<string, RelayServiceKind>(
  RELAY_SERVICE_KINDS.map((k) => [RELAY_SERVICE_UUID[k], k]),
);

export class SensorRelayController {
  readonly #deps: SensorRelayDeps;
  readonly #now: () => number;
  #status: WatchRelayStatus;
  /** enabled + kinds last applied, so unrelated settings changes are no-ops. */
  #configKey = '';
  #kinds: RelayServiceKind[] = [];
  #wanted = false;

  #proc: HelperProcess | null = null;
  /** Bumped per spawn so callbacks of an old process are ignored. */
  #generation = 0;
  #phase: Phase = 'idle';
  /** We asked the current helper to go away; its exit is not a failure. */
  #leaving = false;
  /** Final answer until the configuration changes (unsupported, protocol mismatch). */
  #final = false;
  #failures = 0;

  #published = new Set<string>();
  #subscribers = new Map<string, string[]>();
  #model: SensorRelayModel | null = null;
  #modelKey = '';

  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #feedTimer: ReturnType<typeof setInterval> | null = null;
  #killTimers = new Set<ReturnType<typeof setTimeout>>();
  #summary = { at: 0, updates: 0 };

  constructor(deps: SensorRelayDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#status = deps.spawn
      ? { state: 'off' }
      : { state: 'unavailable', reason: deps.unavailableReason };
  }

  get status(): WatchRelayStatus {
    return this.#status;
  }

  /** Applies the rider's settings (call on start and on every settings change). */
  configure(settings: WatchRelaySettings): void {
    const kinds = sharedKinds(settings);
    const wanted = settings.enabled && kinds.length > 0;
    const key = `${wanted}:${kinds.join(',')}`;
    if (key === this.#configKey) return;
    this.#configKey = key;
    if (!this.#deps.spawn) {
      if (wanted)
        this.#deps.log.info('share with watch: not available', {
          reason: this.#deps.unavailableReason,
        });
      return;
    }
    const was = this.#wanted;
    this.#wanted = wanted;
    this.#kinds = kinds;
    this.#final = false;
    this.#failures = 0;
    this.#clearRestart();
    if (!wanted) {
      if (was) this.#deps.log.info('share with watch: turned off');
      this.#shutdown();
      this.#setStatus({ state: 'off' });
      return;
    }
    this.#deps.log.info('share with watch: on', { sharing: kinds });
    if (this.#proc && (this.#phase === 'starting' || this.#phase === 'running')) {
      this.#sendStart(); // new set of services on the running helper
    } else if (!this.#proc) {
      this.#spawn();
    }
    // waitingReady: `ready` sends the start with the current kinds.
  }

  /** App quit: stop advertising and let the helper exit. */
  dispose(): void {
    this.#wanted = false;
    this.#configKey = 'disposed';
    this.#clearRestart();
    this.#shutdown();
  }

  // ───────────── process ─────────────

  #spawn(): void {
    const spawn = this.#deps.spawn;
    if (!spawn) return;
    const gen = ++this.#generation;
    this.#leaving = false;
    this.#published.clear();
    this.#subscribers.clear();
    this.#setStatus({ state: 'starting' });
    const out = new LineSplitter();
    const err = new LineSplitter(4000);
    try {
      this.#proc = spawn({
        stdout: (chunk) => {
          if (gen !== this.#generation) return;
          for (const line of out.push(chunk)) this.#onLine(line);
        },
        stderr: (chunk) => {
          if (gen !== this.#generation) return;
          for (const line of err.push(chunk)) {
            if (line.trim()) this.#deps.log.info(`helper: ${line.slice(0, 500)}`);
          }
        },
        exit: (info) => {
          if (gen !== this.#generation) return;
          this.#onExit(info);
        },
      });
    } catch (e) {
      this.#proc = null;
      this.#deps.log.error('share with watch: could not start the helper', { error: e });
      this.#failed(`Could not start the Bluetooth helper (${errorText(e)}).`);
      return;
    }
    this.#phase = 'waitingReady';
    this.#deps.log.info('share with watch: helper started, waiting for it');
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      if (gen !== this.#generation || this.#phase !== 'waitingReady') return;
      this.#deps.log.warn('share with watch: helper did not answer in time');
      this.#proc?.kill(); // its exit restarts it
    }, READY_TIMEOUT_MS);
  }

  #onExit(info: { code: number | null; signal: string | null; error?: string }): void {
    const leaving = this.#leaving;
    this.#proc = null;
    this.#phase = 'idle';
    this.#stopFeed();
    this.#clearReady();
    this.#published.clear();
    this.#subscribers.clear();
    if (leaving || !this.#wanted || this.#final) {
      this.#deps.log.info('share with watch: helper exited', { ...info });
      return;
    }
    this.#deps.log.warn('share with watch: helper stopped unexpectedly', { ...info });
    this.#failed(
      info.error
        ? `The Bluetooth helper could not be started (${info.error}).`
        : 'The Bluetooth helper stopped unexpectedly.',
    );
  }

  /** A failure that is worth retrying: respawn (or re-send start) after a backoff. */
  #failed(message: string): void {
    this.#failures++;
    if (this.#failures > MAX_RESTARTS) {
      this.#deps.log.error('share with watch: giving up after repeated failures', {
        failures: this.#failures - 1,
      });
      this.#shutdown();
      this.#setStatus({
        state: 'error',
        message: `${message} Gave up; turn sharing off and on to try again.`,
        retrying: false,
      });
      return;
    }
    const delay =
      RESTART_DELAYS_MS[Math.min(this.#failures - 1, RESTART_DELAYS_MS.length - 1)] ?? 60_000;
    this.#deps.log.info('share with watch: retrying', { inMs: delay, attempt: this.#failures });
    this.#setStatus({ state: 'error', message, retrying: true });
    this.#clearRestart();
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#wanted || this.#final) return;
      if (this.#proc && this.#phase !== 'waitingReady') this.#sendStart();
      else if (!this.#proc) this.#spawn();
    }, delay);
  }

  /** Asks the helper to stop and exit; kills it if it does not. */
  #shutdown(): void {
    this.#stopFeed();
    this.#clearReady();
    const proc = this.#proc;
    if (!proc) return;
    this.#leaving = true;
    this.#write({ type: 'stop' });
    this.#write({ type: 'quit' });
    try {
      proc.end();
    } catch {
      // already closed
    }
    const t = setTimeout(() => {
      this.#killTimers.delete(t);
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }, KILL_AFTER_MS);
    if (typeof t === 'object' && t && 'unref' in t) t.unref();
    this.#killTimers.add(t);
    this.#proc = null;
    this.#generation++; // ignore whatever the old process still says
    this.#phase = 'idle';
    this.#published.clear();
    this.#subscribers.clear();
  }

  #write(command: Parameters<typeof commandLine>[0]): void {
    if (!this.#proc) return;
    try {
      if (!this.#proc.write(commandLine(command)) && command.type !== 'notify') {
        this.#deps.log.debug('share with watch: helper input is backed up', {
          command: command.type,
        });
      }
    } catch (e) {
      this.#deps.log.warn('share with watch: could not write to the helper', { error: e });
    }
  }

  // ───────────── protocol ─────────────

  #onLine(line: string): void {
    if (!line.trim()) return;
    const e = parseRelayEvent(line);
    if (!e) {
      this.#deps.log.warn('share with watch: unexpected helper output', {
        line: line.slice(0, 200),
      });
      return;
    }
    this.#onEvent(e);
  }

  #onEvent(e: RelayEvent): void {
    const log = this.#deps.log;
    switch (e.type) {
      case 'ready': {
        this.#clearReady();
        log.info('share with watch: helper ready', {
          version: e.version,
          protocol: e.protocol,
          backend: e.backend,
        });
        if (e.protocol !== SENSOR_RELAY_PROTOCOL) {
          this.#final = true;
          this.#shutdown();
          this.#setStatus({
            state: 'error',
            message: `The Bluetooth helper does not match this version of Freilauf (protocol ${e.protocol}, expected ${SENSOR_RELAY_PROTOCOL}). Reinstall Freilauf.`,
            retrying: false,
          });
          return;
        }
        this.#sendStart();
        return;
      }
      case 'adapter':
        log.info('share with watch: Bluetooth adapter', {
          lowEnergy: e.lowEnergySupported,
          peripheralRole: e.peripheralRoleSupported,
          centralRole: e.centralRoleSupported,
          radioOn: e.radioOn,
        });
        return;
      case 'unsupported':
        log.warn('share with watch: not supported on this computer', { reason: e.reason });
        this.#final = true;
        this.#clearRestart();
        this.#shutdown();
        this.#setStatus({ state: 'unsupported', reason: e.reason });
        return;
      case 'started': {
        this.#published = new Set(e.services);
        const missing = this.#kinds.filter((k) => !this.#published.has(RELAY_SERVICE_UUID[k]));
        log.info('share with watch: advertising', {
          sharing: this.#sharing(),
          ...(missing.length ? { notPublished: missing } : {}),
        });
        this.#phase = 'running';
        this.#failures = 0;
        this.#clearRestart();
        this.#startFeed();
        this.#updateSharingStatus();
        return;
      }
      case 'stopped':
        log.info('share with watch: helper stopped advertising');
        return;
      case 'advertising':
        (e.status.startsWith('aborted') ? log.warn : log.info)(
          'share with watch: advertising status',
          {
            service: KIND_BY_UUID.get(e.service) ?? e.service,
            status: e.status,
          },
        );
        return;
      case 'subscribers': {
        const key = `${e.service}/${e.characteristic}`;
        const before = this.#deviceCount();
        if (e.centrals.length) this.#subscribers.set(key, e.centrals);
        else this.#subscribers.delete(key);
        const after = this.#deviceCount();
        log.info('share with watch: subscriptions changed', {
          service: KIND_BY_UUID.get(e.service) ?? e.service,
          characteristic: e.characteristic.slice(4, 8),
          subscribers: e.centrals.length,
          devices: after,
        });
        if (before !== after) this.#updateSharingStatus();
        return;
      }
      case 'write': {
        log.info('share with watch: a watch wrote to a control point', {
          characteristic: e.characteristic.slice(4, 8),
          value: e.value.slice(0, 40),
        });
        if (!this.#model) return;
        let value: Uint8Array;
        try {
          value = fromRelayHex(e.value);
        } catch {
          return;
        }
        for (const u of this.#model.handleWrite(e.service, e.characteristic, value)) {
          this.#write(notifyCommand(u));
        }
        return;
      }
      case 'error':
        log.warn('share with watch: helper error', { message: e.message });
        if (this.#phase === 'starting' && e.message.startsWith('start failed')) {
          this.#failed(`Could not start sharing: ${e.message.replace(/^start failed:\s*/, '')}`);
        }
        return;
    }
  }

  #sendStart(): void {
    const kinds = this.#kinds;
    const key = kinds.join(',');
    // Keep the counters across helper restarts with the same services, so the
    // wheel and crank counts a watch has seen never run backwards.
    if (!this.#model || this.#modelKey !== key) {
      this.#model = new SensorRelayModel(kinds);
      this.#modelKey = key;
    }
    this.#subscribers.clear();
    this.#published.clear();
    this.#stopFeed();
    this.#phase = 'starting';
    this.#write(startCommand(relayServices(kinds)));
  }

  // ───────────── updates ─────────────

  #startFeed(): void {
    this.#stopFeed();
    this.#summary = { at: this.#now(), updates: 0 };
    this.#feedTimer = setInterval(() => this.#feed(), UPDATE_MS);
  }

  #stopFeed(): void {
    if (this.#feedTimer) clearInterval(this.#feedTimer);
    this.#feedTimer = null;
  }

  #feed(): void {
    if (!this.#model || this.#phase !== 'running' || !this.#proc) return;
    const now = this.#now();
    const input = this.#deps.input(now);
    for (const u of this.#model.update(now, input)) {
      if (this.#published.has(u.service)) this.#write(notifyCommand(u));
    }
    this.#summary.updates++;
    if (now - this.#summary.at >= SUMMARY_MS) {
      this.#deps.log.info('share with watch: relaying', {
        devices: this.#deviceCount(),
        updates: this.#summary.updates,
        live: input !== null,
        heartRateBpm: input?.heartRateBpm ?? null,
        powerW: input ? Math.round(input.powerW) : null,
        cadenceRpm: input ? Math.round(input.cadenceRpm) : null,
        speedKph: input ? Math.round(input.speedMps * 36) / 10 : null,
        relayedDistanceM: Math.round(this.#model.relayedDistanceM),
        crankRevs: this.#model.crank.cumulativeRevs,
        wheelRevs: this.#model.wheel.cumulativeRevs,
      });
      this.#summary = { at: now, updates: 0 };
    }
  }

  // ───────────── status ─────────────

  #sharing(): RelayServiceKind[] {
    return this.#kinds.filter((k) => this.#published.has(RELAY_SERVICE_UUID[k]));
  }

  #deviceCount(): number {
    const all = new Set<string>();
    for (const list of this.#subscribers.values()) for (const c of list) all.add(c);
    return all.size;
  }

  #updateSharingStatus(): void {
    if (this.#phase !== 'running') return;
    this.#setStatus({
      state: 'sharing',
      devices: this.#deviceCount(),
      sharing: this.#sharing(),
      computerName: this.#deps.computerName,
    });
  }

  #setStatus(status: WatchRelayStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.#status)) return;
    this.#status = status;
    try {
      this.#deps.onStatus(status);
    } catch (e) {
      this.#deps.log.warn('share with watch: status listener failed', { error: e });
    }
  }

  #clearReady(): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }

  #clearRestart(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
