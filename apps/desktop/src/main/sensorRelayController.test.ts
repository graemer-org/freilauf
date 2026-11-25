import type { RelayInput } from '@freilauf/devices';
import {
  RelayUuid,
  ScControlOp,
  ScControlResult,
  fromRelayHex,
  parseCscMeasurement,
} from '@freilauf/devices';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, WatchRelaySettings, WatchRelayStatus } from '../shared/contract';
import { DEFAULT_WATCH_RELAY } from '../shared/contract';
import type { MainLog } from './logFile';
import type { HelperCallbacks, HelperProcess } from './sensorRelayController';
import {
  KILL_AFTER_MS,
  LIVE_STALE_MS,
  MAX_RESTARTS,
  READY_TIMEOUT_MS,
  RESTART_DELAYS_MS,
  SensorRelayController,
  UPDATE_MS,
  relayInputFromLive,
  sharedKinds,
} from './sensorRelayController';

const decodeCsc = (hex: string) => {
  const b = fromRelayHex(hex);
  return parseCscMeasurement(new DataView(b.buffer, b.byteOffset, b.byteLength))!;
};

const ON: WatchRelaySettings = { ...DEFAULT_WATCH_RELAY, enabled: true };

class FakeHelper implements HelperProcess {
  lines: string[] = [];
  ended = false;
  killed = false;
  readonly cb: HelperCallbacks;
  constructor(cb: HelperCallbacks) {
    this.cb = cb;
  }
  write(line: string): boolean {
    this.lines.push(line);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  kill(): void {
    this.killed = true;
  }
  commands(): { type: string; [k: string]: unknown }[] {
    return this.lines.map((l) => JSON.parse(l) as { type: string });
  }
  types(): string[] {
    return this.commands().map((c) => c.type);
  }
  emit(e: object): void {
    this.cb.stdout(`${JSON.stringify(e)}\n`);
  }
  ready(protocol = 1): void {
    this.emit({ type: 'ready', version: 't', protocol, backend: 'fake' });
  }
  started(services?: string[]): void {
    const start = this.commands()
      .filter((c) => c.type === 'start')
      .at(-1) as { services: { uuid: string }[] } | undefined;
    this.emit({ type: 'started', services: services ?? start?.services.map((s) => s.uuid) ?? [] });
  }
}

function logger(): MainLog & { lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (m: string, c?: object) =>
    lines.push(`${level} ${m}${c ? ` ${JSON.stringify(c)}` : ''}`);
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function setup(opts: { input?: (now: number) => RelayInput | null; spawnThrows?: boolean } = {}) {
  const helpers: FakeHelper[] = [];
  const statuses: WatchRelayStatus[] = [];
  const log = logger();
  const relay = new SensorRelayController({
    spawn: (cb) => {
      if (opts.spawnThrows) throw new Error('ENOENT');
      const h = new FakeHelper(cb);
      helpers.push(h);
      return h;
    },
    unavailableReason: '',
    input: opts.input ?? (() => null),
    computerName: 'TEST-PC',
    log,
    onStatus: (s) => statuses.push(s),
  });
  const last = () => {
    const h = helpers.at(-1);
    if (!h) throw new Error('no helper spawned');
    return h;
  };
  return { relay, helpers, statuses, log, last };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sharedKinds', () => {
  it('lists the chosen kinds in a stable order', () => {
    expect(sharedKinds(DEFAULT_WATCH_RELAY)).toEqual(['heartRate', 'power', 'speedCadence']);
    expect(
      sharedKinds({
        enabled: true,
        share: { trainer: true, heartRate: false, power: false, speedCadence: true },
      }),
    ).toEqual(['speedCadence', 'trainer']);
  });
});

describe('relayInputFromLive', () => {
  const live = (ride: Partial<LiveState['ride']>): LiveState => ({
    ride: {
      state: 'riding',
      elapsedS: 10,
      distanceM: 123,
      speedMps: 8,
      powerW: 200,
      power3sW: 200,
      wattsPerKg: 2.6,
      cadenceRpm: 90,
      heartRateBpm: 140,
      gear: 10,
      gearCount: 24,
      gradePercent: 0,
      ...ride,
    },
    devices: { trainer: null, heartRate: null, controller: null },
    group: null,
    localName: 'R',
  });

  it('takes the ride values while riding', () => {
    expect(relayInputFromLive(live({}), 100)).toEqual({
      heartRateBpm: 140,
      powerW: 200,
      cadenceRpm: 90,
      speedMps: 8,
      distanceM: 123,
    });
  });

  it('has no speed unless riding, and no heart rate without a sensor', () => {
    expect(relayInputFromLive(live({ state: 'paused', speedMps: 5 }), 0)?.speedMps).toBe(0);
    expect(relayInputFromLive(live({ heartRateBpm: null }), 0)?.heartRateBpm).toBeNull();
  });

  it('is null without live values or when they are stale', () => {
    expect(relayInputFromLive(null, 0)).toBeNull();
    expect(relayInputFromLive(live({}), LIVE_STALE_MS + 1)).toBeNull();
    expect(relayInputFromLive(live({}), Number.NaN)).toBeNull();
  });

  it('never passes on negative or non-finite values', () => {
    const r = relayInputFromLive(live({ powerW: -5, cadenceRpm: Number.NaN }), 0);
    expect(r?.powerW).toBe(0);
    expect(r?.cadenceRpm).toBe(0);
  });
});

describe('SensorRelayController', () => {
  it('is unavailable without a helper and never spawns', () => {
    const statuses: WatchRelayStatus[] = [];
    const relay = new SensorRelayController({
      spawn: null,
      unavailableReason: 'Needs Windows.',
      input: () => null,
      computerName: 'x',
      log: logger(),
      onStatus: (s) => statuses.push(s),
    });
    relay.configure(ON);
    expect(relay.status).toEqual({ state: 'unavailable', reason: 'Needs Windows.' });
    expect(statuses).toEqual([]);
  });

  it('stays off until enabled; nothing to share counts as off', () => {
    const { relay, helpers } = setup();
    relay.configure(DEFAULT_WATCH_RELAY);
    relay.configure({
      enabled: true,
      share: { heartRate: false, power: false, speedCadence: false, trainer: false },
    });
    expect(helpers).toHaveLength(0);
    expect(relay.status).toEqual({ state: 'off' });
  });

  it('handshakes, starts the chosen services and reports sharing', () => {
    const { relay, last, statuses } = setup();
    relay.configure(ON);
    expect(relay.status).toEqual({ state: 'starting' });
    last().ready();
    const start = last().commands()[0] as unknown as { type: string; services: { uuid: string }[] };
    expect(start.type).toBe('start');
    expect(start.services.map((s) => s.uuid)).toEqual([
      RelayUuid.heartRateService,
      RelayUuid.cyclingPowerService,
      RelayUuid.cscService,
    ]);
    last().started();
    expect(relay.status).toEqual({
      state: 'sharing',
      devices: 0,
      sharing: ['heartRate', 'power', 'speedCadence'],
      computerName: 'TEST-PC',
    });
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'sharing']);
  });

