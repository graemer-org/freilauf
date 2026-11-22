import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeviceKind } from '@freilauf/devices';
import type { GroupRider } from '@freilauf/p2p';
import { DEFAULT_SETTINGS, type LiveState, type OverlaySettings } from '../../../shared/contract';
import { OverlayView, type OverlayViewProps } from './OverlayView';
import { MIN_HEIGHT, MIN_WIDTH, computeResizeBounds, deviceWarnings, groupRows } from './logic';

function rider(peerId: string, name: string, gapM: number, extra: Partial<GroupRider> = {}): GroupRider {
  return {
    peerId,
    name,
    distanceM: 1000 + gapM,
    speedMps: 9,
    powerW: 200,
    cadenceRpm: 85,
    heartRateBpm: 140,
    gear: 10,
    gapM,
    stale: false,
    ...extra,
  };
}

function makeLive(over: Partial<LiveState> = {}): LiveState {
  return {
    ride: {
      state: 'riding',
      elapsedS: 3725,
      distanceM: 12_340,
      speedMps: 10,
      powerW: 251,
      power3sW: 263,
      wattsPerKg: 3.5,
      cadenceRpm: 91,
      heartRateBpm: 147,
      gear: 7,
      gearCount: 24,
      gradePercent: 1.2,
    },
    devices: {
      trainer: { name: 'T', state: 'connected' },
      heartRate: null,
      controller: null,
    },
    group: null,
    localName: 'Me',
    ...over,
  };
}

const settings: OverlaySettings = {
  ...DEFAULT_SETTINGS.overlay,
  tiles: [
    { stat: 'cadence', size: 's' },
    { stat: 'power3s', size: 'l' },
    { stat: 'heartRate', size: 'm' },
    { stat: 'time', size: 'm' },
  ],
};

function render(props: Partial<OverlayViewProps> = {}): string {
  return renderToString(
    createElement(OverlayView, { live: makeLive(), settings, editMode: false, ...props }),
  );
}

