/**
 * Rider profile, contacts book, public standings and visibility.
 *
 * A `PublicStanding` is the document a rider publishes about themself: totals and points of the
 * recent weeks and months, optionally best efforts, plus a relay policy saying who else may
 * receive it second-hand. `standingFor()` redacts it to a visibility level.
 */

import {
  type MonthKey,
  type Now,
  type PeriodKey,
  type WeekKey,
  addMonths,
  addWeeks,
  isMonthKey,
  isWeekKey,
  monthKey,
  recentMonths,
  recentWeeks,
  weekKey,
  weeksBetween,
} from './periods';
import { BEST_EFFORT_KEYS, type BestEfforts, POINTS_PER_DAY_CAP, SCORING_VERSION } from './scoring';
import type { CommunityState } from './state';
import { type Totals, emptyTotals, ledgerTotals } from './totals';
import { isFiniteNumber, isId, isIntIn, isRecord, randomId, sanitizeText } from './util';

/** What a contact may see of me. */
export type Visibility = 'none' | 'totals' | 'everything';
/** The level a standing document was produced at. */
export type StandingLevel = 'totals' | 'everything';

export const VISIBILITIES: readonly Visibility[] = ['none', 'totals', 'everything'];
const RANK: Record<Visibility, number> = { none: 0, totals: 1, everything: 2 };

export function minVisibility(a: Visibility, b: Visibility): Visibility {
  return RANK[a] <= RANK[b] ? a : b;
}
export function isVisibility(v: unknown): v is Visibility {
  return v === 'none' || v === 'totals' || v === 'everything';
}

export const MAX_NAME_CODE_POINTS = 32;
/** Weeks / months of totals in a standing, and weeks of ride-count history (for streaks). */
export const STANDING_WEEKS = 8;
export const STANDING_MONTHS = 6;
export const HISTORY_WEEKS = 52;
/** Max riders listed in a standing's relay audience / exclusion list. */
export const MAX_RELAY_LIST = 48;
/** Accepted clock skew for timestamps from other riders. */
export const FUTURE_TOLERANCE_MS = 10 * 60_000;
/** Earliest plausible timestamp in a standing (2020-01-01). */
const MIN_TIMESTAMP = Date.UTC(2020, 0, 1);
const MAX_REVISION = 2 ** 31 - 1;

export interface Profile {
  riderId: string;
  name: string;
  createdAt: number;
  /**
   * "Friends of friends may see my totals": when on, mutual friends may pass my totals on to
   * anyone they ride with (except riders I set to `none` or removed). Default off.
   */
  friendsOfFriends: boolean;
  /** Visibility given to a rider the first time we share a session. */
  defaultVisibility: Visibility;
}

export interface Contact {
  riderId: string;
  /** The name the rider calls themself (updated whenever we hear from them). */
  name: string;
  /** Local rename; shown instead of `name` when set. */
  alias: string | null;
  /** What this contact may see of me. */
  visibility: Visibility;
  firstSeen: number;
  lastSeen: number;
  /** Removed/blocked: a tombstone so they are not re-added; they receive nothing. */
  blocked: boolean;
}

export interface PeriodStanding extends Totals {
  key: PeriodKey;
  /** Only present at level `everything`. */
  best?: BestEfforts;
}

export interface StandingRelayPolicy {
  /** Origin allows its totals to reach friends of friends. */
  friendsOfFriends: boolean;
  /** Riders who may receive this standing second-hand (the origin shares totals with them). */
  audience: string[];
  /** With `friendsOfFriends`: riders who must never receive it second-hand. */
  exclude: string[];
}

export interface PublicStanding {
  riderId: string;
  name: string;
  /** Increases whenever the origin publishes changed content (or refreshes it). */
  revision: number;
  /** Origin's clock (ms) when this revision was produced: "as of". */
  updatedAt: number;
  scoringVersion: number;
  level: StandingLevel;
  /** Week / month the standing was produced in (origin's local time). */
  asOfWeek: WeekKey;
  asOfMonth: MonthKey;
  /** Periods with rides among the 8 weeks / 6 months up to `asOf*`; missing ones had none. */
  weeks: PeriodStanding[];
  months: PeriodStanding[];
  /** Ride counts per week, index 0 = `asOfWeek`, going back; missing tail = 0. */
  weeklyRides: number[];
  relay: StandingRelayPolicy;
}

