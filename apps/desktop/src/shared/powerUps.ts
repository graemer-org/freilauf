/**
 * Power-ups as the main window, the overlay and (later) the group see them: plain,
 * serialisable types and the rider-facing words. Types and constants only; the engine
 * lives in renderer/core/powerUps.ts (docs/power-ups.md, docs/adr/0006-power-ups.md).
 */

/**
 * The power-ups there are. Extension point: a new kind is added here, in POWER_UP_INFO and
 * in the engine's POWER_UP_DEFINITIONS (the compiler flags every place that must know it).
 */
export type PowerUpKind =
  | 'tailwind'
  | 'lightLoad'
  | 'slipstream'
  | 'downhill'
  // Freilauf Rumble only (docs/rumble.md): three attacks and a defence.
  | 'bottle'
  | 'puddle'
  | 'hornets'
  | 'cape';

/** The power-ups of a normal ride: the four boosts (what pick-ups and challenges give). */
export const POWER_UP_KINDS: readonly PowerUpKind[] = [
  'tailwind',
  'lightLoad',
  'slipstream',
  'downhill',
];

/** Every item of Freilauf Rumble: the four boosts, the three attacks and the rain cape. */
export const RUMBLE_ITEM_KINDS: readonly PowerUpKind[] = [
  ...POWER_UP_KINDS,
  'bottle',
  'puddle',
  'hornets',
  'cape',
];

/** Items aimed at another rider (sent over the group, applied by that rider to itself). */
export const ATTACK_KINDS: readonly PowerUpKind[] = ['bottle', 'hornets'];

/** Everything that can hit a rider (slows them): the two aimed items and the mud puddle. */
export const HIT_KINDS: readonly PowerUpKind[] = ['bottle', 'puddle', 'hornets'];

/** An item aimed at another rider (the water bottle, the hornets). */
export function isAttackKind(kind: PowerUpKind): boolean {
  return ATTACK_KINDS.includes(kind);
}

/** An item that slows whoever it hits (aimed, or the puddle dropped on the road). */
export function isHitKind(kind: string): kind is PowerUpKind {
  return (HIT_KINDS as readonly string[]).includes(kind);
}

/** Rider-facing name and one line on what it does. */
export const POWER_UP_INFO: Record<PowerUpKind, { label: string; blurb: string }> = {
  tailwind: {
    label: 'Tailwind',
    blurb: 'The wind turns in your favour: much less air resistance.',
  },
  lightLoad: { label: 'Light load', blurb: 'The bike feels lighter: climbs go faster.' },
  slipstream: { label: 'Slipstream', blurb: 'As if riding in a wheel ahead: less air resistance.' },
  downhill: {
    label: 'Downhill momentum',
    blurb: 'Waits for the next descent, then carries you faster.',
  },
  bottle: {
    label: 'Water bottle',
    blurb: 'Thrown at the rider directly ahead: they are slowed for 10 s.',
  },
  puddle: {
    label: 'Mud puddle',
    blurb: 'Dropped behind you: the next rider through it is slowed for 5 s.',
  },
  hornets: {
    label: 'Hornets',
    blurb: 'Chase the leader: slowed for 8 s, and they cannot see the gaps.',
  },
  cape: { label: 'Rain cape', blurb: 'Keeps off the next hit, for up to 60 s.' },
};

/** Why power-ups do not apply right now (null: they do). */
export type PowerUpBlock =
  /** Settings → Power-ups is off. */
  | 'off'
  /** An ERG workout step: the trainer holds the power. */
  | 'erg'
  /** An FTP test. */
  | 'ftpTest'
  /** The group's host switched power-ups off for the group ride. */
  | 'group';

/** An effect in progress: armed (waiting for its moment) or active (counting down). */
export interface PowerUpEffectLive {
  kind: PowerUpKind;
  phase: 'armed' | 'active';
  /** Seconds left in this phase. */
  remainingS: number;
  /** Length of this phase, seconds (for the countdown ring). */
  durationS: number;
}

