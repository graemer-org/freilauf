/**
 * Friend sync as pure functions over `CommunityState`.
 *
 * Transport: `@freilauf/p2p` shared documents — one opaque text per kind and rider, the same
 * text for everybody in the session (≤ 16 KiB each, ≤ 4 kinds / 32 KiB per rider). We use
 * three kinds:
 *
 *   fl-standing    identity (rider id + name) and, when allowed, the own standing
 *   fl-challenges  challenges I take part in (definitions + responses)
 *   fl-relay       standings of friends I pass on (totals only, origin's consent required)
 *
 * Visibility under a broadcast transport: a document is visible to everyone present, so we
 * publish at the most restrictive level among the riders present (unidentified riders count as
 * `none`, a removed/blocked rider silences us entirely). See docs/community.md for the argument.
 */

import {
  type Challenge,
  challengeIsCurrent,
  decodeChallenge,
  encodeChallenge,
  mergeChallenge,
  putChallenge,
} from './challenges';
import type { Now } from './periods';
import {
  FUTURE_TOLERANCE_MS,
  type PublicStanding,
  type Visibility,
  buildOwnStanding,
  decodeStanding,
  encodeStanding,
  meetContact,
  minVisibility,
  relayAllowedTo,
  sanitizeName,
  standingFor,
  visibilityFor,
} from './profile';
import { type CommunityState, evictStandings } from './state';
import { isId, isRecord, safeParse, utf8Length } from './util';

export const KIND_STANDING = 'fl-standing';
export const KIND_CHALLENGES = 'fl-challenges';
export const KIND_RELAY = 'fl-relay';
export const COMMUNITY_KINDS: readonly string[] = [KIND_STANDING, KIND_CHALLENGES, KIND_RELAY];

export const DOCUMENT_FORMAT = 'freilauf-community';
export const DOCUMENT_VERSION = 1;
/** The transport's per-document limit. */
export const MAX_DOCUMENT_BYTES = 16_384;
/** Default budget for all community documents together (leaves 8 KiB of the 32 KiB for e.g. a workout). */
export const DEFAULT_TOTAL_BYTES = 24_576;
export const MAX_RELAY_ENTRIES = 32;
export const MAX_CHALLENGES_PER_DOCUMENT = 16;
/** Own standing is re-issued (new revision) at least this often while sharing. */
export const STANDING_REFRESH_MS = 6 * 3_600_000;

/** A rider in the current session; `riderId` is null until their fl-standing arrived. */
export interface SessionPeer {
  riderId: string | null;
}

export type SessionLevel = 'silent' | Visibility;

export interface ShareOptions {
  /** Budget for all community documents together (default 24 KiB, at most 32 KiB). */
  maxTotalBytes?: number;
  /** Per-document limit (default and maximum 16 KiB). */
  maxDocumentBytes?: number;
}

export interface OutgoingDocument {
  kind: string;
  text: string;
}

export interface ShareResult {
  /** State with the own standing's revision bumped if its content changed. */
  state: CommunityState;
  /**
   * Exactly the community documents to share now. Kinds of COMMUNITY_KINDS that are missing
   * must be unshared.
   */
  documents: OutgoingDocument[];
  level: SessionLevel;
  /** Rider ids whose standings were relayed / challenge ids published (for diagnostics). */
  relayed: string[];
  challenges: string[];
}

/**
 * The level everything published in this session is limited to: the minimum over the riders
 * present of what each may see of me. Unidentified riders and an empty session give `none`
 * (identity only); any removed/blocked rider present gives `silent` (nothing at all).
 */
export function sessionLevel(state: CommunityState, peers: readonly SessionPeer[]): SessionLevel {
  const me = state.profile.riderId;
  const others = peers.filter((p) => p.riderId !== me);
  if (others.length === 0) return 'none';
  let level: Visibility = 'everything';
  for (const p of others) {
    if (p.riderId === null || !isId(p.riderId)) {
      level = 'none';
      continue;
    }
    if (state.contacts[p.riderId]?.blocked) return 'silent';
    level = minVisibility(level, visibilityFor(state, p.riderId));
  }
  return level;
}