/** A standing of another rider as held locally. */
export interface CachedStanding {
  standing: PublicStanding;
  /** null: received from the rider directly; otherwise the relaying rider's id. */
  via: string | null;
  receivedAt: number;
}

/** A fresh random rider id (16 URL-safe characters, 96 bits). */
export function newRiderId(random: () => number): string {
  return randomId(random, 16);
}

export function sanitizeName(v: unknown): string {
  return sanitizeText(v, MAX_NAME_CODE_POINTS);
}

export function createProfile(riderId: string, name: string, nowMs: number): Profile {
  return {
    riderId,
    name: sanitizeName(name) || 'Rider',
    createdAt: Number.isFinite(nowMs) ? nowMs : 0,
    friendsOfFriends: false,
    defaultVisibility: 'totals',
  };
}

// ---------------------------------------------------------------------------------------------
// Contacts book

export const MAX_CONTACTS = 500;
export const MAX_BLOCKED = 500;

/** What `riderId` may see of me. Blocked and unknown-but-blocked → none. */
export function visibilityFor(state: CommunityState, riderId: string): Visibility {
  const c = state.contacts[riderId];
  if (c) return c.blocked ? 'none' : c.visibility;
  return state.profile.defaultVisibility;
}

/** Name to display for a rider: alias, their own name, or a cached standing's name. */
export function displayName(state: CommunityState, riderId: string): string {
  if (riderId === state.profile.riderId) return state.profile.name;
  const c = state.contacts[riderId];
  if (c) return c.alias ?? c.name;
  return state.standings[riderId]?.standing.name ?? 'Rider';
}

function evictContacts(contacts: Record<string, Contact>): Record<string, Contact> {
  const all = Object.values(contacts);
  const active = all.filter((c) => !c.blocked);
  const blocked = all.filter((c) => c.blocked);
  if (active.length <= MAX_CONTACTS && blocked.length <= MAX_BLOCKED) return contacts;
  const byRecent = (a: Contact, b: Contact) =>
    b.lastSeen - a.lastSeen || (a.riderId < b.riderId ? -1 : 1);
  const keep = [
    ...active.sort(byRecent).slice(0, MAX_CONTACTS),
    ...blocked.sort(byRecent).slice(0, MAX_BLOCKED),
  ];
  return Object.fromEntries(keep.map((c) => [c.riderId, c]));
}

/**
 * Records that we shared a session with `riderId`: adds them as a contact on first meeting
 * (with the default visibility) or updates name and last-seen. Blocked riders stay blocked.
 */
export function meetContact(
  state: CommunityState,
  riderId: string,
  name: string,
  nowMs: number,
): CommunityState {
  if (!isId(riderId) || riderId === state.profile.riderId) return state;
  const existing = state.contacts[riderId];
  const clean = sanitizeName(name) || existing?.name || 'Rider';
  if (existing?.blocked) return state;
  const contact: Contact = existing
    ? { ...existing, name: clean, lastSeen: Math.max(existing.lastSeen, nowMs) }
    : {
        riderId,
        name: clean,
        alias: null,
        visibility: state.profile.defaultVisibility,
        firstSeen: nowMs,
        lastSeen: nowMs,
        blocked: false,
      };
  return { ...state, contacts: evictContacts({ ...state.contacts, [riderId]: contact }) };
}

export function renameContact(
  state: CommunityState,
  riderId: string,
  alias: string | null,
): CommunityState {
  const c = state.contacts[riderId];
  if (!c || c.blocked) return state;
  const clean = alias === null ? null : sanitizeName(alias) || null;
  return { ...state, contacts: { ...state.contacts, [riderId]: { ...c, alias: clean } } };
}

export function setContactVisibility(
  state: CommunityState,
  riderId: string,
  visibility: Visibility,
): CommunityState {
  const c = state.contacts[riderId];
  if (!c || c.blocked || !isVisibility(visibility)) return state;
  return { ...state, contacts: { ...state.contacts, [riderId]: { ...c, visibility } } };
}

