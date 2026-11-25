/**
 * Card Race rules that need the group (docs/card-race.md, docs/adr/0007-card-race.md): whom an
 * attack card hits (resolved on the attacker's side from the latest race positions), whether an
 * incoming attack is plausible (re-checked on the target's side), and what this rider tells the
 * group about its cards. Pure; the ride controller wires it to the engine and the group.
 */
import type { GroupRider, IncomingAttack, RiderCards } from '@freilauf/p2p';
import { gapAlongRoute } from '@freilauf/p2p';
import type { PowerUpKind, PowerUpLive } from '../../shared/powerUps';
import { CARD_KINDS, CARD_RACE_NAME, isAttackKind } from '../../shared/powerUps';
import { POWER_UP_DEFINITIONS } from './powerUps';

/** The Card Race protocol version this app speaks (`RiderCards.v`). */
export const CARD_PROTOCOL_VERSION = 1;

/** Riders closer than this count as level, not ahead or behind (m). */
export const LEVEL_M = 10;
/**
 * Target side: the attacker's own position may put the target up to this far *behind* it and
 * still count (both sides measure a moving race a few hundred milliseconds apart).
 */
export const AHEAD_TOLERANCE_M = 20;

/** Riders who can be aimed at: they run a Card Race app, are heard from and are in the race. */
export function inRace(r: GroupRider): boolean {
  return r.cards !== undefined && !r.stale && r.cards.away !== true;
}

/** Riders whose app does not speak the Card Race (no `cards` in their state). */
export function incompatibleRiders(riders: readonly GroupRider[]): GroupRider[] {
  return riders.filter((r) => r.cards === undefined);
}

/** "Anna's app does not support Card Race" (two: "Anna's and Ben's apps do not …"). */
export function incompatibleNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const owners = names.map((n) => `${n}’s`);
  const list =
    owners.length === 1
      ? owners[0]!
      : `${owners.slice(0, -1).join(', ')} and ${owners[owners.length - 1]!}`;
  return `${list} ${owners.length === 1 ? 'app does' : 'apps do'} not support ${CARD_RACE_NAME}`;
}

export type TargetResolution =
  | { ok: true; peerId: string; name: string; gapM: number; sameRoute: boolean }
  | { ok: false; note: string };

/**
 * Whom attack `kind` would hit now, from the attacker's view of the group (`riders`: gaps with
 * both sides' race offsets, leader first). Headwind: the rider directly ahead (the nearest one
 * more than LEVEL_M ahead). Fog: the leader. Riders without the Card Race, without signal or
 * not in the race are passed over. A protected target makes the card wait (it is not wasted).
 */
export function resolveTarget(kind: PowerUpKind, riders: readonly GroupRider[]): TargetResolution {
  const target = POWER_UP_DEFINITIONS[kind].target;
  if (target === 'self') return { ok: false, note: 'Not an attack' };
  const ahead = riders.filter((r) => inRace(r) && r.gapM > LEVEL_M);
  if (ahead.length === 0) {
    return { ok: false, note: target === 'leader' ? 'You are leading' : 'Nobody ahead of you' };
  }
  const pick =
    target === 'ahead'
      ? ahead.reduce((a, b) => (b.gapM < a.gapM ? b : a))
      : ahead.reduce((a, b) => (b.gapM > a.gapM ? b : a));
  const c = pick.cards!;
  if (c.attack || (c.protectedS ?? 0) > 0) {
    const s = Math.ceil(Math.max(c.attack?.s ?? 0, c.protectedS ?? 0));
    return { ok: false, note: `${pick.name} is protected${s > 0 ? ` · ${s} s` : ''}` };
  }
  return {
    ok: true,
    peerId: pick.peerId,
    name: pick.name,
    gapM: pick.gapM,
    sameRoute: pick.sameRoute === true,
  };
}

/** Where the local rider is in the race (for the attack payload and the target's re-check). */
export interface LocalRace {
  distanceM: number;
  /** Race offset (signed in a Card Race). */
  offsetM: number;
  /** On a route: its base id, the position on it and its shape. */
  route: { id: string; m: number; lengthM: number; loop: boolean } | null;
}

