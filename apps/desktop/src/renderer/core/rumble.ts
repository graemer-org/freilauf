/**
 * Freilauf Rumble rules that need the group (docs/rumble.md, docs/adr/0008-rumble-items.md):
 * whom an aimed item hits (resolved on the thrower's side from the latest race positions),
 * whether an incoming attack is plausible (re-checked on the target's side), where a mud
 * puddle is dropped, and what this rider tells the group. Pure; the ride controller wires it to
 * the engine and the group.
 */
import type {
  GroupRider,
  IncomingAttack,
  NearPuddle,
  PuddleAt,
  PuddleRacePosition,
  RiderItems,
  WirePuddle,
} from '@freilauf/p2p';
import { gapAlongRoute, routeAhead } from '@freilauf/p2p';
import type { PowerUpKind, PowerUpLive, PuddleLive } from '../../shared/powerUps';
import { RUMBLE_NAME, isAttackKind } from '../../shared/powerUps';
import { POWER_UP_DEFINITIONS } from './powerUps';

/** The Rumble protocol version this app speaks (`RiderItems.v`; 1 was ADR 0007's format). */
export const RUMBLE_PROTOCOL_VERSION = 2;

/** Riders closer than this count as level, not ahead or behind (m). */
export const LEVEL_M = 10;
/**
 * Target side: the thrower's own position may put the target up to this far *behind* it and
 * still count (both sides measure a moving race a few hundred milliseconds apart).
 */
export const AHEAD_TOLERANCE_M = 20;
/** A mud puddle lands this far behind the rider who drops it (m). */
export const PUDDLE_BEHIND_M = 2;
/** Puddles further than this ahead or behind are not drawn (m). */
export const PUDDLE_VIEW_M = 420;

/**
 * Riders who can be aimed at (and hit by puddles): they run a Rumble app, are heard from and
 * are in the race.
 */
export function inRace(r: GroupRider): boolean {
  return r.items !== undefined && !r.stale && r.items.away !== true;
}

/** Riders whose app does not speak Freilauf Rumble (no `items` in their state). */
export function incompatibleRiders(riders: readonly GroupRider[]): GroupRider[] {
  return riders.filter((r) => r.items === undefined);
}

/** "Anna's app does not support Freilauf Rumble" (two: "Anna's and Ben's apps do not …"). */
export function incompatibleNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const owners = names.map((n) => `${n}’s`);
  const list =
    owners.length === 1
      ? owners[0]!
      : `${owners.slice(0, -1).join(', ')} and ${owners[owners.length - 1]!}`;
  return `${list} ${owners.length === 1 ? 'app does' : 'apps do'} not support ${RUMBLE_NAME}`;
}

export type TargetResolution =
  | { ok: true; peerId: string; name: string; gapM: number; sameRoute: boolean }
  | { ok: false; note: string };

/**
 * Whom aimed item `kind` would hit now, from the thrower's view of the group (`riders`: gaps
 * with both sides' race offsets, leader first). Water bottle: the rider directly ahead (the
 * nearest one more than LEVEL_M ahead). Hornets: the leader, however far. Riders without
 * Freilauf Rumble, without signal or not in the race are passed over. A protected target makes
 * the item wait (it is not wasted).
 */
