import { describe, expect, it, vi } from 'vitest';
import {
  BrowserBluetoothTransport,
  UnavailableBluetoothTransport,
  type BluetoothLike,
} from './browserBluetoothTransport';

class FakeDevice extends EventTarget {
  readonly gatt = { connected: false } as BluetoothRemoteGATTServer;
  readonly id: string;
  readonly name: string;
  readonly #advertises: boolean;
  watchCalls = 0;
  watchAdvertisements: (() => Promise<void>) | undefined = async () => {
    this.watchCalls++;
    if (this.#advertises) {
      setTimeout(() => this.dispatchEvent(new Event('advertisementreceived')), 1);
    }
  };

  constructor(id: string, name: string, advertises: boolean | 'unsupported') {
    super();
    this.id = id;
    this.name = name;
    this.#advertises = advertises === true;
    if (advertises === 'unsupported') this.watchAdvertisements = undefined;
  }
}

function bluetooth(
  devices: FakeDevice[] | null,
  picked?: FakeDevice,
): BluetoothLike & {
  requestDevice: ReturnType<typeof vi.fn>;
} {
  const requestDevice = vi.fn(async () => {
    if (!picked) throw new DOMException('cancelled', 'NotFoundError');
    return picked as unknown as BluetoothDevice;
  });
  return {
    requestDevice,
    ...(devices ? { getDevices: async () => devices as unknown as BluetoothDevice[] } : {}),
  };
}

const opts = (gesture = false) => ({
  hasUserActivation: () => gesture,
  advertisementTimeoutMs: 20,
});

describe('BrowserBluetoothTransport', () => {
  it('never uses the in-app picker', () => {
    expect(new BrowserBluetoothTransport(bluetooth(null)).usesInAppPicker).toBe(false);
  });

  it('pairs through the browser chooser and remembers BluetoothDevice.id', async () => {
    const bt = bluetooth(null, new FakeDevice('origin-id-1', 'KICKR', true));
    const p = await new BrowserBluetoothTransport(bt, opts()).requestDevice('trainer');
    expect(p).toMatchObject({ id: 'origin-id-1', name: 'KICKR' });
    expect(bt.requestDevice).toHaveBeenCalledOnce();
  });

  it('re-acquires a permitted device once it advertises', async () => {
    const dev = new FakeDevice('id-1', 'KICKR', true);
    const t = new BrowserBluetoothTransport(
      bluetooth([new FakeDevice('other', 'x', true), dev]),
      opts(),
    );
    const p = await t.findKnownDevice('trainer', 'id-1');
    expect(p?.id).toBe('id-1');
    expect(dev.watchCalls).toBe(1);
  });

  it('returns null when a permitted device does not advertise in time', async () => {
    const t = new BrowserBluetoothTransport(
      bluetooth([new FakeDevice('id-1', 'K', false)]),
      opts(),
    );
    expect(await t.findKnownDevice('trainer', 'id-1')).toBeNull();
  });

  it('lets the connect attempt decide without watchAdvertisements', async () => {
    const t = new BrowserBluetoothTransport(
      bluetooth([new FakeDevice('id-1', 'K', 'unsupported')]),
      opts(),
    );
    expect((await t.findKnownDevice('trainer', 'id-1'))?.id).toBe('id-1');
  });

  it('stays remembered-not-connected on start without getDevices (no gesture, no chooser)', async () => {
    const bt = bluetooth(null, new FakeDevice('id-1', 'K', true));
    const t = new BrowserBluetoothTransport(bt, opts(false));
    expect(await t.findKnownDevice('trainer', 'id-1')).toBeNull();
    expect(bt.requestDevice).not.toHaveBeenCalled();
  });

  it('opens the chooser on Retry (user gesture) when the device cannot be re-acquired', async () => {
    const bt = bluetooth([], new FakeDevice('new-id', 'K', true));
    const t = new BrowserBluetoothTransport(bt, opts(true));
    expect((await t.findKnownDevice('trainer', 'old-id'))?.id).toBe('new-id');
    const cancelled = new BrowserBluetoothTransport(bluetooth([]), opts(true));
    expect(await cancelled.findKnownDevice('trainer', 'old-id')).toBeNull();
  });
});

describe('UnavailableBluetoothTransport', () => {
  it('explains instead of pairing, and never finds devices', async () => {
    const t = new UnavailableBluetoothTransport('Bluetooth needs HTTPS.');
    await expect(t.requestDevice()).rejects.toThrow('Bluetooth needs HTTPS.');
    expect(await t.findKnownDevice()).toBeNull();
    expect(t.usesInAppPicker).toBe(false);
  });
});