/**
 * The attacker's race position as sent with the attack: on the route both share (the target is
 * `sameRoute`), route metres + offset; otherwise ridden metres + offset.
 */
export function attackPosition(
  me: LocalRace,
  sameRoute: boolean,
): { raceM: number; routeId?: string } {
  if (sameRoute && me.route) return { raceM: me.route.m + me.offsetM, routeId: me.route.id };
  return { raceM: me.distanceM + me.offsetM };
}

/** Why an incoming attack is refused (null: it is plausible). */
export type AttackRefusal =
  | 'unknown-kind'
  | 'other-route'
  | 'not-ahead'
  | 'gap-mismatch'
  | 'not-directly-ahead'
  | 'not-leading';

/**
 * Target side: whether attack `a` can be meant for this rider. The attacker resolved it from
 * its view; this re-checks with the attacker's own position (`raceM`) and this rider's view of
 * the others: the kind is a known attack, this rider is ahead of the attacker (within
 * AHEAD_TOLERANCE_M), the attacker's gap roughly agrees, and — Headwind — nobody in the race is
 * between them, or — Fog — nobody in the race is ahead of this rider.
 */
export function checkAttack(
  a: Pick<IncomingAttack, 'kind' | 'gapM' | 'raceM' | 'routeId' | 'from'>,
  me: LocalRace,
  riders: readonly GroupRider[],
): AttackRefusal | null {
  if (!(CARD_KINDS as readonly string[]).includes(a.kind) || !isAttackKind(a.kind as PowerUpKind)) {
    return 'unknown-kind';
  }
  let gap: number; // how far this rider is ahead of the attacker
  if (a.routeId !== undefined) {
    if (!me.route || me.route.id !== a.routeId) return 'other-route';
    gap = -gapAlongRoute(a.raceM, { ...me.route, m: me.route.m + me.offsetM });
  } else gap = me.distanceM + me.offsetM - a.raceM;
  if (!(gap >= -AHEAD_TOLERANCE_M)) return 'not-ahead';
  if (Math.abs(gap - a.gapM) > 50 + 0.25 * Math.abs(a.gapM)) return 'gap-mismatch';
  const others = riders.filter((r) => r.peerId !== a.from && inRace(r));
  if (POWER_UP_DEFINITIONS[a.kind as PowerUpKind].target === 'ahead') {
    // Someone clearly between the attacker (gap behind) and this rider.
    if (others.some((r) => r.gapM < -LEVEL_M && r.gapM > -gap + LEVEL_M)) {
      return 'not-directly-ahead';
    }
  } else if (others.some((r) => r.gapM > LEVEL_M)) return 'not-leading';
  return null;
}

/**
 * What this rider broadcasts as `cards`: always the version (so others know the app supports
 * the Card Race); in a Card Race also the signed offset, the attack acting, shield, protection,
 * the number of cards held and whether the rider is out of the race right now.
 */
export function cardsWire(pu: PowerUpLive | null, cardRace: boolean, riding: boolean): RiderCards {
  const out: RiderCards = { v: CARD_PROTOCOL_VERSION };
  if (!cardRace) return out;
  const c = pu?.cards;
  if (!pu || !c) {
    out.away = true;
    return out;
  }
  out.offsetM = Math.round(pu.raceOffsetM * 10) / 10;
  if (c.attack) out.attack = { kind: c.attack.kind, s: round1(c.attack.remainingS) };
  if (c.shield) out.shieldS = round1(c.shield.remainingS);
  // The whole time no attack lands (an attack in progress and the protection after it).
  if (c.immuneS > 0) out.protectedS = round1(c.immuneS);
  out.held = c.slots.filter((k) => k !== null).length;
  if (!riding || pu.blocked !== null) out.away = true;
  return out;
}

function round1(n: number): number {
  return Math.round(Math.max(0, Math.min(600, n)) * 10) / 10;
}