export function resolveTarget(kind: PowerUpKind, riders: readonly GroupRider[]): TargetResolution {
  const target = POWER_UP_DEFINITIONS[kind].target;
  if (target !== 'ahead' && target !== 'leader') return { ok: false, note: 'Not aimed' };
  const ahead = riders.filter((r) => inRace(r) && r.gapM > LEVEL_M);
  if (ahead.length === 0) {
    return { ok: false, note: target === 'leader' ? 'You are leading' : 'Nobody ahead of you' };
  }
  const pick =
    target === 'ahead'
      ? ahead.reduce((a, b) => (b.gapM < a.gapM ? b : a))
      : ahead.reduce((a, b) => (b.gapM > a.gapM ? b : a));
  const c = pick.items!;
  if (c.hit || (c.protectedS ?? 0) > 0) {
    const s = Math.ceil(Math.max(c.hit?.s ?? 0, c.protectedS ?? 0));
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

/** Where the local rider is in the race (attack payloads, plausibility, puddles). */
export interface LocalRace {
  distanceM: number;
  /** Race offset (signed in a Rumble). */
  offsetM: number;
  /** On a route: its base id, the position on it and its shape. */
  route: { id: string; m: number; lengthM: number; loop: boolean } | null;
}

/**
 * The thrower's race position as sent with the attack: on the route both share (the target is
 * `sameRoute`), route metres + offset; otherwise ridden metres + offset.
 */
export function attackPosition(
  me: LocalRace,
  sameRoute: boolean,
): { raceM: number; routeId?: string } {
  if (sameRoute && me.route) return { raceM: me.route.m + me.offsetM, routeId: me.route.id };
  return { raceM: me.distanceM + me.offsetM };
}

/** The local rider's race position in puddle coordinates (see PuddleRacePosition). */
export function puddleRace(me: LocalRace): PuddleRacePosition {
  return {
    raceM: me.distanceM + me.offsetM,
    route: me.route ? { ...me.route, m: me.route.m + me.offsetM } : null,
  };
}

/**
 * Where a puddle dropped now lands: PUDDLE_BEHIND_M behind the rider's race position — on the
 * route when riding one (kept on it: wrapped on a loop), otherwise along the ridden distance.
 */
export function puddleDropAt(me: LocalRace): PuddleAt {
  if (me.route) {
    return {
      routeId: me.route.id,
      m: routeAhead(me.route.m + me.offsetM - PUDDLE_BEHIND_M, me.route),
    };
  }
  return { m: me.distanceM + me.offsetM - PUDDLE_BEHIND_M };
}

/**
 * Puddles on the road around this rider, nearest first, for the scene and the overlay: the
 * others' (from their broadcast, already measured by PuddleWatch) and this rider's own.
 */
export function puddlesLive(
  near: readonly NearPuddle[],
  own: readonly WirePuddle[],
  me: LocalRace,
  myName: string,
): PuddleLive[] {
  const out: PuddleLive[] = [];
  for (const n of near) {
    if (Math.abs(n.gapM) > PUDDLE_VIEW_M) continue;
    out.push({
      id: `${n.dropper}|${n.puddle.id}`,
      aheadM: Math.round(n.gapM * 10) / 10,
      own: false,
      by: n.dropperName,
    });
  }
  const race = puddleRace(me);
  for (const p of own) {
    if (p.used || p.s <= 0) continue;
    const gap = p.routeId
      ? race.route && race.route.id === p.routeId
        ? gapAlongRoute(p.m, race.route)
        : null
      : p.m - race.raceM;
    if (gap === null || Math.abs(gap) > PUDDLE_VIEW_M) continue;
    out.push({ id: `self|${p.id}`, aheadM: Math.round(gap * 10) / 10, own: true, by: myName });
  }
  return out.sort((a, b) => Math.abs(a.aheadM) - Math.abs(b.aheadM));
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
 * Target side: whether attack `a` can be meant for this rider. The thrower resolved it from
 * its view; this re-checks with the thrower's own position (`raceM`) and this rider's view of
 * the others: the kind is a known aimed item, this rider is ahead of the thrower (within
 * AHEAD_TOLERANCE_M), the thrower's gap roughly agrees, and — water bottle — nobody in the race
 * is between them, or — hornets — nobody in the race is ahead of this rider.
 */
export function checkAttack(
  a: Pick<IncomingAttack, 'kind' | 'gapM' | 'raceM' | 'routeId' | 'from'>,
  me: LocalRace,
  riders: readonly GroupRider[],
): AttackRefusal | null {
  if (!Object.hasOwn(POWER_UP_DEFINITIONS, a.kind) || !isAttackKind(a.kind as PowerUpKind)) {
    return 'unknown-kind';
  }
  let gap: number; // how far this rider is ahead of the thrower
  if (a.routeId !== undefined) {
    if (!me.route || me.route.id !== a.routeId) return 'other-route';
    gap = -gapAlongRoute(a.raceM, { ...me.route, m: me.route.m + me.offsetM });
  } else gap = me.distanceM + me.offsetM - a.raceM;
  if (!(gap >= -AHEAD_TOLERANCE_M)) return 'not-ahead';
  if (Math.abs(gap - a.gapM) > 50 + 0.25 * Math.abs(a.gapM)) return 'gap-mismatch';
  const others = riders.filter((r) => r.peerId !== a.from && inRace(r));
  if (POWER_UP_DEFINITIONS[a.kind as PowerUpKind].target === 'ahead') {
    // Someone clearly between the thrower (gap behind) and this rider.
    if (others.some((r) => r.gapM < -LEVEL_M && r.gapM > -gap + LEVEL_M)) {
      return 'not-directly-ahead';
    }
  } else if (others.some((r) => r.gapM > LEVEL_M)) return 'not-leading';
  return null;
}

/**
 * What this rider broadcasts as `items`: always the version (so others know the app supports
 * Freilauf Rumble); in a Rumble also the signed offset, the hit slowing it, cape, protection,
 * the number of items held, whether it is out of the race right now, and its mud puddles.
 */
export function itemsWire(
  pu: PowerUpLive | null,
  rumble: boolean,
  riding: boolean,
  puddles: readonly WirePuddle[] = [],
): RiderItems {
  const out: RiderItems = { v: RUMBLE_PROTOCOL_VERSION };
  if (!rumble) return out;
  const c = pu?.rumble;
  if (puddles.length > 0) out.puddles = puddles.slice(-4);
  if (!pu || !c) {
    out.away = true;
    return out;
  }
  out.offsetM = Math.round(pu.raceOffsetM * 10) / 10;
  if (c.hit) out.hit = { kind: c.hit.kind, s: round1(c.hit.remainingS) };
  if (c.cape) out.capeS = round1(c.cape.remainingS);
  // The whole time nothing lands (a hit in progress and the protection after it).
  if (c.immuneS > 0) out.protectedS = round1(c.immuneS);
  out.held = c.slots.filter((k) => k !== null).length;
  if (!riding || pu.blocked !== null) out.away = true;
  return out;
}

function round1(n: number): number {
  return Math.round(Math.max(0, Math.min(600, n)) * 10) / 10;
}
