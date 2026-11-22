import { describe, expect, it } from 'vitest';
import { bluetoothAvailability, type BluetoothEnvironment } from './bluetoothAvailability';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1';

const base: BluetoothEnvironment = {
  hasBluetoothApi: true,
  isSecureContext: true,
  protocol: 'https:',
  host: 'nas.example',
  userAgent: CHROME,
};

describe('bluetoothAvailability', () => {
  it('is available in Chrome over HTTPS', () => {
    expect(bluetoothAvailability(base)).toEqual({ available: true });
  });

  it('explains insecure contexts first, naming the address', () => {
    const r = bluetoothAvailability({
      ...base,
      isSecureContext: false,
      hasBluetoothApi: false,
      protocol: 'http:',
      host: '192.168.1.10:8080',
    });
    expect(r).toMatchObject({ available: false, reason: 'insecure-context' });
    if (!r.available) {
      expect(r.message).toContain('http://192.168.1.10:8080');
      expect(r.message).toMatch(/HTTPS/);
      expect(r.message).toMatch(/localhost/);
      expect(r.message).toMatch(/\?sim=1/);
    }
  });

  it('names unsupported browsers', () => {
    for (const [ua, text] of [
      [FIREFOX, /Firefox/],
      [SAFARI, /Safari/],
      [IOS_CHROME, /iPhone/],
    ] as const) {
      const r = bluetoothAvailability({ ...base, hasBluetoothApi: false, userAgent: ua });
      expect(r).toMatchObject({ available: false, reason: 'unsupported-browser' });
      if (!r.available) {
        expect(r.message).toMatch(text);
        expect(r.message).toMatch(/Chrome or Edge/);
      }
    }
  });

  it('points Brave users to the flag', () => {
    const r = bluetoothAvailability({ ...base, hasBluetoothApi: false, isBrave: true });
    expect(r).toMatchObject({ available: false, reason: 'disabled-in-browser' });
    if (!r.available) expect(r.message).toContain('brave://flags');
  });

  it('reports a missing adapter', () => {
    expect(bluetoothAvailability({ ...base, adapterAvailable: false })).toMatchObject({
      available: false,
      reason: 'no-adapter',
    });
    expect(bluetoothAvailability({ ...base, adapterAvailable: true })).toEqual({ available: true });
  });
});
