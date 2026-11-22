import type {
  Controller,
  ControllerButtonEvent,
  Device,
  DeviceKind,
  HeartRateSensor,
  Trainer,
  Unsubscribe,
} from '@freilauf/devices';
import type { GroupRider } from '@freilauf/p2p';
import type { RecordedRide, RideSnapshot } from '@freilauf/session';
import { RideSession } from '@freilauf/session';
import type { BikeParams, Shifter } from '@freilauf/sim';
import { DEFAULT_BIKE, SoftwareShifter } from '@freilauf/sim';
import type { DeviceStatus, LiveState, Settings } from '../../shared/contract';

/** The part of a group ride the controller needs; implemented by @freilauf/p2p's GroupRide. */
export interface GroupLink {
  readonly roomCode: string;
  setLocalState(state: {
    name: string;
    distanceM: number;
    speedMps: number;
    powerW: number;
    cadenceRpm: number;
    heartRateBpm: number | null;
    gear: number;
  }): void;
  getRiders(): GroupRider[];
}

export interface RideControllerOptions {
  settings: Settings;
  now?: () => number;
  /** Called on every tick with the state to show (main window + overlay). */
  onLive: (state: LiveState) => void;
  /** Persists a ride; called every autosave interval while riding and once when finished. */
  saveRide: (ride: RecordedRide, finished: boolean) => Promise<void>;
  onError?: (message: string) => void;
}

const AUTOSAVE_INTERVAL_MS = 30_000;
/** Rides shorter than this are discarded on finish (accidental start). */
const MIN_RIDE_SAMPLES = 10;

type Devices = { trainer: Trainer; heartRate: HeartRateSensor; controller: Controller };

/**
 * Wires devices, virtual shifting, the ride session and the group together.
 * No timers and no DOM: the owner calls tick() about four times per second.
 */
export class RideController {
  readonly #now: () => number;
  readonly #options: RideControllerOptions;
  #settings: Settings;
  #session: RideSession;
  #shifter: SoftwareShifter;
  #devices: Partial<Devices> = {};
  #unsubscribe: Partial<Record<DeviceKind, Unsubscribe[]>> = {};
  #group: GroupLink | null = null;
  #gradePercent = 0;
  #lastAutosaveAt = 0;

  constructor(options: RideControllerOptions) {
    this.#options = options;
    this.#settings = options.settings;
    this.#now = options.now ?? Date.now;
    this.#session = this.#newSession();
    this.#shifter = this.#newShifter();
  }

  /** The seam for native shifting later: everything else only sees Shifter. */
  get shifter(): Shifter {
    return this.#shifter;
  }

  get rideState(): RideSnapshot['state'] {
    return this.#session.state;
  }

