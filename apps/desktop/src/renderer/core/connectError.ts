/**
 * Turns a failed pairing / connect into a message a rider can act on. Pure
 * (unit-tested in connectError.test.ts). The patterns are the error names and
 * messages Chromium's Web Bluetooth and our drivers produce; anything not
 * recognised falls back to the raw message. The full error always goes to the
 * diagnostic log, so every notice ends with "Details are in the log."
 */
import type { DeviceKind } from '@freilauf/devices';

export type ConnectErrorKind =
  /** The user closed the chooser: no notice. */
  | 'cancelled'
  /** No adapter, Bluetooth switched off or disabled. */
  | 'bluetoothOff'
  /** The device is (probably) connected to another app or a phone. */
  | 'busy'
  /** Out of range, asleep, or it stopped answering. */
  | 'timeout'
  /** It lacks the service we need: the wrong kind of device was chosen. */
  | 'wrongDevice'
  /** The device wants PIN pairing, which must be done in the OS first. */
  | 'pairing'
  /** The host cannot do Bluetooth at all; the error message already explains why. */
  | 'unavailable'
  | 'unknown';

export interface ConnectErrorInfo {
  kind: ConnectErrorKind;
  name: string;
  message: string;
}

export const DETAILS_IN_LOG = 'Details are in the log.';

const DEVICE_LABEL: Record<DeviceKind, string> = {
  trainer: 'trainer',
  heartRate: 'heart-rate monitor',
  controller: 'controller',
};

function parts(err: unknown): { name: string; message: string; result?: string } {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: unknown; message?: unknown; result?: unknown };
    return {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : String(err),
      result: typeof e.result === 'string' ? e.result : undefined,
    };
  }
  return { name: 'Error', message: String(err) };
}

export function classifyConnectError(err: unknown): ConnectErrorInfo {
  const { name, message, result } = parts(err);
  const m = message.toLowerCase();
  const info = (kind: ConnectErrorKind): ConnectErrorInfo => ({ kind, name, message });

  if (name === 'BluetoothUnavailableError') return info('unavailable');
  // Order matters: Chromium uses NotFoundError for several unrelated causes.
  if (
    /adapter|bluetooth (is )?(turned )?off|bluetooth.*(disabled|not available|unavailable|not supported)|globally disabled|radio/.test(
      m,
    )
  ) {
    return info('bluetoothOff');
  }
  if (
    /no services? matching|no characteristics? matching|service.*not found|missing.*service|has no gatt server|not a supported device/.test(
      m,
    )
  ) {
    return info('wrongDevice');
  }
  if (/user cancel+ed|chooser.*cancel|cancel+ed the requestdevice|request.*cancel+ed/.test(m)) {
    return info('cancelled');
  }
  if (name === 'NotFoundError') return info('cancelled');
  if (
    result === 'controlNotPermitted' ||
    /control ?not ?permitted|already connected|in use|busy/.test(m)
  ) {
    return info('busy');
  }
  if (/\bpin\b|passkey|authenticat|pairing/.test(m)) {
    return info('pairing');
  }
  if (
    name === 'ControlPointTimeoutError' ||
    /timed? ?out|timeout|no longer in range|out of range|not in range|link lost|disconnected while|gatt server is disconnected|device disconnected/.test(
      m,
    )
  ) {
    return info('timeout');
  }
  // Windows: a device that is connected to another host (Zwift, a phone app)
  // still advertises briefly, but the connection attempt fails without a reason.
  if (
    name === 'NetworkError' &&
    /connection failed|unknown reason|could not connect|connection attempt failed|failed to connect/.test(
      m,
    )
  ) {
    return info('busy');
  }
  return info('unknown');
}

/**
 * The notice for a failed pairing or reconnect, or null when there is
 * nothing to tell (the user cancelled).
 */
export function connectErrorNotice(
  err: unknown,
  kind: DeviceKind,
  phase: 'pair' | 'reconnect' = 'pair',
): string | null {
  const info = classifyConnectError(err);
  const device = DEVICE_LABEL[kind];
  const verb = phase === 'pair' ? 'connect' : 'reconnect';
  let text: string;
  switch (info.kind) {
    case 'cancelled':
      return null;
    case 'bluetoothOff':
      text =
        'Bluetooth is off or no Bluetooth adapter was found. Turn Bluetooth on (or plug in the adapter) and try again.';
      break;
    case 'busy':
      text =
        `Could not ${verb} the ${device}: it may be connected to another app or a phone. ` +
        'Close other cycling apps (Zwift, the manufacturer’s app), turn off Bluetooth on nearby phones or tablets that used it, then try again.';
      break;
    case 'timeout':
      text = `The ${device} stopped answering while connecting. Wake it up (pedal, press a button), move it closer to the computer and try again.`;
      break;
    case 'wrongDevice':
      text = `That device does not look like a ${device} (it lacks the service Freilauf needs). Choose a different device.`;
      break;
    case 'unavailable':
      text = /[.!?]$/.test(info.message) ? info.message : `${info.message}.`;
      break;
    case 'pairing':
      text = `The ${device} asks for PIN pairing. Pair it in the operating system’s Bluetooth settings first, then connect again.`;
      break;
    default:
      text = `Could not ${verb} the ${device}: ${info.message}`;
      if (!/[.!?]$/.test(text)) text += '.';
  }
  return `${text} ${DETAILS_IN_LOG}`;
}
