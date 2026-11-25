/**
 * What both ride scenes draw for power-ups (docs/power-ups.md), from the 4 Hz live state:
 * pick-up gates ahead (moved on with the scene between samples), the active effect, and a
 * short flash when one is picked up. Pure bookkeeping; the renderers do the drawing.
 */
import type { PowerUpKind, PowerUpLive } from '../../../../shared/powerUps';

export interface PowerUpSceneFrame {
  /** Pick-up gates ahead of the rider, metres (nearest first). */
  gates: number[];
  /** Holding a power-up: gates are drawn quieter (riding through one skips it). */
  holding: boolean;
  /** The effect in progress, if any. */
  effect: PowerUpKind | null;
  phase: 'armed' | 'active' | null;
  /** 0 … 1 through the pick-up flash, or −1 when none is playing. */
  flash: number;
  /** Seconds, for gently moving cues (streaks, chevrons). */
  timeS: number;
}

export const EMPTY_POWER_UP_FRAME: PowerUpSceneFrame = {
  gates: [],
  holding: false,
  effect: null,
  phase: null,
  flash: -1,
  timeS: 0,
};

/** Length of the pick-up flash, ms. */
export const FLASH_MS = 700;
/** Gates further ahead than this are not drawn (only announced). */
export const GATE_DRAW_M = 420;

export class PowerUpSceneState {
  #live: PowerUpLive | null = null;
  /** Scene position (m) when the live sample arrived. */
  #at = 0;
  #seq: number | null = null;
  #flashAt = Number.NEGATIVE_INFINITY;
  readonly frame: PowerUpSceneFrame = { ...EMPTY_POWER_UP_FRAME, gates: [] };

  /** A new live sample; `positionM` is the scene's position at that moment. */
  setLive(live: PowerUpLive | null | undefined, positionM: number, nowMs: number): void {
    this.#live = live ?? null;
    this.#at = positionM;
    const ev = this.#live?.event ?? null;
    if (ev && this.#seq !== null && ev.seq !== this.#seq) {
      if (ev.type === 'picked' || ev.type === 'challenge-won') this.#flashAt = nowMs;
    }
    if (ev) this.#seq = ev.seq;
    else if (this.#seq === null) this.#seq = 0;
  }

  /** The frame at scene position `positionM` and time `nowMs`. */
  update(positionM: number, nowMs: number): PowerUpSceneFrame {
    const f = this.frame;
    const pu = this.#live;
    f.gates.length = 0;
    f.timeS = nowMs / 1000;
    if (!pu) {
      f.holding = false;
      f.effect = null;
      f.phase = null;
      f.flash = -1;
      return f;
    }
    const moved = positionM - this.#at;
    for (const g of pu.upcoming) {
      const ahead = g - moved;
      if (ahead > -2) f.gates.push(ahead);
    }
    f.holding = pu.hand.length >= pu.capacity;
    f.effect = pu.effect?.kind ?? null;
    f.phase = pu.effect?.phase ?? null;
    const t = (nowMs - this.#flashAt) / FLASH_MS;
    f.flash = t >= 0 && t <= 1 ? t : -1;
    return f;
  }
}

/** Where gates and effects are mirrored on the scene root for tests and assistive tech. */
export function powerUpAttributes(f: PowerUpSceneFrame): {
  effect: string;
  effectPhase: string;
  gateAhead: string;
} {
  const next = f.gates.find((g) => g > 0);
  return {
    effect: f.phase === 'active' && f.effect ? f.effect : '',
    effectPhase: f.phase ?? '',
    gateAhead: next === undefined ? '' : String(Math.round(next)),
  };
}
