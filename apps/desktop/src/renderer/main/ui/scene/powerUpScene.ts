/**
 * What both ride scenes draw for power-ups (docs/power-ups.md), from the 4 Hz live state:
 * pick-up gates ahead (moved on with the scene between samples), the active effect, and a
 * short flash when one is picked up. In Freilauf Rumble (docs/rumble.md) the pick-ups are feed
 * bags, and the frame also carries the items in flight, the puddles on the road and what acts
 * on the local rider. Pure bookkeeping; the renderers do the drawing.
 */
import type { RiderItems } from '@freilauf/p2p';
import type { PowerUpKind, PowerUpLive } from '../../../../shared/powerUps';

/** The hits there are, as the scene draws them. */
export type HitKind = 'bottle' | 'puddle' | 'hornets';
/** The items that fly: a thrown bottle, the swarm of hornets. */
export type FlyingKind = 'bottle' | 'hornets';

const asHit = (k: string | undefined | null): HitKind | null =>
  k === 'bottle' || k === 'puddle' || k === 'hornets' ? k : null;
const asFlying = (k: string | undefined | null): FlyingKind | null =>
  k === 'bottle' || k === 'hornets' ? k : null;

/** An item this rider used, on its way to the target (who is found among the others by id). */
export interface ThrowFrame {
  kind: FlyingKind;
  /** 0 … 1 through the flight. */
  t: number;
  /** The target's peer id (to fly to where they are drawn); null: fly out of frame ahead. */
  targetId: string | null;
  /** 0 … 1 through the splash at the target once it landed (−1 while still flying). */
  splash: number;
  splashKind: 'hit' | 'blocked' | null;
}

/**
 * Freilauf Rumble on the local rider, for both scenes: a hit slowing it (water dripping, mud
 * spattered, hornets buzzing), the rain cape, the faint ring of protection with its countdown,
 * a short splash when a hit lands or is kept off; an item flying in from behind; this rider's
 * own throw on its way; and the mud puddles on the road.
 */
export interface RumbleSceneFrame {
  hit: HitKind | null;
  /** 1 → 0 as the hit runs out. */
  hitLeft: number;
  cape: boolean;
  /** 1 → 0 as protection runs out; −1 without. */
  protection: number;
  /** 0 … 1 through the splash of a hit (or a hit kept off); −1 when none plays. */
  pulse: number;
  pulseKind: 'hit' | 'blocked' | null;
  /** What made the splash (water, mud, hornets). */
  pulseItem: HitKind | null;
  /** A bottle or the swarm flying in from behind at this rider: 0 … 1 (lands at 1). */
  incoming: { kind: FlyingKind; t: number } | null;
  /** This rider's own bottle or hornets on their way. */
  throw: ThrowFrame | null;
  /** Mud puddles on the road, metres ahead (+) or behind (−), nearest first. */
  puddles: { aheadM: number; own: boolean }[];
}

/** What is drawn on another rider in a Rumble (from that rider's own broadcast). */
export interface RiderFx {
  hit: HitKind | null;
  cape: boolean;
  protected: boolean;
}

/** The effects to draw on another rider, or undefined when there is nothing to draw. */
export function riderFx(items: RiderItems | undefined): RiderFx | undefined {
  if (!items) return undefined;
  const hit = asHit(items.hit?.kind);
  const cape = (items.capeS ?? 0) > 0;
  const prot = !hit && (items.protectedS ?? 0) > 0;
  if (!hit && !cape && !prot) return undefined;
  return { hit, cape, protected: prot };
}

/** Length of the hit / block splash, ms. */
export const PULSE_MS = 900;
/** How long a thrown item flies (ms): the bottle in an arc, the swarm along the road. */
export const FLIGHT_MS: Record<FlyingKind, number> = { bottle: 900, hornets: 2_000 };
/** How long an item flies in at this rider before it lands (ms). */
export const INCOMING_FLIGHT_MS: Record<FlyingKind, number> = { bottle: 700, hornets: 1_200 };

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
  /** Freilauf Rumble: the pick-ups are feed bags at the roadside instead of gates. */
  feedBags: boolean;
  /** Freilauf Rumble only. */
  rumble: RumbleSceneFrame | null;
}