/** The effort challenge on offer or under way. */
export interface PowerUpChallengeLive {
  /** 'offered': waiting for the rider to reach the target; 'holding': the hold runs. */
  phase: 'offered' | 'holding';
  targetW: number;
  /** How long the target must be held, seconds. */
  holdS: number;
  /** Seconds held so far. */
  heldS: number;
  /** Seconds left: of the offer while offered, of the hold while holding. */
  remainingS: number;
  /** The rider's 3 s power, for "live vs. target". */
  powerW: number;
}

export type PowerUpEventType =
  | 'picked'
  | 'skipped'
  | 'activated'
  | 'started'
  | 'ended'
  | 'expired'
  | 'challenge-offered'
  | 'challenge-won'
  | 'challenge-failed'
  | 'challenge-ended'
  // Freilauf Rumble
  /** An attack item was used on another rider (`kind`). */
  | 'played'
  /** A mud puddle was dropped behind this rider. */
  | 'dropped'
  /** A hit reached this rider and slows it now. */
  | 'hit'
  /** This rider's rain cape kept off a hit. */
  | 'blocked'
  /** An item came back to its slot (an attack that could not land). */
  | 'returned';

/** The latest thing that happened; `seq` grows by one per event (to play a cue once). */
export interface PowerUpEventLive {
  seq: number;
  type: PowerUpEventType;
  kind?: PowerUpKind;
}

/** Everything the UI shows about power-ups; part of LiveState (published ~4×/s). */
export interface PowerUpLive {
  /** Null when power-ups apply now; otherwise why not (no pick-ups are shown then). */
  blocked: PowerUpBlock | null;
  /** The held power-up (the first item held), or null. */
  held: PowerUpKind | null;
  /** Everything held, first one first (one in a normal ride, two in a Rumble). */
  hand: PowerUpKind[];
  /** How many items can be held. */
  capacity: number;
  /** Whether pressing the button would use the held power-up now. */
  canActivate: boolean;
  effect: PowerUpEffectLive | null;
  challenge: PowerUpChallengeLive | null;
  /** Pick-up spots ahead of the rider at this tick, metres ahead (nearest first, ≤ 600 m). */
  upcoming: number[];
  /**
   * Metres the race position is ahead of the recorded (physics) position because of
   * power-ups. Never part of the recording, the FIT file, points or bests.
   */
  raceOffsetM: number;
  /** Counts for this ride. */
  picked: number;
  used: number;
  event: PowerUpEventLive | null;
  /** Freilauf Rumble only (absent in a normal ride): the two slots, hits, cape, protection. */
  rumble?: RumbleLive;
}

// ───────────── Freilauf Rumble (docs/rumble.md, docs/adr/0008-rumble-items.md) ─────────────

/**
 * The name riders see for the battle mode, everywhere (UI, overlay, notices, docs links).
 * Renaming the mode is this one line.
 */
export const RUMBLE_NAME = 'Freilauf Rumble';

/** How a group ride plays: power-ups as usual, or Freilauf Rumble. Chosen by the host. */
export type GroupMode = 'normal' | 'rumble';

export const GROUP_MODE_LABEL: Record<GroupMode, string> = {
  normal: 'Normal',
  rumble: RUMBLE_NAME,
};

/** What became of an attack, from the target's side (and reported back to the attacker). */
export type AttackResult =
  /** It slows the target now. */
  | 'hit'
  /** The target's rain cape kept it off (the cape is used up). */
  | 'blocked'
  /** The target was protected (just hit, or slowed by another hit). */
  | 'protected'
  /** The target is not in the race right now (paused, ERG, FTP test, items off). */
  | 'unavailable'
  /** Refused: implausible position, too many attacks, not for this rider, … */
  | 'refused'
  /** No answer in time (the attacker's side only). */
  | 'timeout';

/** A hit slowing this rider. */
export interface RumbleHitLive {
  kind: PowerUpKind;
  /** Name of the rider whose item it was. */
  by: string;
  remainingS: number;
  durationS: number;
}

