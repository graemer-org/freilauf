import { describe, expect, it } from 'vitest';
import { DeviceDisconnectedError } from './managedDevice';
import { fakeDomError, gattBusyError, gattDisconnectedError } from './testing/fakeGatt';
import { isGattBusyError, isRetryableWriteError, isTransientLinkError } from './transientErrors';

describe('error classification', () => {
  it('treats link drops, GATT errors and timeouts as transient link errors', () => {
    expect(isTransientLinkError(gattDisconnectedError())).toBe(true);
    expect(isTransientLinkError(fakeDomError('NetworkError', 'Connection attempt failed.'))).toBe(
      true,
    );
    expect(isTransientLinkError(new DeviceDisconnectedError('link lost during setup'))).toBe(true);
    expect(isTransientLinkError(fakeDomError('TimeoutError', 'x'))).toBe(true);
  });

  it('does not retry cancel, not-found or permission errors', () => {
    expect(
      isTransientLinkError(
        fakeDomError('NotFoundError', 'User cancelled the requestDevice() chooser.'),
      ),
    ).toBe(false);
    expect(isTransientLinkError(fakeDomError('NotAllowedError', 'denied'))).toBe(false);
    expect(isTransientLinkError(fakeDomError('SecurityError', 'blocked'))).toBe(false);
    expect(isTransientLinkError(new Error('setup boom'))).toBe(false);
    expect(isTransientLinkError(undefined)).toBe(false);
  });

  it('retries busy control point writes but not writes into a dropped link', () => {
    expect(isGattBusyError(gattBusyError())).toBe(true);
    expect(isRetryableWriteError(gattBusyError())).toBe(true);
    expect(
      isRetryableWriteError(
        fakeDomError('NetworkError', 'GATT operation failed for unknown reason.'),
      ),
    ).toBe(true);
    expect(isRetryableWriteError(gattDisconnectedError())).toBe(false);
    expect(isRetryableWriteError(new DeviceDisconnectedError())).toBe(false);
    expect(isRetryableWriteError(new Error('fake: not connected'))).toBe(false);
  });
});