export const EMPTY_POWER_UP_FRAME: PowerUpSceneFrame = {
  gates: [],
  holding: false,
  effect: null,
  phase: null,
  flash: -1,
  timeS: 0,
  feedBags: false,
  rumble: null,
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
  #incomingAt = Number.NEGATIVE_INFINITY;
  #incomingKind: FlyingKind | null = null;
  #pulseAt = Number.NEGATIVE_INFINITY;
  #pulseKind: RumbleSceneFrame['pulseKind'] = null;
  #pulseItem: HitKind | null = null;
  #outgoingSeq: number | null = null;
  #throw: {
    seq: number;
    kind: FlyingKind;
    at: number;
    targetId: string | null;
    result: 'hit' | 'blocked' | 'miss' | null;
    resultAt: number;
  } | null = null;
  readonly #rumble: RumbleSceneFrame = {
    hit: null,
    hitLeft: 0,
    cape: false,
    protection: -1,
    pulse: -1,
    pulseKind: null,
    pulseItem: null,
    incoming: null,
    throw: null,
    puddles: [],
  };
  readonly #throwFrame: ThrowFrame = {
    kind: 'bottle',
    t: 0,
    targetId: null,
    splash: -1,
    splashKind: null,
  };
  readonly #incomingFrame: { kind: FlyingKind; t: number } = { kind: 'bottle', t: 0 };
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
    const r = this.#live?.rumble ?? null;
    const inc = r?.incoming ?? null;
    if (inc && this.#incomingSeq !== null && inc.seq !== this.#incomingSeq) {
      const flying = asFlying(inc.kind);
      // A bottle or the swarm flies in first and lands a moment later; a puddle is at once.
      const landsAt = flying ? nowMs + INCOMING_FLIGHT_MS[flying] : nowMs;
      if (flying) {
        this.#incomingAt = nowMs;
        this.#incomingKind = flying;
      }
      if (inc.result === 'hit' || inc.result === 'blocked') {
        this.#pulseAt = landsAt;
        this.#pulseKind = inc.result;
        this.#pulseItem = asHit(inc.kind);
      }
    }
    this.#incomingSeq = inc?.seq ?? this.#incomingSeq ?? 0;
    const out = r?.outgoing ?? null;
    if (out && this.#outgoingSeq !== null && out.seq !== this.#outgoingSeq) {
      const flying = asFlying(out.kind);
      const result =
        out.result === 'sent'
          ? null
          : out.result === 'hit' || out.result === 'blocked'
            ? out.result
            : 'miss';
      // The answer to the throw we are drawing (its 'sent' came one step before), or — when the
      // answer arrived before a sample showed 'sent' — a throw that starts now, already answered.
      const answers = this.#throw && this.#throw.seq === out.seq - 1 && result !== null;
      if (flying && answers) {
        this.#throw!.result = result;
        this.#throw!.resultAt = nowMs;
      } else if (flying && result !== 'miss') {
        this.#throw = {
          seq: out.seq,
          kind: flying,
          at: nowMs,
          targetId: out.targetId ?? null,
          result,
          resultAt: nowMs,
        };
      }
    }
    this.#outgoingSeq = out?.seq ?? this.#outgoingSeq ?? 0;
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
      f.feedBags = false;
      f.rumble = null;
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
    const c = pu.rumble;
    f.feedBags = c !== undefined;
    if (!c) {
      f.rumble = null;
      return f;
    }
    const rf = this.#rumble;
    rf.hit = asHit(c.hit?.kind);
    rf.hitLeft = c.hit && c.hit.durationS > 0 ? c.hit.remainingS / c.hit.durationS : 0;
    rf.cape = c.cape !== null;
    rf.protection =
      c.protection && c.protection.durationS > 0
        ? Math.max(0, Math.min(1, c.protection.remainingS / c.protection.durationS))
        : -1;
    const p = (nowMs - this.#pulseAt) / PULSE_MS;
    rf.pulse = p >= 0 && p <= 1 ? p : -1;
    rf.pulseKind = rf.pulse >= 0 ? this.#pulseKind : null;
    rf.pulseItem = rf.pulse >= 0 ? this.#pulseItem : null;
    // Something flying in from behind.
    rf.incoming = null;
    if (this.#incomingKind) {
      const it = (nowMs - this.#incomingAt) / INCOMING_FLIGHT_MS[this.#incomingKind];
      if (it >= 0 && it <= 1) {
        this.#incomingFrame.kind = this.#incomingKind;
        this.#incomingFrame.t = it;
        rf.incoming = this.#incomingFrame;
      }
    }
    // Our own throw on its way, then its splash at the target.
    rf.throw = null;
    const th = this.#throw;
    if (th) {
      const flight = FLIGHT_MS[th.kind];
      const tt = (nowMs - th.at) / flight;
      const landed = th.result === 'hit' || th.result === 'blocked';
      const splashFrom = Math.max(th.at + flight, landed ? th.resultAt : Number.POSITIVE_INFINITY);
      const sp = (nowMs - splashFrom) / PULSE_MS;
      const done = landed ? sp > 1 : tt > 1.15 || th.result === 'miss';
      if (done && tt > 1) this.#throw = null;
      else {
        const tf = this.#throwFrame;
        tf.kind = th.kind;
        tf.t = Math.max(0, Math.min(1, tt));
        tf.targetId = th.targetId;
        tf.splash = landed && sp >= 0 && sp <= 1 ? sp : -1;
        tf.splashKind = tf.splash >= 0 ? (th.result as 'hit' | 'blocked') : null;
        rf.throw = tf;
      }
    }
    // Puddles move with the scene between samples, like the gates.
    rf.puddles.length = 0;
    for (const pd of c.puddles) rf.puddles.push({ aheadM: pd.aheadM - moved, own: pd.own });
    f.rumble = rf;
    return f;
  }
}