/**
 * Removes (blocks) a contact: their cached standing is deleted, documents from them are ignored
 * from now on, they receive nothing (we publish nothing while they are in a session) and they
 * are excluded from relays of our totals. A tombstone remembers them so the next shared session
 * does not re-add them. `unblockContact` undoes it.
 */
export function removeContact(
  state: CommunityState,
  riderId: string,
  nowMs: number,
): CommunityState {
  if (!isId(riderId) || riderId === state.profile.riderId) return state;
  const c = state.contacts[riderId];
  const tomb: Contact = {
    riderId,
    name: c?.name ?? state.standings[riderId]?.standing.name ?? 'Rider',
    alias: null,
    visibility: 'none',
    firstSeen: c?.firstSeen ?? nowMs,
    lastSeen: Math.max(c?.lastSeen ?? 0, nowMs),
    blocked: true,
  };
  const standings = { ...state.standings };
  delete standings[riderId];
  // Standings that reached us only through the removed rider are dropped as well.
  for (const [id, cs] of Object.entries(standings)) if (cs.via === riderId) delete standings[id];
  return {
    ...state,
    contacts: evictContacts({ ...state.contacts, [riderId]: tomb }),
    standings,
  };
}

/** Lifts a block; the rider is forgotten and becomes a new contact the next time we meet. */
export function unblockContact(state: CommunityState, riderId: string): CommunityState {
  const c = state.contacts[riderId];
  if (!c?.blocked) return state;
  const contacts = { ...state.contacts };
  delete contacts[riderId];
  return { ...state, contacts };
}

export function setDisplayName(state: CommunityState, name: string): CommunityState {
  const clean = sanitizeName(name);
  if (!clean) return state;
  return { ...state, profile: { ...state.profile, name: clean } };
}

export function setFriendsOfFriends(state: CommunityState, allowed: boolean): CommunityState {
  return { ...state, profile: { ...state.profile, friendsOfFriends: allowed === true } };
}

export function setDefaultVisibility(state: CommunityState, v: Visibility): CommunityState {
  if (!isVisibility(v)) return state;
  return { ...state, profile: { ...state.profile, defaultVisibility: v } };
}

// ---------------------------------------------------------------------------------------------
// Own standing

/** Relay policy derived from the contacts book (see docs/community.md, "Relaying"). */
export function relayPolicy(state: CommunityState): StandingRelayPolicy {
  const byRecent = (a: Contact, b: Contact) =>
    b.lastSeen - a.lastSeen || (a.riderId < b.riderId ? -1 : 1);
  const contacts = Object.values(state.contacts).sort(byRecent);
  const audience = contacts
    .filter((c) => !c.blocked && c.visibility !== 'none')
    .slice(0, MAX_RELAY_LIST)
    .map((c) => c.riderId);
  let friendsOfFriends = state.profile.friendsOfFriends;
  let exclude: string[] = [];
  if (friendsOfFriends) {
    exclude = contacts.filter((c) => c.blocked || c.visibility === 'none').map((c) => c.riderId);
    // If the exclusion list does not fit we cannot express it: fall back to audience only.
    if (exclude.length > MAX_RELAY_LIST) {
      friendsOfFriends = false;
      exclude = [];
    }
  }
  return { friendsOfFriends, audience, exclude };
}

/**
 * The full (level `everything`) standing computed from the own ledger, stamped with the given
 * revision and time. Pure: does not bump anything (see `sync.documentsToShare`).
 */
