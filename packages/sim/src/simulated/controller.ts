import { createEmitter } from '@freilauf/devices';
import type {
  Controller,
  ControllerButton,
  ControllerButtonEvent,
  Unsubscribe,
} from '@freilauf/devices';
import { SimulatedDevice } from './device-base';
import type { SimulatedDeviceOptions } from './device-base';

export type PaddleSide = 'left' | 'right';

export type SimulatedControllerOptions = SimulatedDeviceOptions;

/**
 * A handlebar controller driven programmatically (tests, keyboard shortcuts in
 * sim mode). Events are only emitted while connected, like a real controller.
 */
export class SimulatedController extends SimulatedDevice<'controller'> implements Controller {
  readonly kind = 'controller' as const;

  private readonly buttonEmitter = createEmitter<ControllerButtonEvent>();
  private readonly paddleEmitter = createEmitter<{ side: PaddleSide; value: number }>();
  private readonly held = new Set<ControllerButton>();

  constructor(options: SimulatedControllerOptions = {}) {
    super({ id: 'sim-controller', name: 'Simulated Controller' }, options);
  }

  onButton(listener: (event: ControllerButtonEvent) => void): Unsubscribe {
    return this.buttonEmitter.on(listener);
  }

  onPaddle(listener: (event: { side: PaddleSide; value: number }) => void): Unsubscribe {
    return this.paddleEmitter.on(listener);
  }

  /** Returns false (and emits nothing) when not connected. */
  press(button: ControllerButton): boolean {
    if (this.state !== 'connected') return false;
    this.held.add(button);
    this.buttonEmitter.emit({ button, pressed: true });
    return true;
  }

  release(button: ControllerButton): boolean {
    if (this.state !== 'connected') return false;
    this.held.delete(button);
    this.buttonEmitter.emit({ button, pressed: false });
    return true;
  }

  /** press() followed immediately by release(). */
  tap(button: ControllerButton): boolean {
    return this.press(button) && this.release(button);
  }

  isHeld(button: ControllerButton): boolean {
    return this.held.has(button);
  }

  /** value is clamped to -1 … 1. */
  setPaddle(side: PaddleSide, value: number): boolean {
    if (this.state !== 'connected') return false;
    this.paddleEmitter.emit({ side, value: Math.max(-1, Math.min(1, value)) });
    return true;
  }

  protected override onLinkLost(): void {
    // A dropped link means we will never see the releases; forget held buttons.
    this.held.clear();
  }
}