function header(t: string, from: string): string {
  return `{"f":"${DOCUMENT_FORMAT}","v":${DOCUMENT_VERSION},"t":"${t}","from":${JSON.stringify(from)}`;
}

/** Packs JSON parts into `{header,"<key>":[parts]}` while they fit; returns text + count. */
function pack(
  head: string,
  key: string,
  parts: readonly string[],
  maxBytes: number,
  maxParts: number,
): { text: string; count: number } | null {
  const open = `${head},"${key}":[`;
  const close = ']}';
  let bytes = utf8Length(open) + utf8Length(close);
  const taken: string[] = [];
  for (const p of parts) {
    if (taken.length >= maxParts) break;
    const add = utf8Length(p) + (taken.length > 0 ? 1 : 0);
    if (bytes + add > maxBytes) continue; // a smaller later part may still fit
    taken.push(p);
    bytes += add;
  }
  if (taken.length === 0) return null;
  return { text: open + taken.join(',') + close, count: taken.length };
}

function bumpOwnStanding(
  state: CommunityState,
  now: Now,
): { state: CommunityState; standing: PublicStanding } {
  const prev = state.published;
  const draft = buildOwnStanding(state, now, Math.max(1, prev.revision), prev.updatedAt);
  const digest = JSON.stringify({ ...encodeStanding(draft), r: 0, u: 0 });
  const due =
    now.ms - prev.updatedAt >= STANDING_REFRESH_MS || now.ms < prev.updatedAt - FUTURE_TOLERANCE_MS;
  if (prev.revision > 0 && digest === prev.digest && !due) {
    return { state, standing: draft };
  }
  const revision = prev.revision + 1;
  const updatedAt =
    prev.updatedAt > now.ms + FUTURE_TOLERANCE_MS || prev.updatedAt < now.ms
      ? now.ms
      : prev.updatedAt;
  return {
    state: { ...state, published: { revision, updatedAt, digest } },
    standing: { ...draft, revision, updatedAt },
  };
}

/**
 * Decides what to publish to the current session. Call it whenever the session's membership or
 * identified riders change, after rides were added/removed, after settings changed and
 * periodically (e.g. every few minutes); share the returned documents and unshare the other
 * community kinds.
 *
 * Priority within the byte budget: own standing (always fits), then challenges (those with a
 * participant present first, then most recently updated), then relayed standings newest first.
 */