/** Text content of the element carrying the given data-testid (rough, enough for SSR markup). */
function tileHtml(html: string, stat: string): string {
  const start = html.indexOf(`data-testid="overlay-tile-${stat}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = html.indexOf('data-testid="overlay-tile-', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

describe('OverlayView', () => {
  it('renders tiles in configured order with formatted values', () => {
    const html = render();
    const order = ['cadence', 'power3s', 'heartRate', 'time'].map((s) =>
      html.indexOf(`data-testid="overlay-tile-${s}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('overlay-tile-speed');
    expect(tileHtml(html, 'cadence')).toContain('>91<');
    expect(tileHtml(html, 'power3s')).toContain('>263<');
    expect(tileHtml(html, 'heartRate')).toContain('>147<');
    expect(tileHtml(html, 'time')).toContain('1:02:05');
    expect(html).toContain('ov-tile--l');
    expect(html).toContain('ov-tile--s');
  });

  it('applies backdrop opacity as a CSS variable only', () => {
    const html = render({ settings: { ...settings, backdropOpacity: 0 } });
    expect(html).toContain('--ov-backdrop-alpha:0');
  });

  it('renders the group panel sorted by gap, including the local rider', () => {
    const live = makeLive({
      group: {
        roomCode: 'ABC',
        riders: [rider('b', 'Behind', -40), rider('a', 'Ahead', 120), rider('s', 'Sleepy', -300, { stale: true })],
      },
    });
    const html = render({ live });
    expect(html).toContain('data-testid="overlay-group"');
    const idx = ['Ahead', 'Me', 'Behind', 'Sleepy'].map((n) => html.indexOf(`>${n}<`));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(html).toContain('ov-group-row--local');
    expect(html).toContain('ov-group-row--stale');
    expect(html).toContain('+120 m');
  });

  it('hides the group panel when showGroup is false or there are no riders', () => {
    const live = makeLive({ group: { roomCode: 'ABC', riders: [rider('a', 'Ahead', 5)] } });
    expect(render({ live, settings: { ...settings, showGroup: false } })).not.toContain('overlay-group');
    expect(render({ live: makeLive({ group: { roomCode: 'ABC', riders: [] } }) })).not.toContain('overlay-group');
  });

  it('shows a warning when the trainer is reconnecting', () => {
    const live = makeLive({
      devices: { trainer: { name: 'T', state: 'reconnecting' }, heartRate: null, controller: null },
    });
    const html = render({ live });
    expect(html).toContain('data-testid="overlay-warning"');
    expect(html).toContain('Trainer reconnecting…');
    expect(render()).not.toContain('overlay-warning');
  });

  it('shows Paused / Not recording', () => {
    const paused = makeLive();
    paused.ride = { ...paused.ride, state: 'paused' };
    expect(render({ live: paused })).toContain('Paused');
    const idle = makeLive();
    idle.ride = { ...idle.ride, state: 'idle' };
    const html = render({ live: idle });
    expect(html).toContain('Not recording');
    expect(html).toContain('ov-root--idle');
  });

  it('renders the edit bar, Done and resize grip only in edit mode', () => {
    const plain = render();
    expect(plain).not.toContain('overlay-edit-bar');
    expect(plain).not.toContain('overlay-done');
    expect(plain).not.toContain('overlay-resize');
    const edit = render({ editMode: true });
    expect(edit).toContain('data-testid="overlay-edit-bar"');
    expect(edit).toContain('Overlay edit mode — drag to move, drag the corner to resize');
    expect(edit).toContain('data-testid="overlay-done"');
    expect(edit).toContain('data-testid="overlay-resize"');
  });

  it('renders placeholders when there is no live state', () => {
    const html = render({ live: null });
    expect(html).toContain('data-testid="overlay-root"');
    for (const s of ['cadence', 'power3s', 'heartRate', 'time']) {
      expect(tileHtml(html, s)).toContain('>–<');
    }
    expect(html).not.toContain('overlay-group');
    expect(html).not.toContain('overlay-warning');
  });

  it('shows sample values in edit mode without live state', () => {
    const html = render({ live: null, editMode: true });
    expect(tileHtml(html, 'power3s')).not.toContain('>–<');
  });
});

describe('computeResizeBounds', () => {
  const start = { x: 100, y: 50, width: 400, height: 200 };
  const p0 = { screenX: 500, screenY: 250 };

  it('keeps position and adds the pointer delta', () => {
    expect(computeResizeBounds(start, p0, { screenX: 560, screenY: 230 })).toEqual({
      x: 100,
      y: 50,
      width: 460,
      height: 180,
    });
  });

  it('clamps to the minimum size', () => {
    const b = computeResizeBounds(start, p0, { screenX: 0, screenY: 0 });
    expect(b).toEqual({ x: 100, y: 50, width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it('rounds fractional deltas', () => {
    expect(computeResizeBounds(start, p0, { screenX: 500.6, screenY: 250.4 }).width).toBe(401);
  });
});

describe('deviceWarnings / groupRows', () => {
  const none: ReadonlySet<DeviceKind> = new Set();

  it('warns for a disconnected HR strap only if it had been connected', () => {
    const devices: LiveState['devices'] = {
      trainer: { name: 'T', state: 'connected' },
      heartRate: { name: 'H', state: 'disconnected' },
      controller: null,
    };
    expect(deviceWarnings(devices, none)).toEqual([]);
    expect(deviceWarnings(devices, new Set<DeviceKind>(['heartRate']))).toEqual([
      { kind: 'heartRate', text: 'Heart rate disconnected' },
    ]);
  });

  it('caps at 8 rows and always keeps the local rider', () => {
    const riders = Array.from({ length: 12 }, (_, i) => rider(`p${i}`, `R${i}`, 1000 - i * 10));
    const live = makeLive({ group: { roomCode: 'X', riders } });
    const rows = groupRows(live);
    expect(rows).toHaveLength(8);
    expect(rows.at(-1)?.local).toBe(true);
    expect(rows.filter((r) => r.local)).toHaveLength(1);
  });
});
