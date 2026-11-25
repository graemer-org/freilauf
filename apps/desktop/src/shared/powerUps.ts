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
  // Card Race only (docs/card-race.md): two gentle attacks and a shield.
  | 'headwind'
  | 'fog'
  | 'shield';

/** The power-ups of a normal ride: the four boosts (what pick-ups and challenges give). */
export const POWER_UP_KINDS: readonly PowerUpKind[] = [
  'tailwind',
  'lightLoad',
  'slipstream',
  'downhill',
];

/** Every card of a Card Race: the four boosts, the two attacks and the shield. */
export const CARD_KINDS: readonly PowerUpKind[] = [...POWER_UP_KINDS, 'headwind', 'fog', 'shield'];

/** Cards that act on another rider (sent over the group, applied by that rider to itself). */
export const ATTACK_KINDS: readonly PowerUpKind[] = ['headwind', 'fog'];

export function isAttackKind(kind: PowerUpKind): boolean {
  return ATTACK_KINDS.includes(kind);
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
  headwind: {
    label: 'Headwind',
    blurb: 'The rider directly ahead of you rides into a headwind for 10 s.',
  },
  fog: { label: 'Fog', blurb: 'The leader cannot see the gaps to the others for a while.' },
  shield: { label: 'Shield', blurb: 'Blocks the next attack aimed at you.' },
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
  // Card Race
  /** An attack card was played at another rider (`kind`). */
  | 'played'
  /** An attack reached this rider and acts now. */
  | 'hit'
  /** This rider's shield stopped an attack. */
  | 'blocked'
  /** A card came back to the hand (an attack that could not land). */
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
  /** The held power-up (the first card of the hand), or null. */
  held: PowerUpKind | null;
  /** All held cards, first one first (one at most for now; the battle mode may hold more). */
  hand: PowerUpKind[];
  /** How many cards fit in the hand. */
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
  /** Card Race only (absent in a normal ride): the two-card hand, attacks, shield, protection. */
  cards?: CardRaceLive;
}

// ───────────── Card Race (docs/card-race.md, docs/adr/0007-card-race.md) ─────────────

/**
 * The name riders see for the battle mode, everywhere (UI, overlay, notices, docs links).
 * Renaming the mode is this one line.
 */
export const CARD_RACE_NAME = 'Card Race';

/** How a group ride plays: power-ups as usual, or the Card Race. Chosen by the host. */
export type GroupMode = 'normal' | 'cardRace';

export const GROUP_MODE_LABEL: Record<GroupMode, string> = {
  normal: 'Normal',
  cardRace: CARD_RACE_NAME,
};

/** What became of an attack, from the target's side (and reported back to the attacker). */
export type AttackResult =
  /** It acts on the target now. */
  | 'hit'
  /** The target's shield stopped it (the shield is used up). */
  | 'blocked'
  /** The target was protected (just hit, or under another attack). */
  | 'protected'
  /** The target is not in the race right now (paused, ERG, FTP test, cards off). */
  | 'unavailable'
  /** Refused: implausible position, too many attacks, not for this rider, … */
  | 'refused'
  /** No answer in time (the attacker's side only). */
  | 'timeout';

/** An attack effect running on this rider. */
export interface CardAttackLive {
  kind: PowerUpKind;
  /** Name of the rider who played it. */
  by: string;
  remainingS: number;
  durationS: number;
}

/** A countdown (shield up, protection). */
export interface CardTimerLive {
  remainingS: number;
  durationS: number;
}

/** The latest attack aimed at this rider; `seq` grows by one per attack (a notice per seq). */
export interface IncomingAttackLive {
  seq: number;
  kind: PowerUpKind;
  by: string;
  result: AttackResult;
}

/** The latest attack this rider played; `seq` grows with each change of `result`. */
export interface OutgoingAttackLive {
  seq: number;
  kind: PowerUpKind;
  /** Name of the rider it was aimed at. */
  target: string;
  /** 'sent' until the target answers. */
  result: AttackResult | 'sent';
}

export interface CardRaceLive {
  /** The two cards, left first; null = empty slot. Left button plays [0], right button [1]. */
  slots: (PowerUpKind | null)[];
  /** Per slot: why that card cannot be played now (null: it can). */
  slotNotes: (string | null)[];
  /** Per slot, for an attack card: whom it would hit now (name), else null. */
  slotTargets: (string | null)[];
  /** An attack acting on this rider now (headwind or fog), or null. */
  attack: CardAttackLive | null;
  /** The shield is up (blocks the next attack). */
  shield: CardTimerLive | null;
  /** Protected after a hit: no attack can land until this runs out. */
  protection: CardTimerLive | null;
  /** Seconds until an attack can land again (attack in progress + protection after it). */
  immuneS: number;
  /** Metres gained from this rider's own cards (≥ 0). */
  gainM: number;
  /** Metres lost to attacks (≤ 0). */
  lossM: number;
  incoming: IncomingAttackLive | null;
  outgoing: OutgoingAttackLive | null;
}

/** "Press the side button or P": how to use a held power-up. */
export const POWER_UP_KEY = 'P';
export const POWER_UP_HINT = `Press the side button or ${POWER_UP_KEY}`;

/** "+38 m from power-ups". */
export function formatRaceGain(m: number): string {
  return `+${Math.max(0, Math.round(m))} m from power-ups`;
}

/**
 * Keys for the two cards in a Card Race: P plays the left (first) card, L the right one (L sits
 * under P on common layouts and is free in the ride view).
 */
export const CARD_KEYS = { left: POWER_UP_KEY, right: 'L' } as const;
export const CARD_HINTS = {
  left: `Left button or ${CARD_KEYS.left}`,
  right: `Right button or ${CARD_KEYS.right}`,
} as const;

/** "+38 m from cards". */
export function formatCardGain(m: number): string {
  return `+${Math.max(0, Math.round(m))} m from cards`;
}

/** "−24 m from attacks" (a typographic minus; "0 m" never shows: callers skip it). */
export function formatAttackLoss(m: number): string {
  return `−${Math.abs(Math.min(0, Math.round(m)))} m from attacks`;
}

/** A signed race offset, "+12 m" / "−8 m" / "0 m". */
export function formatSignedM(m: number): string {
  const r = Math.round(m);
  return r > 0 ? `+${r} m` : r < 0 ? `−${-r} m` : '0 m';
}

/** What a gap shows while Fog lies on this rider. */
export const FOG_GAP = '?';

/** True while Fog hides this rider's gaps to the others (their own UI only). */
export function gapsHidden(pu: PowerUpLive | null | undefined): boolean {
  return pu?.cards?.attack?.kind === 'fog';
}