export function buildOwnStanding(
  state: CommunityState,
  now: Now,
  revision: number,
  updatedAt: number,
): PublicStanding {
  const toPeriod = (key: PeriodKey): PeriodStanding | null => {
    const t = ledgerTotals(state.ledger, key);
    if (t.rides === 0) return null;
    return clampPeriod(t, isWeekKey(key) ? WEEK_LIMITS : MONTH_LIMITS);
  };
  const weeks = recentWeeks(now, STANDING_WEEKS)
    .map(toPeriod)
    .filter((p): p is PeriodStanding => p !== null);
  const months = recentMonths(now, STANDING_MONTHS)
    .map(toPeriod)
    .filter((p): p is PeriodStanding => p !== null);
  const weeklyRides = recentWeeks(now, HISTORY_WEEKS).map((k, i) =>
    i < STANDING_WEEKS
      ? (weeks.find((w) => w.key === k)?.rides ?? 0)
      : Math.min(state.ledger.periods[k]?.rides ?? 0, WEEK_LIMITS.rides),
  );
  while (weeklyRides.length > 0 && weeklyRides[weeklyRides.length - 1] === 0) weeklyRides.pop();
  return {
    riderId: state.profile.riderId,
    name: state.profile.name,
    revision,
    updatedAt,
    scoringVersion: SCORING_VERSION,
    level: 'everything',
    asOfWeek: weekKey(now.ms, now.utcOffsetMin),
    asOfMonth: monthKey(now.ms, now.utcOffsetMin),
    weeks,
    months,
    weeklyRides,
    relay: relayPolicy(state),
  };
}

/**
 * The version of a standing a viewer at `level` may receive: `none` → null (nothing is sent),
 * `totals` → without best efforts, `everything` → unchanged. Never adds information.
 */
export function standingFor(standing: PublicStanding, level: Visibility): PublicStanding | null {
  if (level === 'none') return null;
  if (level === 'everything' || standing.level === 'totals') {
    return level === 'everything' ? standing : { ...standing, level: 'totals' };
  }
  const strip = (p: PeriodStanding): PeriodStanding => {
    const { best: _best, ...rest } = p;
    return rest;
  };
  return {
    ...standing,
    level: 'totals',
    weeks: standing.weeks.map(strip),
    months: standing.months.map(strip),
  };
}

/** Whether the origin of `standing` allows it to reach `riderId` second-hand. */
export function relayAllowedTo(standing: PublicStanding, riderId: string): boolean {
  if (riderId === standing.riderId) return false;
  if (standing.relay.audience.includes(riderId)) return true;
  return standing.relay.friendsOfFriends && !standing.relay.exclude.includes(riderId);
}

/**
 * The totals of `key` according to a standing: `known` totals (zero if the period is covered
 * but had no rides) and `complete` = the standing was produced after the period ended. Null if
 * the standing does not cover the period.
 */
export function standingPeriod(
  standing: PublicStanding,
  key: PeriodKey,
): { totals: PeriodStanding; complete: boolean } | null {
  if (isWeekKey(key)) {
    if (key > standing.asOfWeek) return { totals: { key, ...emptyTotals() }, complete: false };
    if (key < addWeeks(standing.asOfWeek, -(STANDING_WEEKS - 1))) return null;
    const p = standing.weeks.find((w) => w.key === key);
    return { totals: p ?? { key, ...emptyTotals() }, complete: key < standing.asOfWeek };
  }
  if (isMonthKey(key)) {
    if (key > standing.asOfMonth) return { totals: { key, ...emptyTotals() }, complete: false };
    if (key < addMonths(standing.asOfMonth, -(STANDING_MONTHS - 1))) return null;
    const p = standing.months.find((m) => m.key === key);
    return { totals: p ?? { key, ...emptyTotals() }, complete: key < standing.asOfMonth };
  }
  return null;
}

