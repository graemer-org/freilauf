import { describe, expect, it } from 'vitest';
import type { LiveState } from '../../desktop/src/shared/contract';
import { createBrowserApi, EDIT_MODE_MESSAGE, OPEN_FOLDER_MESSAGE, queryFlag } from './browserApi';
import { MemoryRideRecordStore, RideRepository } from './rideRepository';
import { BrowserSettingsStore, webDefaultSettings } from './settingsStore';

function api(overlayWindow = null as Parameters<typeof createBrowserApi>[0]['overlayWindow']) {
  return createBrowserApi({
    settings: new BrowserSettingsStore({
      storage: null,
      defaults: webDefaultSettings({ protocol: 'http:', host: 'localhost:8080' }),
      log: () => {},
    }),
    rides: new RideRepository(new MemoryRideRecordStore(), () => {}),
    simMode: true,
    bleLogEnabled: true,
    overlayWindow,
    diagnosticsLimit: 3,
  });
}

describe('queryFlag', () => {
  it('reads ?sim=1 style flags', () => {
    expect(queryFlag('?sim=1', 'sim')).toBe(true);
    expect(queryFlag('?sim', 'sim')).toBe(true);
    expect(queryFlag('?sim=true&x=2', 'sim')).toBe(true);
    expect(queryFlag('?sim=0', 'sim')).toBe(false);
    expect(queryFlag('', 'sim')).toBe(false);
  });
});

describe('createBrowserApi', () => {
  it('delivers live state in-page', () => {
    const a = api();
    const seen: LiveState[] = [];
    const off = a.live.onState((s) => seen.push(s));
    a.live.publish({ localName: 'x' } as LiveState);
    off();
    a.live.publish({ localName: 'y' } as LiveState);
    expect(seen.map((s) => s.localName)).toEqual(['x']);
  });

  it('never reports overlay edit mode and explains it instead', () => {
    const a = api();
    const notices: string[] = [];
    a.setNotifier((_k, m) => notices.push(m));
    const modes: boolean[] = [];
    a.overlay.onEditMode((e) => modes.push(e));
    a.overlay.setEditMode(true);
    expect(modes).toEqual([false]);
    expect(notices).toEqual([EDIT_MODE_MESSAGE]);
  });

  it('maps overlay bounds to the PiP window when open', async () => {
    let resized: unknown = null;
    const a = api({
      bounds: () => ({ x: 1, y: 2, width: 300, height: 200 }),
      resize: (b) => (resized = b),
    });
    expect(await a.overlay.getBounds()).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    a.overlay.setBounds({ x: 0, y: 0, width: 10, height: 10 });
    expect(resized).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect((await api().overlay.getBounds()).width).toBeGreaterThan(0);
  });

  it('has bluetooth chooser hooks that resolve immediately', async () => {
    const a = api();
    await a.bluetooth.grantUserGesture();
    await a.bluetooth.prepareChooser({ deviceId: 'x', timeoutMs: 1 });
    a.bluetooth.onPickerDevices(() => {})();
  });

  it('explains where rides live instead of opening a folder', async () => {
    const a = api();
    const notices: string[] = [];
    a.setNotifier((_k, m) => notices.push(m));
    await a.rides.openFolder();
    expect(notices).toEqual([OPEN_FOLDER_MESSAGE]);
  });

  it('keeps a bounded in-memory diagnostics log', () => {
    const a = api();
    for (const n of [1, 2, 3, 4]) a.diagnostics.bleLog(`line ${n}`);
    expect(a.diagnosticLines().map((l) => l.split(' ').slice(1).join(' '))).toEqual([
      'line 2',
      'line 3',
      'line 4',
    ]);
  });

  it('defaults the signalling URL to the page origin', async () => {
    expect((await api().settings.get()).group.signallingUrl).toBe('ws://localhost:8080/signal');
  });
});