export function documentsToShare(
  state: CommunityState,
  peersInSession: readonly SessionPeer[],
  now: Now,
  options: ShareOptions = {},
): ShareResult {
  const me = state.profile.riderId;
  const level = sessionLevel(state, peersInSession);
  const empty: ShareResult = { state, documents: [], level, relayed: [], challenges: [] };
  if (level === 'silent') return empty;

  const maxDoc = Math.max(
    512,
    Math.min(options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES),
  );
  let budget = Math.max(1024, Math.min(options.maxTotalBytes ?? DEFAULT_TOTAL_BYTES, 32_768));
  const documents: OutgoingDocument[] = [];
  const hello = `${header('standing', me)},"name":${JSON.stringify(state.profile.name)}`;

  if (level === 'none') {
    documents.push({ kind: KIND_STANDING, text: `${hello}}` });
    return { ...empty, documents };
  }

  const bumped = bumpOwnStanding(state, now);
  const next = bumped.state;
  const visible = standingFor(bumped.standing, level);
  let standingText = visible
    ? `${hello},"s":${JSON.stringify(encodeStanding(visible))}}`
    : `${hello}}`;
  if (utf8Length(standingText) > Math.min(maxDoc, budget)) standingText = `${hello}}`;
  documents.push({ kind: KIND_STANDING, text: standingText });
  budget -= utf8Length(standingText);

  const present = new Set(
    peersInSession.map((p) => p.riderId).filter((id): id is string => id !== null && id !== me),
  );

  // Challenges I take part in that are still current.
  const challenges = Object.values(next.challenges)
    .filter((c) => c.participants.some((p) => p.riderId === me) && challengeIsCurrent(c, now))
    .map((c) => ({
      c,
      presentHit: c.participants.some((p) => present.has(p.riderId)) ? 1 : 0,
    }))
    .sort(
      (a, b) =>
        b.presentHit - a.presentHit || b.c.updatedAt - a.c.updatedAt || (a.c.id < b.c.id ? -1 : 1),
    )
    .map(({ c }) => c);
  const challengeParts = challenges.map((c) => JSON.stringify(encodeChallenge(c)));
  const packedChallenges = pack(
    header('challenges', me),
    'c',
    challengeParts,
    Math.min(maxDoc, budget),
    MAX_CHALLENGES_PER_DOCUMENT,
  );
  const publishedChallenges: string[] = [];
  if (packedChallenges) {
    documents.push({ kind: KIND_CHALLENGES, text: packedChallenges.text });
    budget -= utf8Length(packedChallenges.text);
    const taken = new Set(
      (safeParse(packedChallenges.text) as { c: { id: string }[] }).c.map((x) => x.id),
    );
    for (const c of challenges) if (taken.has(c.id)) publishedChallenges.push(c.id);
  }

  // Relays: standings of my (non-blocked) contacts, if the origin allows every rider present.
  const relayable = Object.values(next.standings)
    .map((cs) => cs.standing)
    .filter((s) => {
      const c = next.contacts[s.riderId];
      if (!c || c.blocked || present.has(s.riderId) || s.riderId === me) return false;
      for (const p of present) if (!relayAllowedTo(s, p)) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.riderId < b.riderId ? -1 : 1));
  const relayParts = relayable.map((s) =>
    JSON.stringify(encodeStanding(standingFor(s, 'totals') as PublicStanding)),
  );
  const relayed: string[] = [];
  const packedRelays = pack(
    header('relay', me),
    'e',
    relayParts,
    Math.min(maxDoc, budget),
    MAX_RELAY_ENTRIES,
  );
  if (packedRelays) {
    documents.push({ kind: KIND_RELAY, text: packedRelays.text });
    const ids = (safeParse(packedRelays.text) as { e: { id: string }[] }).e.map((x) => x.id);
    relayed.push(...ids);
  }

  return { state: next, documents, level, relayed, challenges: publishedChallenges };
}

// ---------------------------------------------------------------------------------------------
// Receiving

export interface IncomingDocument {
  kind: string;
  text: string;
}

/** Transport-level info about the sender (only used for diagnostics). */
export interface PeerInfo {
  peerId?: string;
  peerName?: string;
}

export type CommunityChange =
  | { type: 'contact-added'; riderId: string }
  | { type: 'standing-updated'; riderId: string; via: string | null }
  | { type: 'challenge-added'; challengeId: string }
  | { type: 'challenge-updated'; challengeId: string }
  | { type: 'rejected'; kind: string; reason: string }
  | { type: 'ignored'; kind: string; reason: string };

export interface MergeResult {
  state: CommunityState;
  /** The sender's rider id once identified (map the p2p peer to it for `documentsToShare`). */
  riderId: string | null;
  changes: CommunityChange[];
}

interface Envelope {
  t: string;
  from: string;
  body: Record<string, unknown>;
}

