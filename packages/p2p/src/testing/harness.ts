import { GroupRide, type GroupRideDeps } from '../group';
import type { FakeClock } from './fakeClock';
import { FakeRtcNetwork, type FakeLinkConditions } from './fakeRtc';
import { FakeTrysteroNetwork } from './fakeTrystero';
import { InMemorySignallingHub } from './memorySignalling';

/**
 * Runs the same GroupRide test on both transports: `self-hosted` (in-memory signalling + fake
 * WebRTC, unreliable and unordered) and `relays` (fake Trystero, reliable and ordered).
 */
export type TestTransportKind = 'self-hosted' | 'relays';
export const TEST_TRANSPORTS: readonly TestTransportKind[] = ['self-hosted', 'relays'];

export interface TestGroupNetwork {
  readonly kind: TestTransportKind;
  /** Self-hosted only. */
  readonly rtc: FakeRtcNetwork | null;
  /** Relays only. */
  readonly relays: FakeTrysteroNetwork | null;
  /** Deps for a rider with `peerId` (relay rides: without the secret; create/join add it). */
  deps(peerId: string, extra?: Partial<GroupRideDeps>): GroupRideDeps;
  create(name: string, peerId: string, extra?: Partial<GroupRideDeps>): Promise<GroupRide>;
  /** Joins the room of `host` (code and, for relays, secret). */
  join(
    host: Pick<GroupRide, 'roomCode' | 'secret'>,
    name: string,
    peerId: string,
    extra?: Partial<GroupRideDeps>,
  ): Promise<GroupRide>;
  /**
   * Link conditions for data messages. Relays: only `maxDelayMs` applies — the channel is
   * reliable and ordered, so loss, duplicates and reordering do not reach our layer.
   */
  setConditions(conditions: FakeLinkConditions): void;
  /** Every data message any rider sent so far (state, documents; not the relay hello). */
  sentMessages(): string[];
  /** Messages lost to `lossRate` (always 0 for relays). */
  readonly dropped: number;
  /** Delivers `raw` to `to` as if `from` had sent it (self-hosted: see the implementation). */
  inject(from: GroupRide, to: GroupRide, raw: string): void;
}

export interface TestNetworkOptions {
  clock: FakeClock;
  seed?: number;
}

export function createTestNetwork(
  kind: TestTransportKind,
  { clock, seed = 1 }: TestNetworkOptions,
): TestGroupNetwork {
  if (kind === 'self-hosted') {
    const hub = new InMemorySignallingHub();
    const rtc = new FakeRtcNetwork({ seed, timers: clock.timers });
    const deps = (peerId: string, extra: Partial<GroupRideDeps> = {}): GroupRideDeps => ({
      signalling: hub.createChannel(peerId),
      createPeerConnection: rtc.createPeerConnection,
      now: clock.now,
      timers: clock.timers,
      ...extra,
    });
    return {
      kind,
      rtc,
      relays: null,
      deps,
      create: (name, peerId, extra) => GroupRide.create(name, deps(peerId, extra)),
      join: (host, name, peerId, extra) => GroupRide.join(host.roomCode, name, deps(peerId, extra)),
      setConditions: (c) => {
        rtc.conditions = { ...c };
      },
      sentMessages: () => rtc.connections.flatMap((pc) => pc.channels.flatMap((ch) => ch.sent)),
      get dropped() {
        return rtc.dropped;
      },
      // The fake RTC network does not know peer ids: sends on the first open connection, from
      // one of its two ends. Enough for two-rider tests.
      inject: (_from, _to, raw) => rtc.open[0]?.channels[0]?.send(raw),
    } satisfies TestGroupNetwork;
  }
  const relays = new FakeTrysteroNetwork({ seed, timers: clock.timers, now: clock.now });
  const deps = (peerId: string, extra: Partial<GroupRideDeps> = {}): GroupRideDeps => ({
    relay: { trystero: relays.moduleFor(peerId), ...extra.relay },
    now: clock.now,
    timers: clock.timers,
    ...extra,
  });
  const withSecret = (
    peerId: string,
    secret: string | undefined,
    extra?: Partial<GroupRideDeps>,
  ) => {
    const d = deps(peerId, extra);
    return { ...d, relay: { ...d.relay, ...(secret ? { secret } : {}) } };
  };
  return {
    kind,
    rtc: null,
    relays,
    deps,
    create: (name, peerId, extra) => GroupRide.create(name, withSecret(peerId, undefined, extra)),
    join: (host, name, peerId, extra) =>
      GroupRide.join(host.roomCode, name, withSecret(peerId, host.secret, extra)),
    setConditions: (c) => {
      relays.conditions = { ...relays.conditions, maxDelayMs: c.maxDelayMs ?? 0 };
    },
    sentMessages: () => relays.sent.filter((m) => m.action === 'fl-msg').map((m) => m.data),
    dropped: 0,
    inject: (from, to, raw) => relays.inject(from.localPeerId, to.localPeerId, 'fl-msg', raw),
  };
}