/** Ride count of a week from the standing's history; null if outside the history. */
export function weeklyRidesOf(standing: PublicStanding, key: WeekKey): number | null {
  const i = weeksBetween(key, standing.asOfWeek);
  if (i < 0) return 0;
  if (i >= HISTORY_WEEKS) return null;
  return standing.weeklyRides[i] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Wire format

type Row = (string | number | null)[];

function encodeRow(p: PeriodStanding, withBest: boolean): Row {
  const row: Row = [
    p.key,
    p.rides,
    p.movingS,
    p.distanceM,
    p.elevationGainM,
    p.energyKj,
    p.points,
    p.groupRides,
    p.rideDays,
  ];
  if (withBest && p.best) for (const k of BEST_EFFORT_KEYS) row.push(p.best[k]);
  return row;
}

/** Compact JSON form of a standing (keys documented in docs/community.md). */
export function encodeStanding(s: PublicStanding): Record<string, unknown> {
  const e = s.level === 'everything';
  return {
    id: s.riderId,
    n: s.name,
    r: s.revision,
    u: s.updatedAt,
    sv: s.scoringVersion,
    l: e ? 'e' : 't',
    aw: s.asOfWeek,
    am: s.asOfMonth,
    w: s.weeks.map((p) => encodeRow(p, e)),
    m: s.months.map((p) => encodeRow(p, e)),
    h: s.weeklyRides,
    ff: s.relay.friendsOfFriends ? 1 : 0,
    au: s.relay.audience,
    ex: s.relay.exclude,
  };
}

interface PeriodLimits {
  rides: number;
  days: number;
  distanceM: number;
  elevationGainM: number;
  energyKj: number;
}
const WEEK_LIMITS: PeriodLimits = {
  rides: 100,
  days: 7,
  distanceM: 2_000_000, // 2000 km per week
  elevationGainM: 100_000,
  energyKj: 60_000,
};
const MONTH_LIMITS: PeriodLimits = {
  rides: 400,
  days: 31,
  distanceM: 9_000_000,
  elevationGainM: 450_000,
  energyKj: 270_000,
};
const MAX_BEST_W = 2500;

/**
 * Keeps the own (local, possibly odd) totals inside the limits receivers enforce, so a strange
 * ride never makes the whole standing unacceptable to friends.
 */
function clampPeriod(
  t: Totals & { key: PeriodKey; best: BestEfforts },
  lim: PeriodLimits,
): PeriodStanding {
  const c = (v: number, max: number) => Math.max(0, Math.min(Math.round(v), max));
  const rides = c(t.rides, lim.rides);
  const rideDays = Math.max(1, c(t.rideDays, Math.min(lim.days, rides)));
  const best: BestEfforts = { p5s: null, p1m: null, p5m: null, p20m: null };
  for (const k of BEST_EFFORT_KEYS) {
    const b = t.best[k];
    best[k] = b === null ? null : c(b, MAX_BEST_W);
  }
  return {
    key: t.key,
    rides,
    movingS: c(t.movingS, rideDays * 86_400),
    distanceM: c(t.distanceM, lim.distanceM),
    elevationGainM: c(t.elevationGainM, lim.elevationGainM),
    energyKj: c(t.energyKj, lim.energyKj),
    points: c(t.points, rideDays * POINTS_PER_DAY_CAP),
    groupRides: c(t.groupRides, rides),
    rideDays,
    best,
  };
}

function decodeRow(v: unknown, kind: 'week' | 'month', withBest: boolean): PeriodStanding | null {
  if (!Array.isArray(v) || v.length !== (withBest ? 13 : 9)) return null;
  const [key, rides, movingS, distanceM, elevationGainM, energyKj, points, groupRides, rideDays] =
    v as unknown[];
  const lim = kind === 'week' ? WEEK_LIMITS : MONTH_LIMITS;
  if (kind === 'week' ? !isWeekKey(key) : !isMonthKey(key)) return null;
  if (!isIntIn(rides, 0, lim.rides)) return null;
  if (!isIntIn(rideDays, 0, Math.min(lim.days, rides))) return null;
  if (rides > 0 && rideDays < 1) return null;
  // ≤ 24 h of riding per day with rides.
  if (!isIntIn(movingS, 0, rideDays * 86_400)) return null;
  if (!isIntIn(distanceM, 0, lim.distanceM)) return null;
  if (!isIntIn(elevationGainM, 0, lim.elevationGainM)) return null;
  if (!isIntIn(energyKj, 0, lim.energyKj)) return null;
  if (!isIntIn(points, 0, rideDays * POINTS_PER_DAY_CAP)) return null;
  if (!isIntIn(groupRides, 0, rides)) return null;
  const p: PeriodStanding = {
    key: key as string,
    rides,
    movingS,
    distanceM,
    elevationGainM,
    energyKj,
    points,
    groupRides,
    rideDays,
  };
  if (withBest) {
    const best: BestEfforts = { p5s: null, p1m: null, p5m: null, p20m: null };
    for (let i = 0; i < BEST_EFFORT_KEYS.length; i++) {
      const b = v[9 + i] as unknown;
      const k = BEST_EFFORT_KEYS[i];
      if (k === undefined) return null;
      if (b !== null && !isIntIn(b, 0, MAX_BEST_W)) return null;
      best[k] = b;
    }
    p.best = best;
  }
  return p;
}

function decodeIdList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_RELAY_LIST) return null;
  const seen = new Set<string>();
  for (const id of v) {
    if (!isId(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return [...seen];
}

/**
 * Validates a standing from the wire (or storage). Returns null for anything implausible:
 * wrong types, non-integers, out-of-range totals (≤ 24 h ride time per riding day, ≤ 2000 km
 * per week, …), periods outside the covered range or duplicated, inconsistent ride history,
 * oversized lists, timestamps before 2020 or more than 10 minutes in the future.
 */
export function decodeStanding(v: unknown, nowMs: number): PublicStanding | null {
  if (!isRecord(v)) return null;
  const { id, n, r, u, sv, l, aw, am, w, m, h, ff, au, ex } = v;
  if (!isId(id)) return null;
  if (typeof n !== 'string' || n.length > 200) return null;
  if (!isIntIn(r, 1, MAX_REVISION)) return null;
  if (!isFiniteNumber(u) || u < MIN_TIMESTAMP) return null;
  if (!isFiniteNumber(nowMs) || u > nowMs + FUTURE_TOLERANCE_MS) return null;
  if (!isIntIn(sv, 1, 1000)) return null;
  if (l !== 't' && l !== 'e') return null;
  if (typeof aw !== 'string' || typeof am !== 'string') return null;
  if (!isWeekKey(aw) || !isMonthKey(am)) return null;
  // The as-of period must match the timestamp in some real-world offset (±14 h).
  if (aw < weekKey(u, -840) || aw > weekKey(u, 840)) return null;
  if (am < monthKey(u, -840) || am > monthKey(u, 840)) return null;
  if (!Array.isArray(w) || w.length > STANDING_WEEKS) return null;
  if (!Array.isArray(m) || m.length > STANDING_MONTHS) return null;
  if (!Array.isArray(h) || h.length > HISTORY_WEEKS) return null;
  if (ff !== 0 && ff !== 1) return null;
  const audience = decodeIdList(au);
  const exclude = decodeIdList(ex);
  if (!audience || !exclude) return null;
  if (ff === 0 && exclude.length > 0) return null;
  const withBest = l === 'e';

  const weeks: PeriodStanding[] = [];
  const firstWeek = addWeeks(aw, -(STANDING_WEEKS - 1));
  for (const row of w) {
    const p = decodeRow(row, 'week', withBest);
    if (!p || p.key < firstWeek || p.key > aw) return null;
    if (weeks.some((x) => x.key === p.key)) return null;
    weeks.push(p);
  }
  const months: PeriodStanding[] = [];
  const firstMonth = addMonths(am, -(STANDING_MONTHS - 1));
  for (const row of m) {
    const p = decodeRow(row, 'month', withBest);
    if (!p || p.key < firstMonth || p.key > am) return null;
    if (months.some((x) => x.key === p.key)) return null;
    months.push(p);
  }
  const weeklyRides: number[] = [];
  for (const x of h) {
    if (!isIntIn(x, 0, WEEK_LIMITS.rides)) return null;
    weeklyRides.push(x);
  }
  // History and week rows must agree inside the covered weeks.
  for (let i = 0; i < STANDING_WEEKS; i++) {
    const key = addWeeks(aw, -i);
    const rows = weeks.find((x) => x.key === key)?.rides ?? 0;
    if ((weeklyRides[i] ?? 0) !== rows) return null;
  }
  return {
    riderId: id,
    name: sanitizeName(n) || 'Rider',
    revision: r,
    updatedAt: u,
    scoringVersion: sv,
    level: withBest ? 'everything' : 'totals',
    asOfWeek: aw,
    asOfMonth: am,
    weeks,
    months,
    weeklyRides,
    relay: { friendsOfFriends: ff === 1, audience, exclude },
  };
}