  it('counts subscribed watches across characteristics', () => {
    const { relay, last } = setup();
    relay.configure(ON);
    last().ready();
    last().started();
    const sub = (service: string, characteristic: string, centrals: string[]) =>
      last().emit({ type: 'subscribers', service, characteristic, centrals });
    sub(RelayUuid.cyclingPowerService, RelayUuid.cyclingPowerMeasurement, ['c1']);
    expect(relay.status).toMatchObject({ state: 'sharing', devices: 1 });
    sub(RelayUuid.heartRateService, RelayUuid.heartRateMeasurement, ['c1']);
    sub(RelayUuid.cscService, RelayUuid.cscMeasurement, ['c2']);
    expect(relay.status).toMatchObject({ devices: 2 });
    sub(RelayUuid.cscService, RelayUuid.cscMeasurement, []);
    sub(RelayUuid.cyclingPowerService, RelayUuid.cyclingPowerMeasurement, []);
    expect(relay.status).toMatchObject({ devices: 1 });
    sub(RelayUuid.heartRateService, RelayUuid.heartRateMeasurement, []);
    expect(relay.status).toMatchObject({ state: 'sharing', devices: 0 });
  });

  it('sends updates at most every UPDATE_MS, only for published services', () => {
    let distanceM = 0;
    const { relay, last } = setup({
      input: () => ({
        heartRateBpm: 150,
        powerW: 250,
        cadenceRpm: 90,
        speedMps: 10,
        distanceM: (distanceM += 2.5),
      }),
    });
    relay.configure(ON);
    last().ready();
    // The power service failed to publish (partial start).
    last().started([RelayUuid.heartRateService, RelayUuid.cscService]);
    const before = last().lines.length;
    vi.advanceTimersByTime(10_000);
    const notifies = last()
      .commands()
      .slice(before)
      .filter((c) => c.type === 'notify') as unknown as {
      characteristic: string;
      value: string;
    }[];
    const perChar = new Map<string, number>();
    for (const n of notifies)
      perChar.set(n.characteristic, (perChar.get(n.characteristic) ?? 0) + 1);
    expect(perChar.get(RelayUuid.cyclingPowerMeasurement)).toBeUndefined();
    expect(perChar.get(RelayUuid.heartRateMeasurement)).toBe(10_000 / UPDATE_MS);
    expect(perChar.get(RelayUuid.cscMeasurement)).toBe(10_000 / UPDATE_MS);
    const csc = decodeCsc(
      notifies.filter((n) => n.characteristic === RelayUuid.cscMeasurement).at(-1)!.value,
    );
    // 40 updates × 2.5 m (the first only sets the base) ≈ 97.5 m / 2.105 m ≈ 46 turns.
    expect(csc.wheel?.cumulativeRevs).toBeGreaterThanOrEqual(45);
    expect(csc.wheel?.cumulativeRevs).toBeLessThanOrEqual(47);
    // 90 rpm for ~9.75 s ≈ 14 crank turns.
    expect(csc.crank?.cumulativeRevs).toBeGreaterThanOrEqual(13);
    expect(csc.crank?.cumulativeRevs).toBeLessThanOrEqual(15);
  });