  /** Attaches (or with null detaches) a device. Does not connect or disconnect it. */
  setDevice<K extends DeviceKind>(kind: K, device: Devices[K] | null): void {
    for (const off of this.#unsubscribe[kind] ?? []) off();
    const subs: Unsubscribe[] = [];
    this.#unsubscribe[kind] = subs;
    if (!device) {
      delete this.#devices[kind];
      return;
    }
    (this.#devices as Record<DeviceKind, Device>)[kind] = device;

    if (device.kind === 'trainer') {
      subs.push(
        device.onData((data) => {
          if (data.powerW !== undefined) this.#session.setPower(data.powerW);
          if (data.cadenceRpm !== undefined) this.#session.setCadence(data.cadenceRpm);
        }),
        // A (re)connected trainer knows nothing about the current gear and gradient.
        device.onState((state) => {
          if (state === 'connected') this.#shifter.resync();
        }),
      );
      if (device.state === 'connected') this.#shifter.resync();
    } else if (device.kind === 'heartRate') {
      subs.push(device.onHeartRate((bpm) => this.#session.setHeartRate(bpm)));
    } else {
      subs.push(device.onButton((event) => this.#onButton(event)));
    }
  }

  setGroup(group: GroupLink | null): void {
    this.#group = group;
  }

  updateSettings(settings: Settings): void {
    const before = this.#settings;
    this.#settings = settings;
    const changed =
      before.rider.massKg !== settings.rider.massKg ||
      before.rider.bikeMassKg !== settings.rider.bikeMassKg ||
      before.shifting.physicalRatio !== settings.shifting.physicalRatio ||
      before.shifting.trainerMassKg !== settings.shifting.trainerMassKg;
    if (changed) {
      this.#shifter = this.#newShifter(this.#shifter.gear);
      this.#shifter.resync();
      // Mass changes apply to the next ride; a running session keeps its physics.
      if (this.#session.state === 'idle') this.#session = this.#newSession();
    }
  }

  shift(delta: number): void {
    this.#shifter.shift(delta);
  }

  setGradient(gradePercent: number): void {
    this.#gradePercent = Math.max(-15, Math.min(20, gradePercent));
    this.#shifter.setGradient(this.#gradePercent);
    this.#session.setGradient(this.#gradePercent);
  }

  start(): void {
    if (this.#session.state === 'paused') {
      this.#session.resume();
    } else if (this.#session.state === 'idle') {
      this.#session = this.#newSession();
      this.#session.start();
      this.#lastAutosaveAt = this.#now();
    }
  }

  pause(): void {
    this.#session.pause();
  }

  /** Ends the ride and saves it. Returns the ride, or null if it was too short to keep. */
  async finish(): Promise<RecordedRide | null> {
    if (this.#session.state === 'idle') return null;
    const ride = this.#session.finish();
    this.#session = this.#newSession();
    if (ride.samples.length < MIN_RIDE_SAMPLES) return null;
    await this.#options.saveRide(ride, true);
    return ride;
  }

  /** Advances the ride and publishes the live state. */
  tick(): LiveState {
    this.#session.setGear(this.#shifter.gear, this.#shifter.gearCount);
    this.#session.setGradient(this.#gradePercent);
    const ride = this.#session.tick();
    const now = this.#now();

    if (ride.state !== 'idle' && now - this.#lastAutosaveAt >= AUTOSAVE_INTERVAL_MS) {
      this.#lastAutosaveAt = now;
      this.#options
        .saveRide(this.#session.toRecordedRide(), false)
        .catch((err: unknown) => this.#options.onError?.(`Autosave failed: ${String(err)}`));
    }

    this.#group?.setLocalState({
      name: this.#settings.rider.name,
      distanceM: ride.distanceM,
      speedMps: ride.speedMps,
      powerW: ride.powerW,
      cadenceRpm: ride.cadenceRpm,
      heartRateBpm: ride.heartRateBpm,
      gear: ride.gear,
    });

    const live: LiveState = {
      ride,
      devices: {
        trainer: status(this.#devices.trainer),
        heartRate: status(this.#devices.heartRate),
        controller: status(this.#devices.controller),
      },
      group: this.#group
        ? { roomCode: this.#group.roomCode, riders: this.#group.getRiders() }
        : null,
      localName: this.#settings.rider.name,
    };
    this.#options.onLive(live);
    return live;
  }

  dispose(): void {
    for (const kind of ['trainer', 'heartRate', 'controller'] as const) this.setDevice(kind, null);
  }

  #onButton(event: ControllerButtonEvent): void {
    if (!event.pressed) return;
    const action = this.#settings.shifting.buttons[event.button];
    if (action === 'shiftUp') this.shift(1);
    else if (action === 'shiftDown') this.shift(-1);
  }

  #bike(): BikeParams {
    const { massKg, bikeMassKg } = this.#settings.rider;
    return { ...DEFAULT_BIKE, totalMassKg: massKg + bikeMassKg };
  }

  #newSession(): RideSession {
    return new RideSession({
      bike: this.#bike(),
      riderMassKg: this.#settings.rider.massKg,
      now: this.#now,
    });
  }

  #newShifter(initialGear?: number): SoftwareShifter {
    const shifter = new SoftwareShifter(
      (params) => {
        const trainer = this.#devices.trainer;
        // Without a connected trainer there is nothing to tell; resync() runs on connect.
        if (!trainer || trainer.state !== 'connected') return Promise.resolve();
        return trainer.setSimulation(params);
      },
      {
        bike: this.#bike(),
        physicalRatio: this.#settings.shifting.physicalRatio,
        trainerMassKg: this.#settings.shifting.trainerMassKg ?? undefined,
        initialGear,
      },
    );
    shifter.setGradient(this.#gradePercent);
    shifter.onError((err) => this.#options.onError?.(`Trainer rejected resistance: ${String(err)}`));
    return shifter;
  }
}

function status(device: Device | undefined): DeviceStatus | null {
  return device ? { name: device.name, state: device.state } : null;
}
