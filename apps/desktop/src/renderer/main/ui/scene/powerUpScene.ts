/**
 * What both ride scenes draw for power-ups (docs/power-ups.md), from the 4 Hz live state:
 * pick-up gates ahead (moved on with the scene between samples), the active effect, and a
 * short flash when one is picked up. Pure bookkeeping; the renderers do the drawing.
 */
import type { RiderCards } from '@freilauf/p2p';
import type { PowerUpKind, PowerUpLive } from '../../../../shared/powerUps';

/**
 * Card Race effects on the local rider, for both scenes (docs/card-race.md): an attack acting
 * (Headwind: gusts from ahead; Fog: a soft haze over the view), the shield's bubble, the faint
 * ring of protection with its countdown, and a short pulse when an attack lands or is blocked.
 */
export interface CardSceneFrame {
  attack: 'headwind' | 'fog' | null;
  /** 1 → 0 as the attack runs out. */
  attackLeft: number;
  shield: boolean;
  /** 1 → 0 as protection runs out; −1 without. */
  protection: number;
  /** 0 … 1 through the pulse of a hit (or a blocked attack); −1 when none plays. */
  pulse: number;
  pulseKind: 'hit' | 'blocked' | null;
}

/** What is drawn on another rider in a Card Race (from that rider's own broadcast). */
export interface RiderFx {
  attack: 'headwind' | 'fog' | null;
  shield: boolean;
  protected: boolean;
}

/** The effects to draw on another rider, or undefined when there is nothing to draw. */
export function riderFx(cards: RiderCards | undefined): RiderFx | undefined {
  if (!cards) return undefined;
  const k = cards.attack?.kind;
  const attack = k === 'headwind' || k === 'fog' ? k : null;
  const shield = (cards.shieldS ?? 0) > 0;
  const prot = !attack && (cards.protectedS ?? 0) > 0;
  if (!attack && !shield && !prot) return undefined;
  return { attack, shield, protected: prot };
}

/** Length of the hit / block pulse, ms. */
export const PULSE_MS = 900;

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
  /** Card Race only. */
  cards: CardSceneFrame | null;
}

export const EMPTY_POWER_UP_FRAME: PowerUpSceneFrame = {
  gates: [],
  holding: false,
  effect: null,
  phase: null,
  flash: -1,
  timeS: 0,
  cards: null,
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
  #incomingSeq: number | null = null;
  #pulseAt = Number.NEGATIVE_INFINITY;
  #pulseKind: CardSceneFrame['pulseKind'] = null;
  readonly #cards: CardSceneFrame = {
    attack: null,
    attackLeft: 0,
    shield: false,
    protection: -1,
    pulse: -1,
    pulseKind: null,
  };
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
    const inc = this.#live?.cards?.incoming ?? null;
    if (inc && this.#incomingSeq !== null && inc.seq !== this.#incomingSeq) {
      if (inc.result === 'hit' || inc.result === 'blocked') {
        this.#pulseAt = nowMs;
        this.#pulseKind = inc.result;
      }
    }
    this.#incomingSeq = inc?.seq ?? this.#incomingSeq ?? 0;
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
    const c = pu.cards;
    if (!c) {
      f.cards = null;
      return f;
    }
    const k = c.attack?.kind;
    const cf = this.#cards;
    cf.attack = k === 'headwind' || k === 'fog' ? k : null;
    cf.attackLeft =
      c.attack && c.attack.durationS > 0 ? c.attack.remainingS / c.attack.durationS : 0;
    cf.shield = c.shield !== null;
    cf.protection =
      c.protection && c.protection.durationS > 0
        ? Math.max(0, Math.min(1, c.protection.remainingS / c.protection.durationS))
        : -1;
    const p = (nowMs - this.#pulseAt) / PULSE_MS;
    cf.pulse = p >= 0 && p <= 1 ? p : -1;
    cf.pulseKind = cf.pulse >= 0 ? this.#pulseKind : null;
    f.cards = cf;
    return f;
  }
}

/** Where gates and effects are mirrored on the scene root for tests and assistive tech. */
export function powerUpAttributes(f: PowerUpSceneFrame): {
  effect: string;
  effectPhase: string;
  gateAhead: string;
  /** Card Race: what acts on the local rider, e.g. "headwind", "fog", "shield", "protected". */
  cards: string;
} {
  const next = f.gates.find((g) => g > 0);
  const c = f.cards;
  return {
    effect: f.phase === 'active' && f.effect ? f.effect : '',
    effectPhase: f.phase ?? '',
    gateAhead: next === undefined ? '' : String(Math.round(next)),
    cards: c
      ? [c.attack, c.shield ? 'shield' : null, c.protection >= 0 ? 'protected' : null]
          .filter(Boolean)
          .join(' ')
      : '',
  };
}

/** A key that changes whenever the Card Race part of the frame looks different. */
export function cardsKey(c: CardSceneFrame | null): string {
  if (!c) return '';
  return `${c.attack}|${c.shield}|${Math.round(c.protection * 30)}|${c.pulse >= 0}|${Math.round(c.attackLeft * 20)}`;
}