/** A countdown (rain cape up, protection). */
export interface RumbleTimerLive {
  remainingS: number;
  durationS: number;
}

/** The latest hit aimed at (or ridden into by) this rider; `seq` grows by one per hit. */
export interface IncomingHitLive {
  seq: number;
  kind: PowerUpKind;
  by: string;
  result: AttackResult;
}

/**
 * The latest item this rider used on someone; `seq` grows with each change of `result`. For
 * a mud puddle, `target` is who rode through it (result 'hit') — or '' when it was just
 * dropped (result 'sent').
 */
export interface OutgoingAttackLive {
  seq: number;
  kind: PowerUpKind;
  /** Name of the rider it was aimed at. */
  target: string;
  /** That rider's peer id (to draw the throw towards them), when known. */
  targetId?: string;
  /** 'sent' until the target answers. */
  result: AttackResult | 'sent';
}

/** A mud puddle on the road near this rider (own or someone else's). */
export interface PuddleLive {
  id: string;
  /** Metres from this rider along the road: + ahead, − behind. */
  aheadM: number;
  /** Dropped by this rider (it never hits them). */
  own: boolean;
  /** Name of who dropped it. */
  by: string;
}

export interface RumbleLive {
  /** The two item slots, left first; null = empty. Left button uses [0], right button [1]. */
  slots: (PowerUpKind | null)[];
  /** Per slot: why that item cannot be used now (null: it can). */
  slotNotes: (string | null)[];
  /** Per slot, for an aimed item: whom it would hit now (name), else null. */
  slotTargets: (string | null)[];
  /** A hit slowing this rider now, or null. */
  hit: RumbleHitLive | null;
  /** The rain cape is up (keeps off the next hit). */
  cape: RumbleTimerLive | null;
  /** Protected after a hit: nothing can land until this runs out. */
  protection: RumbleTimerLive | null;
  /** Seconds until a hit can land again (a hit in progress + protection after it). */
  immuneS: number;
  /** Metres gained from this rider's own items (≥ 0). */
  gainM: number;
  /** Metres lost to hits (≤ 0). */
  lossM: number;
  incoming: IncomingHitLive | null;
  outgoing: OutgoingAttackLive | null;
  /** Mud puddles on the road within view, nearest first. */
  puddles: PuddleLive[];
}

/** "Press the side button or P": how to use a held power-up. */
export const POWER_UP_KEY = 'P';
export const POWER_UP_HINT = `Press the side button or ${POWER_UP_KEY}`;

/** "+38 m from power-ups". */
export function formatRaceGain(m: number): string {
  return `+${Math.max(0, Math.round(m))} m from power-ups`;
}

/**
 * Keys for the two item slots in a Rumble: P uses the left (first) item, L the right one (L sits
 * under P on common layouts and is free in the ride view).
 */
export const ITEM_KEYS = { left: POWER_UP_KEY, right: 'L' } as const;
export const ITEM_HINTS = {
  left: `Left button or ${ITEM_KEYS.left}`,
  right: `Right button or ${ITEM_KEYS.right}`,
} as const;

/** "+38 m from items". */
export function formatItemGain(m: number): string {
  return `+${Math.max(0, Math.round(m))} m from items`;
}

/** "−24 m from hits" (a typographic minus; "0 m" never shows: callers skip it). */
export function formatHitLoss(m: number): string {
  return `−${Math.abs(Math.min(0, Math.round(m)))} m from hits`;
}

/** A signed race offset, "+12 m" / "−8 m" / "0 m". */
export function formatSignedM(m: number): string {
  const r = Math.round(m);
  return r > 0 ? `+${r} m` : r < 0 ? `−${-r} m` : '0 m';
}

/** What a gap shows while hornets buzz around this rider (the leader's own screen). */
export const HIDDEN_GAP = '?';

/** True while hornets hide this rider's gaps to the others (their own UI only). */
export function gapsHidden(pu: PowerUpLive | null | undefined): boolean {
  return pu?.rumble?.hit?.kind === 'hornets';
}
