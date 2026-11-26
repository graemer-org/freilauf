import type { Unsubscribe } from '@freilauf/devices';
import type { SimScheduler } from './clock';
import { SimulatedController } from './controller';
import type { SimulatedControllerOptions } from './controller';
import { SimulatedHeartRate } from './heart-rate';
import type { SimulatedHeartRateOptions } from './heart-rate';
import { SimulatedTrainer } from './trainer';
import type { SimulatedTrainerOptions } from './trainer';

export interface SimulatedRigOptions {
  /** Base seed; each device gets a distinct seed derived from it. Default 1. */
  seed?: number;
  /** Shared scheduler/clock for all devices (per-device options override). */
  scheduler?: SimScheduler;
  trainer?: SimulatedTrainerOptions;
  heartRate?: SimulatedHeartRateOptions;
  controller?: SimulatedControllerOptions;
}

export interface SimulatedRig {
  trainer: SimulatedTrainer;
  heartRate: SimulatedHeartRate;
  controller: SimulatedController;
  /** Unwires the devices and disconnects them (stopping all timers). */
  dispose(): Promise<void>;
}

/** Battery levels of the rig's devices unless the options say otherwise (the trainer has none). */
export const DEFAULT_SIM_BATTERY = {
  heartRate: { percent: 64 },
  controller: { left: 81, right: 12 },
} as const;

/**
 * Trainer + HR strap + controller, with the heart rate following the trainer's power. The HR
 * strap and the controllers report battery levels (DEFAULT_SIM_BATTERY); change them with
 * each device's setBattery().
 */
export function createSimulatedRig(options: SimulatedRigOptions = {}): SimulatedRig {
  const seed = options.seed ?? 1;
  const shared = options.scheduler ? { scheduler: options.scheduler } : {};
  const trainer = new SimulatedTrainer({ ...shared, seed, ...options.trainer });
  const heartRate = new SimulatedHeartRate({
    ...shared,
    seed: seed + 1,
    battery: { ...DEFAULT_SIM_BATTERY.heartRate },
    ...options.heartRate,
  });
  const controller = new SimulatedController({
    ...shared,
    battery: { ...DEFAULT_SIM_BATTERY.controller },
    ...options.controller,
  });

  const subscriptions: Unsubscribe[] = [
    trainer.onData((d) => heartRate.setPower(d.powerW ?? 0)),
    trainer.onState((s) => {
      if (s !== 'connected') heartRate.setPower(0);
    }),
  ];

  return {
    trainer,
    heartRate,
    controller,
    async dispose() {
      for (const off of subscriptions.splice(0)) off();
      await Promise.all([trainer.disconnect(), heartRate.disconnect(), controller.disconnect()]);
    },
  };
}
