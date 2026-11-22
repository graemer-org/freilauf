import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../desktop/src/shared/contract';
import { defaultSignallingUrl } from './signallingUrl';

describe('defaultSignallingUrl', () => {
  it('uses the page origin and /signal', () => {
    expect(defaultSignallingUrl({ protocol: 'http:', host: 'localhost:8080' })).toBe(
      'ws://localhost:8080/signal',
    );
    expect(defaultSignallingUrl({ protocol: 'https:', host: 'freilauf.example.org' })).toBe(
      'wss://freilauf.example.org/signal',
    );
    expect(defaultSignallingUrl({ protocol: 'https:', host: '[::1]:8443' })).toBe(
      'wss://[::1]:8443/signal',
    );
  });

  it('falls back to the desktop default off http(s)', () => {
    const fallback = DEFAULT_SETTINGS.group.signallingUrl;
    expect(defaultSignallingUrl({ protocol: 'file:', host: '' })).toBe(fallback);
    expect(defaultSignallingUrl({ protocol: 'chrome-extension:', host: 'abc' })).toBe(fallback);
  });
});