function parseEnvelope(
  doc: IncomingDocument,
  expectedType: string,
): { ok: true; env: Envelope } | { ok: false; reason: string; ignore?: boolean } {
  if (typeof doc.text !== 'string') return { ok: false, reason: 'not-text' };
  if (utf8Length(doc.text) > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too-large' };
  const v = safeParse(doc.text);
  if (!isRecord(v)) return { ok: false, reason: 'malformed' };
  if (v.f !== DOCUMENT_FORMAT) return { ok: false, reason: 'wrong-format' };
  if (v.v !== DOCUMENT_VERSION) return { ok: false, reason: 'unsupported-version', ignore: true };
  if (v.t !== expectedType) return { ok: false, reason: 'wrong-type' };
  if (!isId(v.from)) return { ok: false, reason: 'invalid-sender' };
  return { ok: true, env: { t: v.t, from: v.from, body: v } };
}

function failureType(env: ReturnType<typeof parseEnvelope>): 'rejected' | 'ignored' {
  return !env.ok && env.ignore ? 'ignored' : 'rejected';
}

/** Rank of a copy at equal revision: direct beats relayed, more detail beats less. */
function copyRank(s: PublicStanding, via: string | null): number {
  return (via === null ? 2 : 0) + (s.level === 'everything' ? 1 : 0);
}

function acceptStanding(
  state: CommunityState,
  s: PublicStanding,
  via: string | null,
  nowMs: number,
  changes: CommunityChange[],
): CommunityState {
  if (s.riderId === state.profile.riderId) return state;
  if (state.contacts[s.riderId]?.blocked) return state;
  const ex = state.standings[s.riderId];
  const better =
    !ex ||
    s.revision > ex.standing.revision ||
    (s.revision === ex.standing.revision && copyRank(s, via) > copyRank(ex.standing, ex.via));
  if (!better) return state;
  changes.push({ type: 'standing-updated', riderId: s.riderId, via });
  return {
    ...state,
    standings: { ...state.standings, [s.riderId]: { standing: s, via, receivedAt: nowMs } },
  };
}

/**
 * Merges the documents one peer currently shares (pass all of them; repeated calls with the
 * same documents are no-ops). Strictly validates everything; an invalid document is rejected
 * as a whole and changes nothing. Never throws.
 *
 * - The fl-standing document identifies the sender; without a valid one nothing is merged.
 *   The sender becomes a contact (first shared session) or gets its last-seen updated.
 * - Standings: newest revision per rider wins; at equal revision a direct copy beats a relayed
 *   one. Entries about myself and about removed riders are ignored. Relayed entries are only
 *   kept if their origin allows me to receive them second-hand; they are stripped to totals.
 *   Relayed riders I do not know are held as friends of friends.
 * - Challenges: only those listing me and the sender as participants (see `mergeChallenge`).
 */
export function mergeIncoming(
  state: CommunityState,
  fromPeer: PeerInfo,
  documents: readonly IncomingDocument[],
  now: Now,
): MergeResult {
  const changes: CommunityChange[] = [];
  try {
    return mergeUnsafe(state, fromPeer, documents, now, changes);
  } catch {
    return { state, riderId: null, changes: [{ type: 'rejected', kind: '*', reason: 'internal' }] };
  }
}

function mergeUnsafe(
  state0: CommunityState,
  _fromPeer: PeerInfo,
  documents: readonly IncomingDocument[],
  now: Now,
  changes: CommunityChange[],
): MergeResult {
  const me = state0.profile.riderId;
  const byKind = new Map<string, IncomingDocument>();
  for (const d of Array.isArray(documents) ? documents : []) {
    if (!isRecord(d) || typeof d.kind !== 'string') continue;
    if (COMMUNITY_KINDS.includes(d.kind) && !byKind.has(d.kind)) {
      byKind.set(d.kind, { kind: d.kind, text: d.text as string });
    }
  }
  const standingDoc = byKind.get(KIND_STANDING);
  if (!standingDoc) {
    if (byKind.size > 0) changes.push({ type: 'ignored', kind: '*', reason: 'unidentified' });
    return { state: state0, riderId: null, changes };
  }
  const hello = parseEnvelope(standingDoc, 'standing');
  if (!hello.ok) {
    changes.push({
      type: hello.ignore ? 'ignored' : 'rejected',
      kind: KIND_STANDING,
      reason: hello.reason,
    });
    return { state: state0, riderId: null, changes };
  }
  const from = hello.env.from;
  const name = hello.env.body.name;
  if (typeof name !== 'string' || name.length > 200) {
    changes.push({ type: 'rejected', kind: KIND_STANDING, reason: 'invalid-name' });
    return { state: state0, riderId: null, changes };
  }
  let own: PublicStanding | null = null;
  if (hello.env.body.s !== undefined) {
    own = decodeStanding(hello.env.body.s, now.ms);
    if (!own || own.riderId !== from) {
      changes.push({ type: 'rejected', kind: KIND_STANDING, reason: 'invalid-standing' });
      return { state: state0, riderId: null, changes };
    }
  }
  if (from === me) {
    changes.push({ type: 'ignored', kind: KIND_STANDING, reason: 'self' });
    return { state: state0, riderId: from, changes };
  }
  if (state0.contacts[from]?.blocked) {
    changes.push({ type: 'ignored', kind: '*', reason: 'blocked' });
    return { state: state0, riderId: from, changes };
  }

  // Identify / add the sender.
  let state = state0;
  if (!state.contacts[from]) changes.push({ type: 'contact-added', riderId: from });
  state = meetContact(state, from, sanitizeName(name), now.ms);
  if (own) state = acceptStanding(state, own, null, now.ms, changes);

  // Challenges.
  const chDoc = byKind.get(KIND_CHALLENGES);
  if (chDoc) {
    const env = parseEnvelope(chDoc, 'challenges');
    const list = env.ok ? env.env.body.c : undefined;
    const decoded: Challenge[] = [];
    let reason = env.ok ? '' : env.reason;
    if (env.ok && env.env.from !== from) reason = 'sender-mismatch';
    else if (env.ok && (!Array.isArray(list) || list.length > MAX_CHALLENGES_PER_DOCUMENT)) {
      reason = 'invalid-list';
    } else if (env.ok && Array.isArray(list)) {
      for (const raw of list) {
        const c = decodeChallenge(raw, now.ms, FUTURE_TOLERANCE_MS);
        if (!c || decoded.some((x) => x.id === c.id)) {
          reason = 'invalid-challenge';
          break;
        }
        decoded.push(c);
      }
    }
    if (reason) {
      changes.push({ type: failureType(env), kind: KIND_CHALLENGES, reason });
    } else {
      for (const inc of decoded) {
        if (!inc.participants.some((p) => p.riderId === from)) continue;
        if (state.contacts[inc.creator]?.blocked) continue;
        const local = state.challenges[inc.id];
        const merged = mergeChallenge(local, inc, me, from);
        if (!merged || !merged.changed) continue;
        state = putChallenge(state, merged.challenge);
        changes.push({
          type: local ? 'challenge-updated' : 'challenge-added',
          challengeId: inc.id,
        });
      }
    }
  }

  // Relayed standings.
  const relayDoc = byKind.get(KIND_RELAY);
  if (relayDoc) {
    const env = parseEnvelope(relayDoc, 'relay');
    const list = env.ok ? env.env.body.e : undefined;
    const decoded: PublicStanding[] = [];
    let reason = env.ok ? '' : env.reason;
    if (env.ok && env.env.from !== from) reason = 'sender-mismatch';
    else if (env.ok && (!Array.isArray(list) || list.length > MAX_RELAY_ENTRIES)) {
      reason = 'invalid-list';
    } else if (env.ok && Array.isArray(list)) {
      for (const raw of list) {
        const s = decodeStanding(raw, now.ms);
        if (!s || decoded.some((x) => x.riderId === s.riderId)) {
          reason = 'invalid-entry';
          break;
        }
        decoded.push(s);
      }
    }
    if (reason) {
      changes.push({ type: failureType(env), kind: KIND_RELAY, reason });
    } else {
      for (const s of decoded) {
        if (s.riderId === from || s.riderId === me) continue;
        if (!relayAllowedTo(s, me)) continue;
        const totalsOnly = standingFor(s, 'totals') as PublicStanding;
        state = acceptStanding(state, totalsOnly, from, now.ms, changes);
      }
    }
  }

  if (state !== state0)
    state = { ...state, standings: evictStandings(state.standings, state.contacts) };
  return { state, riderId: from, changes };
}

/** Kinds this module owns (for unsharing what `documentsToShare` no longer returns). */
export function isCommunityKind(kind: string): boolean {
  return COMMUNITY_KINDS.includes(kind);
}
