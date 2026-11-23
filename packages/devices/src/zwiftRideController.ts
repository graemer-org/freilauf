import { createEmitter } from './emitter';
import type { Unsubscribe } from './emitter';
import { ManagedDevice } from './managedDevice';
import type { ManagedDeviceOptions } from './managedDevice';
import type { BlePeripheral, Controller, ControllerButtonEvent, GattConnection } from './types';
import {
  RideButtonTracker,
  ZWIFT_ASYNC_CHARACTERISTIC,
  ZWIFT_HANDSHAKE,
  ZWIFT_LEGACY_SERVICE,
  ZWIFT_RIDE_SERVICE,
  ZWIFT_SYNC_RX_CHARACTERISTIC,
  ZWIFT_SYNC_TX_CHARACTERISTIC,
  parseZwiftRideMessage,
} from './zwiftRide';

export interface RawFrame {
  characteristic: 'async' | 'syncTx';
  bytes: Uint8Array;
}

/**
 * BLE driver for the Zwift Ride handlebar controllers. Buttons and the lever
 * message layout are verified on hardware; the handshake details are not
 * (docs/protocols/zwift-ride.md), so the driver is deliberately lenient: it
 * does not wait for the handshake answer, and it exposes every raw frame for
 * capture.
 */
export class ZwiftRideController extends ManagedDevice<'controller'> implements Controller {
  readonly kind = 'controller' as const;
  private readonly buttonEmitter = createEmitter<ControllerButtonEvent>();
  private readonly paddleEmitter = createEmitter<{ side: 'left' | 'right'; value: number }>();
  private readonly batteryEmitter = createEmitter<number>();
  private readonly rawEmitter = createEmitter<RawFrame>();
  private readonly tracker = new RideButtonTracker();
  /** Last lever value per grip, so a drop can return a held lever to rest. */
  private readonly levers = { left: 0, right: 0 };

  constructor(peripheral: BlePeripheral, options: ManagedDeviceOptions = {}) {
    super(peripheral, options);
  }

  onButton(listener: (event: ControllerButtonEvent) => void): Unsubscribe {
    return this.buttonEmitter.on(listener);
  }

  onPaddle(listener: (event: { side: 'left' | 'right'; value: number }) => void): Unsubscribe {
    return this.paddleEmitter.on(listener);
  }

  onBattery(listener: (percent: number) => void): Unsubscribe {
    return this.batteryEmitter.on(listener);
  }

  /** Every frame as received, for protocol captures. */
  onRawFrame(listener: (frame: RawFrame) => void): Unsubscribe {
    return this.rawEmitter.on(listener);
  }

  protected async setup(conn: GattConnection): Promise<void> {
    const hasRide = await conn.hasService(ZWIFT_RIDE_SERVICE);
    const service = hasRide ? ZWIFT_RIDE_SERVICE : ZWIFT_LEGACY_SERVICE;
    this.diag(
      'info',
      'service',
      hasRide
        ? 'using Ride service FC82'
        : 'Ride service FC82 not found; trying the legacy service',
      {
        service,
      },
    );

    await conn.subscribe(service, ZWIFT_ASYNC_CHARACTERISTIC, (view) => {
      this.rawEmitter.emit({ characteristic: 'async', bytes: copy(view) });
      const message = parseZwiftRideMessage(view);
      if (message?.type === 'keypad') {
        for (const event of this.tracker.update(message.pressed)) this.buttonEmitter.emit(event);
        for (const paddle of message.paddles) {
          this.levers[paddle.side] = paddle.value;
          this.paddleEmitter.emit(paddle);
        }
      } else if (message?.type === 'battery') {
        this.batteryEmitter.emit(message.percent);
      }
    });
    this.diag('debug', 'subscribed', 'async (button) notifications on');
    // The handshake answer arrives here. Not all firmware may expose it; not fatal.
    await conn
      .subscribe(service, ZWIFT_SYNC_TX_CHARACTERISTIC, (view) => {
        this.rawEmitter.emit({ characteristic: 'syncTx', bytes: copy(view) });
      })
      .then(
        () => this.diag('debug', 'subscribed', 'sync TX indications on'),
        (err: unknown) =>
          this.diag(
            'warn',
            'subscribe-failed',
            'sync TX subscription failed (handshake answer will not be seen)',
            {
              error: err,
            },
          ),
      );
    await conn.write(service, ZWIFT_SYNC_RX_CHARACTERISTIC, ZWIFT_HANDSHAKE);
    this.diag('info', 'handshake', 'wrote "RideOn" to sync RX', { bytes: ZWIFT_HANDSHAKE });
  }

  /** A button or lever held while the link drops must not stay "pressed" forever. */
  protected override onLinkDown(): void {
    for (const event of this.tracker.reset()) this.buttonEmitter.emit(event);
    for (const side of ['left', 'right'] as const) {
      if (this.levers[side] === 0) continue;
      this.levers[side] = 0;
      this.paddleEmitter.emit({ side, value: 0 });
    }
  }
}

function copy(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}