/** Where gates and effects are mirrored on the scene root for tests and assistive tech. */
export function powerUpAttributes(f: PowerUpSceneFrame): {
  effect: string;
  effectPhase: string;
  gateAhead: string;
  /** Rumble: what acts on the local rider, e.g. "bottle", "hornets", "cape", "protected". */
  rumble: string;
  /** Rumble: metres to the nearest puddle ahead, or ''. */
  puddleAhead: string;
  /** Rumble: the item in flight ("throw:bottle", "incoming:hornets"), or ''. */
  flying: string;
} {
  const next = f.gates.find((g) => g > 0);
  const c = f.rumble;
  const puddle = c?.puddles.find((p) => p.aheadM > 0 && !p.own);
  return {
    effect: f.phase === 'active' && f.effect ? f.effect : '',
    effectPhase: f.phase ?? '',
    gateAhead: next === undefined ? '' : String(Math.round(next)),
    rumble: c
      ? [c.hit, c.cape ? 'cape' : null, c.protection >= 0 ? 'protected' : null]
          .filter(Boolean)
          .join(' ')
      : '',
    puddleAhead: puddle ? String(Math.round(puddle.aheadM)) : '',
    flying: c?.throw ? `throw:${c.throw.kind}` : c?.incoming ? `incoming:${c.incoming.kind}` : '',
  };
}

/** A key that changes whenever the Rumble part of the frame looks different. */
export function rumbleKey(c: RumbleSceneFrame | null): string {
  if (!c) return '';
  return `${c.hit}|${c.cape}|${Math.round(c.protection * 30)}|${c.pulse >= 0}|${Math.round(c.hitLeft * 20)}|${c.incoming ? 1 : 0}|${c.throw ? 1 : 0}|${c.puddles.map((p) => Math.round(p.aheadM)).join(',')}`;
}
