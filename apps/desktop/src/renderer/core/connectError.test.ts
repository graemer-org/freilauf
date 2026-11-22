import { describe, expect, it } from 'vitest';
import {
  ControlPointError,
  ControlPointTimeoutError,
  DeviceDisconnectedError,
} from '@freilauf/devices';
import { DETAILS_IN_LOG, classifyConnectError, connectErrorNotice } from './connectError';

function dom(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('classifyConnectError', () => {
  const cases: [unknown, string][] = [
    [dom('NotFoundError', 'User cancelled the requestDevice() chooser.'), 'cancelled'],
    [dom('NotFoundError', 'Bluetooth adapter not available.'), 'bluetoothOff'],
    [dom('NotFoundError', 'Web Bluetooth API globally disabled.'), 'bluetoothOff'],
    [dom('InvalidStateError', 'Bluetooth is turned off.'), 'bluetoothOff'],
    [
      dom(
        'NotFoundError',
        'No Services matching UUID 00001826-0000-1000-8000-00805f9b34fb found in Device.',
      ),
      'wrongDevice',
    ],
    [new Error('Device has no GATT server'), 'wrongDevice'],
    [dom('NetworkError', 'Connection failed for unknown reason.'), 'busy'],
    [new ControlPointError(0x00, 'controlNotPermitted'), 'busy'],
    [dom('NetworkError', 'Bluetooth Device is no longer in range.'), 'timeout'],
    [new ControlPointTimeoutError(0x11), 'timeout'],
    [new DeviceDisconnectedError('link lost during setup'), 'timeout'],
    [
      dom('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.'),
      'timeout',
    ],
    [dom('NetworkError', 'Authentication failed.'), 'pairing'],
    [dom('BluetoothUnavailableError', 'Web Bluetooth is unavailable.'), 'unavailable'],
    [new Error('something else entirely'), 'unknown'],
    ['a string', 'unknown'],
  ];
  it.each(cases)('%s → %s', (err, kind) => {
    expect(classifyConnectError(err).kind).toBe(kind);
  });
});

describe('connectErrorNotice', () => {
  it('says nothing when the user cancelled', () => {
    expect(
      connectErrorNotice(
        dom('NotFoundError', 'User cancelled the requestDevice() chooser.'),
        'trainer',
      ),
    ).toBe(null);
  });

  it('is specific and always points at the log', () => {
    const busy = connectErrorNotice(
      dom('NetworkError', 'Connection failed for unknown reason.'),
      'trainer',
    );
    expect(busy).toContain('another app or a phone');
    expect(busy?.endsWith(DETAILS_IN_LOG)).toBe(true);
    const wrong = connectErrorNotice(
      dom('NotFoundError', 'No Services matching UUID x found in Device.'),
      'heartRate',
    );
    expect(wrong).toContain('does not look like a heart-rate monitor');
    const off = connectErrorNotice(
      dom('NotFoundError', 'Bluetooth adapter not available.'),
      'controller',
    );
    expect(off).toMatch(/^Bluetooth is off/);
    const other = connectErrorNotice(new Error('weird'), 'controller', 'reconnect');
    expect(other).toBe(`Could not reconnect the controller: weird. ${DETAILS_IN_LOG}`);
  });
});
