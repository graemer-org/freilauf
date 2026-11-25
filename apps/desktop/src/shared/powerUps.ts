/**
 * Power-ups as the main window, the overlay and (later) the group see them: plain,
 * serialisable types and the rider-facing words. Types and constants only; the engine
 * lives in renderer/core/powerUps.ts (docs/power-ups.md, docs/adr/0006-power-ups.md).
 */

/**
 * The power-ups there are. Extension point: a new kind is added here, in POWER_UP_INFO and
 * in the engine's POWER_UP_DEFINITIONS (the compiler flags every place that must know it).
 */
export type PowerUpKind = 'tailwind' | 'lightLoad' | 'slipstream' | 'downhill';

export const POWER_UP_KINDS: readonly PowerUpKind[] = [
  'tailwind',
  'lightLoad',
  'slipstream',
  'downhill',
];

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
  | 'challenge-ended';

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
}

/** "Press the side button or P": how to use a held power-up. */
export const POWER_UP_KEY = 'P';
export const POWER_UP_HINT = `Press the side button or ${POWER_UP_KEY}`;

/** "+38 m from power-ups". */
export function formatRaceGain(m: number): string {
  return `+${Math.max(0, Math.round(m))} m from power-ups`;
}
