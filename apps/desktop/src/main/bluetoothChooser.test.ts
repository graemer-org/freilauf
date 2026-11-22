import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickerDevice } from '../shared/contract';
import { BluetoothChooser } from './bluetoothChooser';

function setup() {
  vi.useFakeTimers();
  const lists: PickerDevice[][] = [];
  const chooser = new BluetoothChooser({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onPickerDevices: (d) => lists.push(d),
    log: () => undefined,
  });
  return { chooser, lists };
}

const dev = (deviceId: string, deviceName = '') => ({ deviceId, deviceName });

describe('BluetoothChooser', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('auto mode selects the remembered device as soon as it appears', () => {
    const { chooser, lists } = setup();
    chooser.prepare({ deviceId: 'B', timeoutMs: 5000 });
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    chooser.handleSelect([dev('A', 'Other')], cb1);
    expect(cb1).not.toHaveBeenCalled();
    chooser.handleSelect([dev('A', 'Other'), dev('B', 'KICKR')], cb2);
    expect(cb2).toHaveBeenCalledExactlyOnceWith('B');
    expect(cb1).not.toHaveBeenCalled();
    expect(lists).toEqual([]);
    expect(chooser.isActive).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('auto mode cancels after the timeout', () => {
    const { chooser } = setup();
    chooser.prepare({ deviceId: 'B', timeoutMs: 3000 });
    const cb = vi.fn();
    chooser.handleSelect([dev('A')], cb);
    vi.advanceTimersByTime(2999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledExactlyOnceWith('');
  });

  it('auto mode is one-shot: the next request is interactive', () => {
    const { chooser, lists } = setup();
    chooser.prepare({ deviceId: 'B', timeoutMs: 3000 });
    chooser.handleSelect([dev('B')], vi.fn());
    const cb = vi.fn();
    chooser.handleSelect([dev('B', 'KICKR')], cb);
    expect(cb).not.toHaveBeenCalled();
    expect(lists).toEqual([[{ id: 'B', name: 'KICKR' }]]);
  });

  it('interactive mode forwards a growing, de-duplicated, named-first list', () => {
    const { chooser, lists } = setup();
    chooser.prepare(null);
    chooser.handleSelect([dev('1'), dev('2', 'HRM')], vi.fn());
    chooser.handleSelect([dev('1'), dev('2', 'HRM')], vi.fn()); // unchanged: no resend
    chooser.handleSelect(
      [dev('3', 'Unknown or Unsupported Device (AA:BB)'), dev('1', 'KICKR')],
      vi.fn(),
    );
    chooser.handleSelect([dev('4', 'Zwift Click')], vi.fn()); // Chromium sent a partial list: keep earlier ones
    expect(lists).toEqual([
      [
        { id: '2', name: 'HRM' },
        { id: '1', name: '' },
      ],
      [
        { id: '1', name: 'KICKR' },
        { id: '2', name: 'HRM' },
        { id: '3', name: 'Unknown or Unsupported Device (AA:BB)' },
      ],
      [
        { id: '1', name: 'KICKR' },
        { id: '2', name: 'HRM' },
        { id: '4', name: 'Zwift Click' },
        { id: '3', name: 'Unknown or Unsupported Device (AA:BB)' },
      ],
    ]);
  });

  it('pick answers with the newest callback exactly once', () => {
    const { chooser } = setup();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    chooser.handleSelect([dev('1', 'A')], cb1);
    chooser.handleSelect([dev('1', 'A'), dev('2', 'B')], cb2);
    chooser.pick('nope');
    expect(cb2).not.toHaveBeenCalled();
    chooser.pick('2');
    chooser.pick('2');
    chooser.cancel();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledExactlyOnceWith('2');
  });

  it('cancelPicker cancels', () => {
    const { chooser } = setup();
    const cb = vi.fn();
    chooser.handleSelect([dev('1', 'A')], cb);
    chooser.cancel();
    expect(cb).toHaveBeenCalledExactlyOnceWith('');
  });

  it('a new prepare cancels the open request', () => {
    const { chooser } = setup();
    const old = vi.fn();
    chooser.handleSelect([dev('1', 'A')], old);
    chooser.prepare({ deviceId: '9', timeoutMs: 1000 });
    expect(old).toHaveBeenCalledExactlyOnceWith('');
    const cb = vi.fn();
    chooser.handleSelect([dev('9', 'Z')], cb);
    expect(cb).toHaveBeenCalledExactlyOnceWith('9');
  });

  it('pick is ignored during auto-select; dispose cancels', () => {
    const { chooser } = setup();
    chooser.prepare({ deviceId: '9', timeoutMs: 1000 });
    const cb = vi.fn();
    chooser.handleSelect([dev('1', 'A')], cb);
    chooser.pick('1');
    expect(cb).not.toHaveBeenCalled();
    chooser.dispose();
    expect(cb).toHaveBeenCalledExactlyOnceWith('');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing callback', () => {
    const { chooser } = setup();
    chooser.handleSelect([dev('1', 'A')], () => {
      throw new Error('boom');
    });
    expect(() => chooser.pick('1')).not.toThrow();
    expect(chooser.isActive).toBe(false);
  });
});
