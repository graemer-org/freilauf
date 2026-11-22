import type { Unsubscribe } from './emitter';

// ───────────────────────── Transport layer ─────────────────────────
// Everything above this layer only sees GATT-shaped operations. Web
// Bluetooth implements it today (apps/desktop); a noble backend or a
// Direct Connect (TCP) backend can implement the same interfaces later.

/** UUIDs are always full 128-bit, lowercase, hyphenated strings. */
export type Uuid = string;

export interface GattConnection {
  hasService(service: Uuid): Promise<boolean>;
  read(service: Uuid, characteristic: Uuid): Promise<DataView>;
  write(
    service: Uuid,
    characteristic: Uuid,
    data: Uint8Array,
    options?: { withoutResponse?: boolean },
  ): Promise<void>;
  /** Enables notifications/indications. Resolves once they are enabled. */
  subscribe(
    service: Uuid,
    characteristic: Uuid,
    listener: (data: DataView) => void,
  ): Promise<Unsubscribe>;
  disconnect(): Promise<void>;
  /** Fires once when the link is lost or closed, for any reason. */
  onDisconnect(listener: () => void): Unsubscribe;
}

export interface BlePeripheral {
  /** Stable across app restarts; used to remember and reconnect. */
  readonly id: string;
  readonly name: string;
  connect(): Promise<GattConnection>;
}

export type DeviceKind = 'trainer' | 'heartRate' | 'controller';

export interface BleTransport {
  /** Lets the user pick a device of the given kind. Rejects if cancelled. */
  requestDevice(kind: DeviceKind): Promise<BlePeripheral>;
  /** Finds a previously paired device without user interaction; null if not in range. */
  findKnownDevice(kind: DeviceKind, id: string): Promise<BlePeripheral | null>;
}

// ───────────────────────── Device layer ─────────────────────────
// What the rest of the app talks to. Real drivers (over a GattConnection)
// and simulated devices (packages/sim) implement the same interfaces.

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly state: ConnectionState;
  onState(listener: (state: ConnectionState) => void): Unsubscribe;
  /** Connects and keeps the link alive (auto-reconnect) until disconnect(). */
  connect(): Promise<void>;
  /** Intentional disconnect; stops auto-reconnect. */
  disconnect(): Promise<void>;
}

/** One measurement from a trainer. Fields the trainer did not report are absent. */
export interface TrainerData {
  powerW?: number;
  cadenceRpm?: number;
  /** Speed as reported by the trainer (flywheel speed), not the virtual speed. */
  speedKph?: number;
}

/** FTMS "Indoor Bike Simulation Parameters" in physical units. */
export interface SimulationParams {
  gradePercent: number;
  /** Coefficient of rolling resistance, e.g. 0.004. */
  crr: number;
  /** Wind resistance coefficient 0.5·ρ·CdA in kg/m, e.g. 0.51. */
  windResistanceKgM: number;
  /** Head wind in m/s (negative = tail wind). */
  windSpeedMps: number;
}

export interface Trainer extends Device {
  readonly kind: 'trainer';
  onData(listener: (data: TrainerData) => void): Unsubscribe;
  setSimulation(params: SimulationParams): Promise<void>;
  /** ERG mode. Priority 2, but part of the contract so drivers implement it now. */
  setTargetPower(watts: number): Promise<void>;
}

export interface HeartRateSensor extends Device {
  readonly kind: 'heartRate';
  onHeartRate(listener: (bpm: number) => void): Unsubscribe;
}

export type ControllerButton =
  | 'shiftUpLeft'
  | 'shiftDownLeft'
  | 'shiftUpRight'
  | 'shiftDownRight'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'a'
  | 'b'
  | 'y'
  | 'z'
  | 'powerUpLeft'
  | 'powerUpRight'
  | 'onOffLeft'
  | 'onOffRight';

export interface ControllerButtonEvent {
  button: ControllerButton;
  pressed: boolean;
}

export interface Controller extends Device {
  readonly kind: 'controller';
  onButton(listener: (event: ControllerButtonEvent) => void): Unsubscribe;
  /** Analog paddles, -1 … 1 per side. Priority 2 (steering/braking). */
  onPaddle(listener: (event: { side: 'left' | 'right'; value: number }) => void): Unsubscribe;
}
