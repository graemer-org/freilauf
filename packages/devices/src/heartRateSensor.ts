import { createEmitter } from './emitter';
import type { Unsubscribe } from './emitter';
import { parseHeartRateMeasurement } from './heartRate';
import { ManagedDevice } from './managedDevice';
import type { ManagedDeviceOptions } from './managedDevice';
import type { BlePeripheral, GattConnection, HeartRateSensor } from './types';
import { HEART_RATE_MEASUREMENT, HEART_RATE_SERVICE } from './uuids';

/**
 * Standard BLE Heart Rate Service sensor. Readings of 0 bpm (strap without
 * skin contact) are dropped rather than emitted.
 */
export class BleHeartRateSensor extends ManagedDevice<'heartRate'> implements HeartRateSensor {
  readonly kind = 'heartRate' as const;
  private readonly hrEmitter = createEmitter<number>();

  constructor(peripheral: BlePeripheral, options: ManagedDeviceOptions = {}) {
    super(peripheral, options);
  }

  onHeartRate(listener: (bpm: number) => void): Unsubscribe {
    return this.hrEmitter.on(listener);
  }

  protected async setup(conn: GattConnection): Promise<void> {
    await conn.subscribe(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, (view) => {
      const m = parseHeartRateMeasurement(view);
      if (m && m.bpm > 0) this.hrEmitter.emit(m.bpm);
    });
  }
}