  it('answers a Set Cumulative Value write with an indication', () => {
    const { relay, last } = setup();
    relay.configure(ON);
    last().ready();
    last().started();
    const before = last().lines.length;
    last().emit({
      type: 'write',
      service: RelayUuid.cscService,
      characteristic: RelayUuid.scControlPoint,
      value: '0100000000',
      central: 'c1',
    });
    const reply = last().commands().slice(before)[0] as unknown as {
      type: string;
      characteristic: string;
      value: string;
    };
    expect(reply.type).toBe('notify');
    expect(reply.characteristic).toBe(RelayUuid.scControlPoint);
    expect([...fromRelayHex(reply.value)]).toEqual([
      ScControlOp.ResponseCode,
      ScControlOp.SetCumulativeValue,
      ScControlResult.Success,
    ]);
  });

  it('turning off sends stop and quit, closes stdin and kills a stuck helper', () => {
    const { relay, last } = setup();
    relay.configure(ON);
    last().ready();
    last().started();
    relay.configure(DEFAULT_WATCH_RELAY);
    expect(last().types().slice(-2)).toEqual(['stop', 'quit']);
    expect(last().ended).toBe(true);
    expect(relay.status).toEqual({ state: 'off' });
    vi.advanceTimersByTime(KILL_AFTER_MS);
    expect(last().killed).toBe(true);
    // Its late exit is not a failure.
    last().cb.exit({ code: 0, signal: null });
    expect(relay.status).toEqual({ state: 'off' });
  });

  it('re-sends start with the new set when the choice changes', () => {
    const { relay, last, helpers } = setup();
    relay.configure(ON);
    last().ready();
    last().started();
    relay.configure({ enabled: true, share: { ...ON.share, heartRate: false } });
    expect(helpers).toHaveLength(1);
    const start = last().commands().at(-1) as unknown as { type: string; services: unknown[] };
    expect(start.type).toBe('start');
    expect(start.services).toHaveLength(2);
  });

  it('ignores settings changes that do not touch sharing', () => {
    const { relay, last, helpers } = setup();
    relay.configure(ON);
    last().ready();
    relay.configure({ ...ON, share: { ...ON.share } });
    expect(helpers).toHaveLength(1);
    expect(last().types()).toEqual(['start']);
  });

  it('reports unsupported, stops the helper and does not retry', () => {
    const { relay, last, helpers } = setup();
    relay.configure(ON);
    last().ready();
    last().emit({ type: 'unsupported', reason: 'No peripheral role.' });
    expect(relay.status).toEqual({ state: 'unsupported', reason: 'No peripheral role.' });
    expect(last().ended).toBe(true);
    last().cb.exit({ code: 0, signal: null });
    vi.advanceTimersByTime(120_000);
    expect(helpers).toHaveLength(1);
    // Off and on again tries again.
    relay.configure(DEFAULT_WATCH_RELAY);
    relay.configure(ON);
    expect(helpers).toHaveLength(2);
  });

