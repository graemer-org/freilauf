/**
 * Watches attached devices for the diagnostic log: state transitions with
 * timing, the driver's own lifecycle steps (DeviceDiagnostic), the first data
 * packet and then a summary every 30 s instead of every packet. Pure apart
 * from the injected clock (unit-tested in deviceMonitor.test.ts).
 */
import type {
  ConnectionState,
  Controller,
  DeviceDiagnostic,
  DeviceKind,
  HeartRateSensor,
  Trainer,
  Unsubscribe,
} from '@freilauf/devices';
import type { ScopedLog } from './logger';

export const SUMMARY_INTERVAL_MS = 30_000;

type AnyDevice = Trainer | HeartRateSensor | Controller;

interface Watched {
  kind: DeviceKind;
  name: string;
  id: string;
  state: ConnectionState;
  stateSince: number;
  packets: number;
  packetsAtSummary: number;
  firstPacketLogged: boolean;
  last: Record<string, number>;
  lastSummaryAt: number;
  off: Unsubscribe[];
}

function hasDiagnostics(
  d: unknown,
): d is { onDiagnostic(l: (e: DeviceDiagnostic) => void): Unsubscribe } {
  return typeof (d as { onDiagnostic?: unknown }).onDiagnostic === 'function';
}

export class DeviceMonitor {
  readonly #log: ScopedLog;
  readonly #now: () => number;
  readonly #watched = new Map<DeviceKind, Watched>();

  constructor(log: ScopedLog, now: () => number = Date.now) {
    this.#log = log;
    this.#now = now;
  }

  /** Starts watching; replaces any earlier device of the same kind. */
  watch(device: AnyDevice): void {
    this.unwatch(device.kind);
    const now = this.#now();
    const w: Watched = {
      kind: device.kind,
      name: device.name,
      id: device.id,
      state: device.state,
      stateSince: now,
      packets: 0,
      packetsAtSummary: 0,
      firstPacketLogged: false,
      last: {},
      lastSummaryAt: now,
      off: [],
    };
    this.#watched.set(device.kind, w);
    const label = `${device.kind} "${device.name}"`;

    w.off.push(
      device.onState((state) => {
        const t = this.#now();
        const level =
          state === 'reconnecting' || (state === 'disconnected' && w.state === 'connected')
            ? 'warn'
            : 'info';
        this.#log[level](`${label} ${w.state} → ${state}`, {
          id: w.id,
          afterMs: t - w.stateSince,
        });
        w.state = state;
        w.stateSince = t;
        if (state === 'connected') {
          w.lastSummaryAt = t;
          w.packetsAtSummary = w.packets;
        }
      }),
    );
    if (hasDiagnostics(device)) {
      w.off.push(
        device.onDiagnostic((d) => {
          const context: Record<string, unknown> = { event: d.event, ...d.context };
          this.#log[d.level](`${label}: ${d.message}`, context);
        }),
      );
    }

    // Every battery change, from the Battery Service or the controllers' own message.
    if (device.onBattery) {
      w.off.push(
        device.onBattery((b) => {
          const sides =
            b.left !== undefined || b.right !== undefined
              ? [
                  b.left !== undefined ? `left ${b.left}%` : null,
                  b.right !== undefined ? `right ${b.right}%` : null,
                ]
                  .filter(Boolean)
                  .join(', ')
              : `${b.percent}%`;
          this.#log.info(`${label}: battery ${sides}`, {
            percent: b.percent,
            ...(b.left !== undefined ? { left: b.left } : {}),
            ...(b.right !== undefined ? { right: b.right } : {}),
            source: b.source,
          });
        }),
      );
    }

    const packet = (values: Record<string, number | undefined>) => {
      w.packets++;
      for (const [k, v] of Object.entries(values)) if (v !== undefined) w.last[k] = v;
      if (!w.firstPacketLogged) {
        w.firstPacketLogged = true;
        this.#log.info(`${label}: first data`, {
          afterConnectMs: this.#now() - w.stateSince,
          ...values,
        });
      }
    };
    if (device.kind === 'trainer') {
      w.off.push(
        device.onData((d) =>
          packet({ powerW: d.powerW, cadenceRpm: d.cadenceRpm, speedKph: d.speedKph }),
        ),
      );
    } else if (device.kind === 'heartRate') {
      w.off.push(device.onHeartRate((bpm) => packet({ bpm })));
    } else {
      w.off.push(device.onButton((e) => packet({ [e.button]: e.pressed ? 1 : 0 })));
    }
  }

  unwatch(kind: DeviceKind): void {
    const w = this.#watched.get(kind);
    if (!w) return;
    for (const off of w.off) off();
    this.#watched.delete(kind);
  }

  /** Call regularly (the app's 250 ms tick); writes a summary per connected device every 30 s. */
  tick(): void {
    const now = this.#now();
    for (const w of this.#watched.values()) {
      if (w.state !== 'connected' || now - w.lastSummaryAt < SUMMARY_INTERVAL_MS) continue;
      const packets = w.packets - w.packetsAtSummary;
      const seconds = (now - w.lastSummaryAt) / 1000;
      w.lastSummaryAt = now;
      w.packetsAtSummary = w.packets;
      const context: Record<string, unknown> = {
        packets,
        perS: Math.round((packets / seconds) * 10) / 10,
      };
      if (w.kind !== 'controller') Object.assign(context, w.last);
      const level = packets === 0 && w.kind !== 'controller' ? 'warn' : 'debug';
      this.#log[level](
        `${w.kind} "${w.name}": ${packets} packets in the last ${Math.round(seconds)} s`,
        context,
      );
    }
  }

  dispose(): void {
    for (const kind of [...this.#watched.keys()]) this.unwatch(kind);
  }
}
