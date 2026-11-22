/**
 * The local community state: plain JSON, versioned, safe to persist as-is. `migrate()` turns any
 * stored value (possibly corrupt or from another version) back into a valid state.
 */

import { type Challenge, MAX_CHALLENGES, decodeChallenge, encodeChallenge } from './challenges';
import type { Now } from './periods';
import {
  type CachedStanding,
  type Contact,
  MAX_BLOCKED,
  MAX_CONTACTS,
  type Profile,
  type PublicStanding,
  buildOwnStanding,
  createProfile,
  decodeStanding,
  encodeStanding,
  isVisibility,
  newRiderId,
  sanitizeName,
} from './profile';
import { type RideFacts, validateRideFacts } from './scoring';
import { type Ledger, emptyLedger, ledgerAdd, ledgerFromFacts, ledgerRemove } from './totals';
import { isFiniteNumber, isId, isIntIn, isRecord, safeParse, utf8Length } from './util';

export const SCHEMA_VERSION = 1;
/** Own rides kept (oldest evicted first); far more than the standings need. */
export const MAX_OWN_RIDES = 5000;
/** Standings of other riders kept (friends of friends evicted first, then oldest). */
export const MAX_CACHED_STANDINGS = 300;

/** Last published revision of the own standing. */
export interface PublishedRevision {
  revision: number;
  updatedAt: number;
  /** Content of that revision (without revision/time) to detect changes. */
  digest: string;
}

export interface CommunityState {
  schema: typeof SCHEMA_VERSION;
  profile: Profile;
  ledger: Ledger;
  published: PublishedRevision;
  contacts: Record<string, Contact>;
  standings: Record<string, CachedStanding>;
  challenges: Record<string, Challenge>;
}

export function emptyState(riderId: string, name: string, nowMs: number): CommunityState {
  return {
    schema: SCHEMA_VERSION,
    profile: createProfile(riderId, name, nowMs),
    ledger: emptyLedger(),
    published: { revision: 0, updatedAt: 0, digest: '' },
    contacts: {},
    standings: {},
    challenges: {},
  };
}

/** Adds (or replaces) one own ride. Evicts the oldest rides beyond MAX_OWN_RIDES. */
export function addRide(state: CommunityState, facts: RideFacts): CommunityState {
  let ledger = ledgerAdd(state.ledger, facts);
  const ids = Object.keys(ledger.rides);
  if (ids.length > MAX_OWN_RIDES) {
    const oldest = Object.values(ledger.rides)
      .sort((a, b) => a.startedAt - b.startedAt || (a.rideId < b.rideId ? -1 : 1))
      .slice(0, ids.length - MAX_OWN_RIDES);
    for (const f of oldest) ledger = ledgerRemove(ledger, f.rideId);
  }
  return { ...state, ledger };
}

export function removeRide(state: CommunityState, rideId: string): CommunityState {
  const ledger = ledgerRemove(state.ledger, rideId);
  return ledger === state.ledger ? state : { ...state, ledger };
}

/** The own standing as it is right now (full detail, not published, revision unchanged). */
export function ownStanding(state: CommunityState, now: Now): PublicStanding {
  return buildOwnStanding(
    state,
    now,
    Math.max(1, state.published.revision),
    Math.max(state.published.updatedAt, now.ms),
  );
}

/** Own standing plus every cached standing, keyed by rider id (input for challenge progress). */
export function allStandings(state: CommunityState, now: Now): Record<string, PublicStanding> {
  const out: Record<string, PublicStanding> = {};
  for (const [id, cs] of Object.entries(state.standings)) out[id] = cs.standing;
  out[state.profile.riderId] = ownStanding(state, now);
  return out;
}

/** Applies the cached-standings cap: friends of friends go first, then the oldest received. */
export function evictStandings(
  standings: Record<string, CachedStanding>,
  contacts: Record<string, Contact>,
): Record<string, CachedStanding> {
  const entries = Object.entries(standings);
  if (entries.length <= MAX_CACHED_STANDINGS) return standings;
  entries.sort(([ia, a], [ib, b]) => {
    const fa = contacts[ia] ? 1 : 0;
    const fb = contacts[ib] ? 1 : 0;
    return fb - fa || b.receivedAt - a.receivedAt || (ia < ib ? -1 : 1);
  });
  return Object.fromEntries(entries.slice(0, MAX_CACHED_STANDINGS));
}

/** Approximate persisted size (UTF-8 bytes of the JSON). */
export function estimateStateBytes(state: CommunityState): number {
  return utf8Length(JSON.stringify(state));
}

// ---------------------------------------------------------------------------------------------
// Migration / repair

/** Storage may hold data written with a clock that was ahead; accept up to a year. */
const STORAGE_TOLERANCE_MS = 365 * 86_400_000;

function repairProfile(v: unknown, random: () => number, nowMs: number): Profile {
  if (isRecord(v) && isId(v.riderId)) {
    const p = createProfile(v.riderId, typeof v.name === 'string' ? v.name : 'Rider', nowMs);
    return {
      ...p,
      createdAt: isFiniteNumber(v.createdAt) ? v.createdAt : p.createdAt,
      friendsOfFriends: v.friendsOfFriends === true,
      defaultVisibility: isVisibility(v.defaultVisibility) ? v.defaultVisibility : 'totals',
    };
  }
  return createProfile(newRiderId(random), 'Rider', nowMs);
}