  it('refuses a helper with another protocol version', () => {
    const { relay, last, helpers } = setup();
    relay.configure(ON);
    last().ready(2);
    expect(relay.status).toMatchObject({ state: 'error', retrying: false });
    expect(last().types()).toEqual(['stop', 'quit']);
    last().cb.exit({ code: 0, signal: null });
    vi.advanceTimersByTime(120_000);
    expect(helpers).toHaveLength(1);
  });

  it('restarts a helper that died, with backoff, and keeps the counters', () => {
    const { relay, last, helpers } = setup({
      input: () => ({
        heartRateBpm: null,
        powerW: 200,
        cadenceRpm: 120,
        speedMps: 0,
        distanceM: 0,
      }),
    });
    relay.configure(ON);
    last().ready();
    last().started();
    vi.advanceTimersByTime(5000);
    const crankBefore = lastCrank(last());
    last().cb.exit({ code: null, signal: 'SIGKILL' });
    expect(relay.status).toMatchObject({ state: 'error', retrying: true });
    vi.advanceTimersByTime((RESTART_DELAYS_MS[0] ?? 0) - 1);
    expect(helpers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(helpers).toHaveLength(2);
    last().ready();
    last().started();
    vi.advanceTimersByTime(1000);
    expect(lastCrank(last())).toBeGreaterThanOrEqual(crankBefore);
    expect(relay.status).toMatchObject({ state: 'sharing' });
  });

  it('kills a helper that never says ready, then gives up after repeated failures', () => {
    const { relay, helpers } = setup();
    relay.configure(ON);
    for (let i = 0; i <= MAX_RESTARTS; i++) {
      const h = helpers.at(-1)!;
      vi.advanceTimersByTime(READY_TIMEOUT_MS);
      expect(h.killed).toBe(true);
      h.cb.exit({ code: null, signal: 'SIGTERM' });
      vi.advanceTimersByTime(60_000);
    }
    expect(helpers).toHaveLength(MAX_RESTARTS + 1);
    expect(relay.status).toMatchObject({ state: 'error', retrying: false });
  });

  it('retries a failed start on the running helper', () => {
    const { relay, last, helpers } = setup();
    relay.configure(ON);
    last().ready();
    last().emit({
      type: 'error',
      message: 'start failed: the Bluetooth radio is off or not available',
    });
    expect(relay.status).toEqual({
      state: 'error',
      message: 'Could not start sharing: the Bluetooth radio is off or not available',
      retrying: true,
    });
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0] ?? 0);
    expect(helpers).toHaveLength(1);
    expect(last().types()).toEqual(['start', 'start']);
  });

  it('survives a spawn that throws', () => {
    const { relay } = setup({ spawnThrows: true });
    relay.configure(ON);
    expect(relay.status).toMatchObject({ state: 'error', retrying: true });
  });

  it('logs helper stderr and unexpected output, without crashing', () => {
    const { relay, last, log } = setup();
    relay.configure(ON);
    last().cb.stderr('freilauf-sensor-relay: adapter: lowEnergy=true\n');
    last().cb.stdout('not json\n{"type":"ready","version":"t","protocol":1,"backend":"fake"}\n');
    expect(log.lines.some((l) => l.includes('helper: freilauf-sensor-relay: adapter'))).toBe(true);
    expect(log.lines.some((l) => l.includes('unexpected helper output'))).toBe(true);
    expect(last().types()).toEqual(['start']);
  });

  it('dispose stops a running helper', () => {
    const { relay, last } = setup();
    relay.configure(ON);
    last().ready();
    last().started();
    relay.dispose();
    expect(last().types().slice(-2)).toEqual(['stop', 'quit']);
    expect(last().ended).toBe(true);
  });
});

function lastCrank(h: FakeHelper): number {
  const n = h
    .commands()
    .filter((c) => c.type === 'notify' && c.characteristic === RelayUuid.cscMeasurement)
    .at(-1) as unknown as { value: string } | undefined;
  return n ? (decodeCsc(n.value).crank?.cumulativeRevs ?? 0) : 0;
}
