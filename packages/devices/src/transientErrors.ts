// Classification of BLE errors for the retry decisions of the drivers. The
// transports (Web Bluetooth today) surface DOMExceptions; only `name` and
// `message` are looked at, so plain objects of the same shape work too.

function errorParts(err: unknown): { name: string; message: string } {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: unknown; message?: unknown };
    return {
      name: typeof e.name === 'string' ? e.name : '',
      message: typeof e.message === 'string' ? e.message : '',
    };
  }
  return { name: '', message: typeof err === 'string' ? err : '' };
}

/** Errors that say the user, the OS or the device ruled the operation out: retrying cannot help. */
const PERMANENT_NAMES = new Set([
  'NotFoundError', // chooser cancelled, service/characteristic missing
  'NotAllowedError',
  'SecurityError',
  'AbortError',
  'NotSupportedError',
  'InvalidStateError',
  'TypeError',
  'BluetoothUnavailableError',
]);

const DISCONNECTED = /gatt server is disconnected|disconnected|no longer in range|link lost/i;

/**
 * Chromium's "another GATT operation is still running on this characteristic"
 * (`NetworkError: GATT operation already in progress.`). The operation itself
 * was never sent; trying again a moment later is safe.
 */
export function isGattBusyError(err: unknown): boolean {
  return /operation already in progress|operation in progress/i.test(errorParts(err).message);
}

/** The link to the device is gone (as opposed to a single failed operation). */
export function isDisconnectedError(err: unknown): boolean {
  const { name, message } = errorParts(err);
  return name === 'DeviceDisconnectedError' || DISCONNECTED.test(message);
}

/**
 * A failure of the radio link while connecting or setting up (the link
 * dropped during service discovery, a GATT error, a timeout): worth another
 * attempt. User cancellation, missing services and permission errors are not.
 */
export function isTransientLinkError(err: unknown): boolean {
  const { name, message } = errorParts(err);
  if (PERMANENT_NAMES.has(name)) return false;
  if (
    name === 'NetworkError' ||
    name === 'TimeoutError' ||
    name === 'DeviceDisconnectedError' ||
    name === 'ControlPointTimeoutError'
  ) {
    return true;
  }
  return DISCONNECTED.test(message) || /timed? ?out|timeout|gatt (operation|error)/i.test(message);
}

/**
 * A control point write that failed without the link going away (Chromium
 * busy, a transient GATT error): it can be written again after a short delay.
 */
export function isRetryableWriteError(err: unknown): boolean {
  if (isGattBusyError(err)) return true;
  if (isDisconnectedError(err)) return false;
  const { name, message } = errorParts(err);
  return name === 'NetworkError' || /gatt operation failed|gatt error/i.test(message);
}