function repairContact(id: string, v: unknown): Contact | null {
  if (!isId(id) || !isRecord(v) || v.riderId !== id) return null;
  const firstSeen = isFiniteNumber(v.firstSeen) ? v.firstSeen : 0;
  const lastSeen = isFiniteNumber(v.lastSeen) ? v.lastSeen : firstSeen;
  const blocked = v.blocked === true;
  const alias = typeof v.alias === 'string' ? sanitizeName(v.alias) || null : null;
  return {
    riderId: id,
    name: sanitizeName(v.name) || 'Rider',
    alias: blocked ? null : alias,
    visibility: blocked ? 'none' : isVisibility(v.visibility) ? v.visibility : 'none',
    firstSeen,
    lastSeen,
    blocked,
  };
}

function repairStanding(id: string, v: unknown, nowMs: number): CachedStanding | null {
  if (!isRecord(v)) return null;
  let standing: PublicStanding | null = null;
  try {
    standing = decodeStanding(
      encodeStanding(v.standing as PublicStanding),
      nowMs + STORAGE_TOLERANCE_MS,
    );
  } catch {
    return null;
  }
  if (!standing || standing.riderId !== id) return null;
  const via = v.via === null ? null : isId(v.via) ? v.via : undefined;
  if (via === undefined) return null;
  return { standing, via, receivedAt: isFiniteNumber(v.receivedAt) ? v.receivedAt : 0 };
}

function repairChallenge(id: string, v: unknown, nowMs: number): Challenge | null {
  try {
    const c = decodeChallenge(encodeChallenge(v as Challenge), nowMs, STORAGE_TOLERANCE_MS);
    return c && c.id === id ? c : null;
  } catch {
    return null;
  }
}

/**
 * Validates and repairs stored state (an object or its JSON text). Anything that does not
 * validate is dropped individually; a missing/broken profile gets a fresh rider id from
 * `random`. Never throws: in the worst case the result is a fresh state.
 */
export function migrate(raw: unknown, random: () => number, nowMs: number): CommunityState {
  try {
    const v = typeof raw === 'string' ? safeParse(raw) : raw;
    if (!isRecord(v)) return emptyState(newRiderId(random), 'Rider', nowMs);
    const profile = repairProfile(v.profile, random, nowMs);
    const state = emptyState(profile.riderId, profile.name, nowMs);
    state.profile = profile;

    const facts: RideFacts[] = [];
    const rides = isRecord(v.ledger) && isRecord(v.ledger.rides) ? v.ledger.rides : {};
    for (const [rid, f] of Object.entries(rides)) {
      const ok = validateRideFacts(f);
      if (ok && ok.rideId === rid) facts.push(ok);
    }
    facts.sort((a, b) => b.startedAt - a.startedAt);
    // Periods are always rebuilt from the facts (they are derived data).
    state.ledger = ledgerFromFacts(facts.slice(0, MAX_OWN_RIDES));

    if (isRecord(v.published)) {
      const { revision, updatedAt, digest } = v.published;
      if (
        isIntIn(revision, 0, 2 ** 31 - 1) &&
        isFiniteNumber(updatedAt) &&
        typeof digest === 'string'
      ) {
        state.published = { revision, updatedAt, digest };
      }
    }

    const contacts: Record<string, Contact> = {};
    if (isRecord(v.contacts)) {
      for (const [id, c] of Object.entries(v.contacts)) {
        const ok = id !== profile.riderId ? repairContact(id, c) : null;
        if (ok) contacts[id] = ok;
      }
    }
    const active = Object.values(contacts).filter((c) => !c.blocked);
    const blocked = Object.values(contacts).filter((c) => c.blocked);
    const recent = (a: Contact, b: Contact) => b.lastSeen - a.lastSeen;
    state.contacts = Object.fromEntries(
      [
        ...active.sort(recent).slice(0, MAX_CONTACTS),
        ...blocked.sort(recent).slice(0, MAX_BLOCKED),
      ].map((c) => [c.riderId, c]),
    );

    const standings: Record<string, CachedStanding> = {};
    if (isRecord(v.standings)) {
      for (const [id, s] of Object.entries(v.standings)) {
        if (id === profile.riderId || state.contacts[id]?.blocked) continue;
        const ok = repairStanding(id, s, nowMs);
        if (ok) standings[id] = ok;
      }
    }
    state.standings = evictStandings(standings, state.contacts);

    const challenges: Challenge[] = [];
    if (isRecord(v.challenges)) {
      for (const [id, c] of Object.entries(v.challenges)) {
        const ok = repairChallenge(id, c, nowMs);
        if (ok && ok.participants.some((p) => p.riderId === profile.riderId)) challenges.push(ok);
      }
    }
    challenges.sort((a, b) => b.updatedAt - a.updatedAt);
    state.challenges = Object.fromEntries(
      challenges.slice(0, MAX_CHALLENGES).map((c) => [c.id, c]),
    );
    return state;
  } catch {
    return emptyState(newRiderId(random), 'Rider', Number.isFinite(nowMs) ? nowMs : 0);
  }
}
