/**
 * The app side of the community features (docs/community.md, "Integration"): owns the
 * `CommunityState`, persists it, feeds it with the rider's own rides, keeps the group session's
 * community documents in sync and derives plain, referentially stable view models for the UI.
 *
 * No DOM and no Electron: storage, clock, time-zone offset, randomness and timers are injected,
 * so everything here is deterministic in tests. Nothing is recomputed on the 4 Hz live tick:
 * views change only on rides, sync events, user actions and (for time-based values such as the
 * period rollover, remaining time and staleness) at most once a minute via `tick()`.
 */
import {
  CHALLENGE_TYPES,
  COMMUNITY_KINDS,
  DEFAULT_TOTAL_BYTES,
  STALE_AFTER_MS,
  TEMPLATES,
  TOTALS_METRICS,
  addMonths,
  addRide,
  addWeeks,
  allStandings,
  cancelChallenge as cancelChallengeCore,
  challengeIsCurrent,
  challengeProgress,
  createChallenge as createChallengeCore,
  displayName,
  documentsToShare,
  estimateStateBytes,
  inviteToChallenge as inviteToChallengeCore,
  isCommunityKind,
  isWeekKey,
  leaderboard as leaderboardCore,
  leaveChallenge as leaveChallengeCore,
  ledgerTotals,
  meetContact,
  mergeIncoming,
  migrate,
  monthKey,
  newChallengeId,
  periodBounds,
  putChallenge,
  removeContact as removeContactCore,
  removeRide as removeRideCore,
  renameContact as renameContactCore,
  respondToChallenge as respondToChallengeCore,
  rideFacts,
  setContactVisibility as setContactVisibilityCore,
  setDefaultVisibility as setDefaultVisibilityCore,
  setDisplayName,
  setFriendsOfFriends as setFriendsOfFriendsCore,
  unblockContact as unblockContactCore,
  utf8Length,
  weekKey,
} from '@freilauf/community';
import type {
  Challenge,
  ChallengeMetric,
  ChallengeProgress,
  ChallengeResult,
  ChallengeType,
  CommunityChange,
  CommunityState,
  InvitationState,
  LeaderboardRow,
  Now,
  PeriodTotals,
  SessionLevel,
  TotalsMetric,
  Visibility,
} from '@freilauf/community';
import type { RecordedRide } from '@freilauf/session';
import type { RideListItem } from '../../shared/contract';
import type { ScopedLog } from './logger';
import { NULL_LOG } from './logger';
import type { KeyValueStorage } from './workoutLibrary';

/** localStorage key of the persisted `CommunityState` (JSON, periods stripped). */
export const COMMUNITY_STORAGE_KEY = 'freilauf.community.v1';
/** Small companion key: backfill marker and the remembered leaderboard view. */
export const COMMUNITY_META_KEY = 'freilauf.community.v1.meta';
/** Where unreadable stored data is copied once before it is replaced (for manual recovery). */
export const COMMUNITY_CORRUPT_KEY = 'freilauf.community.v1.corrupt';

/** The transport's per-rider budget (docs/p2p.md). */
const TRANSPORT_TOTAL_BYTES = 32_768;
const DEFAULT_SAVE_DELAY_MS = 2_000;
/** Re-publish (standing refresh, relays) and refresh contacts' last-seen this often in a session. */
const RESYNC_INTERVAL_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** How many weeks ahead a challenge may be scheduled. */
const MAX_WEEKS_AHEAD = 8;

// ---------------------------------------------------------------------------------------------
// Group link

/** A community-relevant document another rider shares in the session. */
export interface GroupDocument {
  peerId: string;
  peerName: string;
  kind: string;
  /** Content id (changes whenever the text does). */
  id: string;
  text: string;
}

export interface GroupPeer {
  peerId: string;
  name: string;
}

/**
 * What the service needs from a group session; `JoinedGroup` (appStore) implements it on top of
 * `@freilauf/p2p`'s `GroupRide`.
 */
export interface CommunityGroupLink {
  /** Shares `text` as the local document of `kind`; null on success, otherwise the reason. */
  shareDocument(kind: string, text: string): string | null;
  unshareDocument(kind: string): void;
  /** What the local rider shares now (all kinds, e.g. a workout too: counts against the budget). */
  getLocalDocuments(): { kind: string; text: string }[];
  getSharedDocuments(): GroupDocument[];
  /** A remote document arrived or went away. */
  onDocumentChange(listener: (peerId: string, kind: string) => void): () => void;
  /** Everybody else in the room, whatever their connection status. */
  getPeers(): GroupPeer[];
  /**
   * MUST fire synchronously when a peer enters the room, before any document can be served to
   * it (`GroupRide.onPeerJoined` guarantees that). The no-leak rule depends on it.
   */
  onPeerJoined(listener: (peer: GroupPeer) => void): () => void;
  /** Membership or connection changes; may fire often (it is cheap to handle repeats). */
  onPeersChange(listener: () => void): () => void;
}

/** Where backfilled rides come from (`FreilaufApi.rides`). */
export interface RideSource {
  list(): Promise<RideListItem[]>;
  load(id: string): Promise<RecordedRide | null>;
}

// ---------------------------------------------------------------------------------------------
// View models (plain, serialisable)

export type LeaderboardPeriod = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth';
export const LEADERBOARD_PERIODS: readonly LeaderboardPeriod[] = [
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
];

export interface LeaderboardViewQuery {
  period: LeaderboardPeriod;
  metric: TotalsMetric;
  /** 'friends', or a challenge id (its accepted participants). */
  scope: 'friends' | (string & {});
}

export interface LeaderboardView extends LeaderboardViewQuery {
  /** The concrete week ('2026-W47') or month ('2026-11') key. */
  periodKey: string;
  rows: LeaderboardRow[];
}

export interface OwnPeriodView {
  key: string;
  /** Local period bounds (epoch ms). */
  startsAt: number;
  endsAt: number;
  /** Points, distance, time, … plus best efforts (`best`) of the period. */
  totals: PeriodTotals;
}

export interface ChallengeView {
  id: string;
  title: string;
  type: ChallengeType;
  metric: ChallengeMetric;
  target: number;
  week: string;
  status: 'active' | 'cancelled';
  creatorId: string;
  creatorName: string;
  isCreator: boolean;
  /** My invitation state, null if I am not listed (cannot happen for stored challenges). */
  myState: InvitationState | null;
  /** Creator, still active, not full. */
  canInvite: boolean;
  /** Still published to sessions (week not over by more than 14 days). */
  current: boolean;
  /** Derived locally from standings, see `challengeProgress`. */
  progress: ChallengeProgress;
}

export interface ContactView {
  riderId: string;
  /** The name the rider calls themself. */
  name: string;
  alias: string | null;
  /** Alias or name. */
  displayName: string;
  visibility: Visibility;
  firstSeen: number;
  lastSeen: number;
  /** In the current group session. */
  present: boolean;
  /** Their latest standing we hold, or null if they share nothing with us. */
  standing: {
    updatedAt: number;
    /** Whole hours since `updatedAt` (changes at most hourly). */
    ageHours: number;
    /** Older than 36 h (`STALE_AFTER_MS`). */
    stale: boolean;
    /** null = received from them directly; otherwise who relayed it. */
    viaRiderId: string | null;
    viaName: string | null;
  } | null;
}

export interface BlockedContactView {
  riderId: string;
  name: string;
  /** When they were removed (or last seen). */
  since: number;
}

export interface CommunitySessionView {
  /** A group is attached. */
  active: boolean;
  /** Other riders in the room. */
  peers: number;
  /** Of them, identified as community riders. */
  identified: number;
  /** What we currently publish at (null outside a session). */
  level: SessionLevel | null;
}

export interface BackfillView {
  status: 'pending' | 'running' | 'done' | 'failed';
  /** Rides examined / to examine in this run. */
  processed: number;
  total: number;
  /** Rides added to the ledger by the backfill. */
  added: number;
}

export interface CommunityView {
  profile: {
    riderId: string;
    name: string;
    defaultVisibility: Visibility;
    friendsOfFriends: boolean;
  };
  /** Own totals of the current local week / month (with points). */
  week: OwnPeriodView;
  month: OwnPeriodView;
  /** The board selected with `setLeaderboardView` (default: this week, points, friends). */
  leaderboard: LeaderboardView;
  /** All stored challenges: running/upcoming first, then finished, then cancelled. */
  challenges: ChallengeView[];
  /** Challenges I am invited to and have not answered (still active and not finished). */
  invitations: ChallengeView[];
  /** Non-removed contacts: present first, then most recently seen. */
  contacts: ContactView[];
  /** Removed (blocked) riders, most recent first; `unblockContact` lifts it. */
  blocked: BlockedContactView[];
  session: CommunitySessionView;
  backfill: BackfillView;
  storage: {
    /** Approximate persisted size (UTF-8 bytes). */
    bytes: number;
    /** Last save failed (quota or blocked storage); data is kept in memory meanwhile. */
    saveFailed: boolean;
  };
}

/** Plain description of the seven templates, for building the "new challenge" form. */
export interface ChallengeTemplateInfo {
  type: ChallengeType;
  metrics: { metric: ChallengeMetric; target: { min: number; max: number } | null }[];
  maxParticipants: number;
}

export const CHALLENGE_TEMPLATES: readonly ChallengeTemplateInfo[] = CHALLENGE_TYPES.map((type) => {
  const tpl = TEMPLATES[type];
  return {
    type,
    metrics: tpl.metrics.map((metric) => {
      const r = tpl.target(metric);
      return { metric, target: r ? { min: r[0], max: r[1] } : null };
    }),
    maxParticipants: tpl.maxParticipants,
  };
});

export interface CreateChallengeInput {
  type: ChallengeType;
  /** Default 'thisWeek'. A week key ('2026-W48') is accepted too; never a past week. */
  week?: 'thisWeek' | 'nextWeek' | (string & {});
  /** Default: the template's first metric. */
  metric?: ChallengeMetric;
  /** Required for templates with a target (see CHALLENGE_TEMPLATES), integer in range. */
  target?: number;
  /** Optional; a default title is generated. */
  title?: string;
  /** Contacts to invite right away. */
  invite?: readonly string[];
}

export type CommunityActionResult =
  { ok: true; challengeId?: string } | { ok: false; error: string };

export interface CommunityServiceOptions {
  /** Where the state is kept (localStorage in the app); null = memory only. */
  storage: KeyValueStorage | null;
  now?: () => number;
  /** Local UTC offset (minutes, east positive) in force at `ms`. */
  utcOffsetMin?: (ms: number) => number;
  /** Uniform [0, 1); default backed by crypto.getRandomValues. */
  random?: () => number;
  log?: ScopedLog;
  /** User-facing notices (e.g. storage full). Repeats are suppressed here. */
  onNotice?: (kind: 'error' | 'info', message: string) => void;
  /** Debounce for saving after changes (default 2 s; 0 = save at once). */
  saveDelayMs?: number;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** Rides loaded per backfill step (default 4). */
  backfillBatchSize?: number;
  /** Lets the UI breathe between backfill steps (default: a 0 ms timeout). */
  yieldToUi?: () => Promise<void>;
}

const REASONS: Record<Extract<ChallengeResult, { ok: false }>['reason'], string> = {
  'invalid-template': 'Unknown challenge type.',
  'invalid-metric': 'This challenge type does not support that metric.',
  'invalid-target': 'The target is out of range for this challenge.',
  'invalid-week': 'Pick a valid week.',
  'invalid-id': 'That rider or challenge is not valid.',
  'not-creator': 'Only the rider who created the challenge can do that.',
  'not-participant': 'You are not part of this challenge.',
  'already-invited': 'That rider is already in this challenge.',
  full: 'This challenge has no room for more riders.',
  'invalid-transition': 'That is not possible in the current state of the challenge.',
  cancelled: 'This challenge was cancelled.',
};

interface Meta {
  backfillDone: boolean;
  leaderboard: LeaderboardViewQuery;
}

const DEFAULT_QUERY: LeaderboardViewQuery = {
  period: 'thisWeek',
  metric: 'points',
  scope: 'friends',
};

function defaultRandom(): () => number {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint32Array): Uint32Array } }).crypto;
  if (!c) return Math.random;
  return () => (c.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32;
}

/** Returns `prev` when `next` has the same JSON content, so React selectors stay stable. */
function keep<T>(prev: T | undefined, next: T): T {
  if (prev === undefined) return next;
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CommunityService {
  readonly #storage: KeyValueStorage | null;
  readonly #clock: () => number;
  readonly #offset: (ms: number) => number;
  readonly #random: () => number;
  readonly #log: ScopedLog;
  readonly #onNotice: (kind: 'error' | 'info', message: string) => void;
  readonly #saveDelayMs: number;
  readonly #timers: NonNullable<CommunityServiceOptions['timers']>;
  readonly #batchSize: number;
  readonly #yieldToUi: () => Promise<void>;

  #state: CommunityState;
  #meta: Meta;
  #saveTimer: unknown = null;
  #dirty = false;
  #saveFailed = false;
  #bytes = 0;
  #disposed = false;

  #view: CommunityView;
  #listeners = new Set<(view: CommunityView) => void>();
  #viewMinute = -1;

  #backfill: BackfillView;
  /** Ride ids deleted in this run (a running backfill must not re-add them). */
  #deleted = new Set<string>();

  #group: CommunityGroupLink | null = null;
  #groupOff: (() => void)[] = [];
  /** p2p peer id → community rider id (null until their fl-standing arrived). */
  #peerRiders = new Map<string, string | null>();
  /** Community document ids last merged per peer (merging is skipped when unchanged). */
  #peerSignatures = new Map<string, string>();
  #membershipKey = '';
  #level: SessionLevel | null = null;
  #lastResyncAt = 0;
  #syncing = false;

  constructor(options: CommunityServiceOptions) {
    this.#storage = options.storage;
    this.#clock = options.now ?? Date.now;
    this.#offset = options.utcOffsetMin ?? ((ms) => -new Date(ms).getTimezoneOffset());
    this.#random = options.random ?? defaultRandom();
    this.#log = options.log ?? NULL_LOG;
    const notified = new Set<string>();
    this.#onNotice = (kind, message) => {
      if (notified.has(message)) return;
      notified.add(message);
      options.onNotice?.(kind, message);
    };
    this.#saveDelayMs = Math.max(0, options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS);
    this.#timers = options.timers ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.#batchSize = Math.max(1, Math.floor(options.backfillBatchSize ?? 4));
    this.#yieldToUi =
      options.yieldToUi ??
      (() => new Promise<void>((resolve) => this.#timers.setTimeout(resolve, 0)));

    const loaded = this.#load();
    this.#state = loaded.state;
    this.#meta = loaded.meta;
    this.#bytes = estimateStateBytes(this.#state);
    this.#backfill = {
      status: this.#meta.backfillDone ? 'done' : 'pending',
      processed: 0,
      total: 0,
      added: 0,
    };
    this.#view = this.#computeView(undefined);
    this.#viewMinute = Math.floor(this.#clock() / MINUTE_MS);
    if (loaded.fresh) this.#scheduleSave();
    this.#log.info('community state loaded', {
      fresh: loaded.fresh,
      rides: Object.keys(this.#state.ledger.rides).length,
      contacts: Object.keys(this.#state.contacts).length,
      standings: Object.keys(this.#state.standings).length,
      challenges: Object.keys(this.#state.challenges).length,
      bytes: this.#bytes,
    });
  }

  // ---- reading ------------------------------------------------------------------------------

  /** The current view model (same object until something visible changed). */
  get view(): CommunityView {
    return this.#view;
  }

  /** The raw state (read-only; for diagnostics and tests). */
  get state(): CommunityState {
    return this.#state;
  }

  /** Called with every new view object. */
  subscribe(listener: (view: CommunityView) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A leaderboard for any query (the default one is in `view.leaderboard`). Computed on demand;
   * cache it in the UI if it is shown continuously.
   */
  leaderboard(query: LeaderboardViewQuery): LeaderboardView {
    return this.#leaderboard(query, this.#viewNow());
  }

  // ---- own rides ----------------------------------------------------------------------------

  /**
   * Adds the facts of a finished ride (idempotent per ride id: facts are never recomputed).
   * Returns true if the ride was added.
   */
  recordRide(ride: RecordedRide, options: { ftpW: number; groupRide: boolean }): boolean {
    if (this.#disposed || this.#state.ledger.rides[ride.id]) return false;
    let facts: ReturnType<typeof rideFacts> = null;
    try {
      facts = rideFacts({
        rideId: ride.id,
        startedAt: ride.startedAt,
        samples: ride.samples,
        ftpW: options.ftpW,
        utcOffsetMin: this.#offset(ride.startedAt),
        groupRide: options.groupRide,
      });
    } catch (err) {
      this.#log.error('scoring a ride failed', { error: errorText(err) });
    }
    if (!facts) {
      this.#log.warn('ride could not be scored for the community features');
      return false;
    }
    this.#deleted.delete(ride.id);
    this.#state = addRide(this.#state, facts);
    this.#log.info('ride added to community totals', {
      rides: Object.keys(this.#state.ledger.rides).length,
      groupRide: facts.groupRide,
    });
    this.#changed();
    return true;
  }

  /** Removes a deleted ride from the totals. */
  removeRide(rideId: string): void {
    this.#deleted.add(rideId);
    const next = removeRideCore(this.#state, rideId);
    if (next === this.#state) return;
    this.#state = next;
    this.#log.info('ride removed from community totals', {
      rides: Object.keys(next.ledger.rides).length,
    });
    this.#changed();
  }

  /**
   * Once per installation: computes facts for saved rides that are not in the ledger yet
   * (finished rides only, oldest first, a few at a time so the UI stays responsive). The FTP
   * is the current one (`ftpW`) — an approximation for older rides, marked `backfilled` in the
   * facts — and `groupRide` is unknown (false). Safe to call repeatedly; runs at most once.
   */
  async backfill(source: RideSource, ftpW: number): Promise<void> {
    if (this.#meta.backfillDone || this.#backfill.status === 'running' || this.#disposed) return;
    this.#setBackfill({ status: 'running', processed: 0, total: 0, added: 0 });
    try {
      const list = await source.list();
      const todo = list
        .filter((r) => r.finished && !this.#state.ledger.rides[r.id])
        .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
      let processed = 0;
      let added = 0;
      this.#setBackfill({ status: 'running', processed, total: todo.length, added });
      for (let i = 0; i < todo.length; i += this.#batchSize) {
        for (const item of todo.slice(i, i + this.#batchSize)) {
          if (this.#disposed) return;
          processed++;
          if (this.#state.ledger.rides[item.id] || this.#deleted.has(item.id)) continue;
          const ride = await source.load(item.id).catch(() => null);
          // The ride may have been deleted or recorded meanwhile.
          if (!ride || this.#disposed || this.#deleted.has(item.id)) continue;
          if (this.#state.ledger.rides[ride.id]) continue;
          const facts = rideFacts({
            rideId: ride.id,
            startedAt: ride.startedAt,
            samples: ride.samples,
            ftpW,
            utcOffsetMin: this.#offset(ride.startedAt),
            groupRide: false,
            backfilled: true,
          });
          if (!facts) continue;
          this.#state = addRide(this.#state, facts);
          added++;
        }
        this.#backfill = { status: 'running', processed, total: todo.length, added };
        this.#changed();
        await this.#yieldToUi();
      }
      if (this.#disposed) return;
      this.#meta = { ...this.#meta, backfillDone: true };
      this.#saveMeta();
      this.#log.info('community backfill done', { examined: processed, added });
      this.#setBackfill({ status: 'done', processed, total: todo.length, added });
    } catch (err) {
      this.#log.warn('community backfill failed', { error: errorText(err) });
      this.#setBackfill({ ...this.#backfill, status: 'failed' });
    }
  }

  // ---- profile ------------------------------------------------------------------------------

  /** Follows `settings.rider.name`. */
  setDisplayName(name: string): void {
    this.#apply(setDisplayName(this.#state, name));
  }

  setDefaultVisibility(visibility: Visibility): void {
    this.#apply(setDefaultVisibilityCore(this.#state, visibility));
  }

  setFriendsOfFriends(allowed: boolean): void {
    this.#apply(setFriendsOfFriendsCore(this.#state, allowed));
  }

  // ---- contacts -----------------------------------------------------------------------------

  setContactVisibility(riderId: string, visibility: Visibility): CommunityActionResult {
    const c = this.#state.contacts[riderId];
    if (!c || c.blocked) return { ok: false, error: 'That rider is not among your friends.' };
    if (visibility !== 'none' && visibility !== 'totals' && visibility !== 'everything') {
      return { ok: false, error: 'Unknown visibility.' };
    }
    this.#apply(setContactVisibilityCore(this.#state, riderId, visibility));
    return { ok: true };
  }

  /** A local name for a contact; null or '' restores their own name. */
  renameContact(riderId: string, alias: string | null): CommunityActionResult {
    const c = this.#state.contacts[riderId];
    if (!c || c.blocked) return { ok: false, error: 'That rider is not among your friends.' };
    this.#apply(renameContactCore(this.#state, riderId, alias && alias.trim() ? alias : null));
    return { ok: true };
  }

  /**
   * Removes a contact — which blocks them: their data is deleted, they receive nothing from us
   * (we publish nothing while they are in a session) and they are not re-added.
   */
  removeContact(riderId: string): CommunityActionResult {
    if (riderId === this.#state.profile.riderId || !this.#state.contacts[riderId]) {
      return { ok: false, error: 'That rider is not among your friends.' };
    }
    this.#apply(removeContactCore(this.#state, riderId, this.#clock()));
    this.#log.info('contact removed (blocked)', { contacts: this.#contactCount() });
    return { ok: true };
  }

  /** Lifts a block; the rider becomes a new contact the next time you ride together. */
  unblockContact(riderId: string): CommunityActionResult {
    if (!this.#state.contacts[riderId]?.blocked) {
      return { ok: false, error: 'That rider is not blocked.' };
    }
    this.#apply(unblockContactCore(this.#state, riderId));
    return { ok: true };
  }

  // ---- challenges ---------------------------------------------------------------------------

  createChallenge(input: CreateChallengeInput): CommunityActionResult {
    if (!(CHALLENGE_TYPES as readonly string[]).includes(input.type)) {
      return { ok: false, error: REASONS['invalid-template'] };
    }
    const now = this.#now();
    const current = weekKey(now.ms, now.utcOffsetMin);
    const week =
      input.week === undefined || input.week === 'thisWeek'
        ? current
        : input.week === 'nextWeek'
          ? addWeeks(current, 1)
          : input.week;
    if (!isWeekKey(week)) return { ok: false, error: REASONS['invalid-week'] };
    if (week < current) return { ok: false, error: 'Pick this week or a later one.' };
    if (week > addWeeks(current, MAX_WEEKS_AHEAD)) {
      return { ok: false, error: `Pick a week within the next ${MAX_WEEKS_AHEAD} weeks.` };
    }
    const invite = [...new Set(input.invite ?? [])];
    for (const id of invite) {
      const problem = this.#inviteProblem(id);
      if (problem) return { ok: false, error: problem };
    }
    const me = this.#state.profile;
    const created = createChallengeCore(
      {
        id: newChallengeId(this.#random),
        type: input.type,
        week,
        metric: input.metric,
        target: input.target,
        title: input.title,
      },
      { riderId: me.riderId, name: me.name },
      now.ms,
    );
    if (!created.ok) return { ok: false, error: this.#reason(created, input) };
    let challenge = created.challenge;
    for (const id of invite) {
      const r = inviteToChallengeCore(challenge, me.riderId, this.#invitee(id), now.ms);
      if (!r.ok) return { ok: false, error: REASONS[r.reason] };
      challenge = r.challenge;
    }
    this.#apply(putChallenge(this.#state, challenge));
    this.#log.info('challenge created', { type: challenge.type, invited: invite.length });
    return { ok: true, challengeId: challenge.id };
  }

  inviteToChallenge(challengeId: string, riderId: string): CommunityActionResult {
    const problem = this.#inviteProblem(riderId);
    if (problem) return { ok: false, error: problem };
    return this.#challengeAction(challengeId, (ch, me, nowMs) =>
      inviteToChallengeCore(ch, me, this.#invitee(riderId), nowMs),
    );
  }

  respondToChallenge(
    challengeId: string,
    response: 'accepted' | 'declined',
  ): CommunityActionResult {
    if (response !== 'accepted' && response !== 'declined') {
      return { ok: false, error: 'Answer with accept or decline.' };
    }
    return this.#challengeAction(challengeId, (ch, me, nowMs) =>
      respondToChallengeCore(ch, me, response, nowMs),
    );
  }

  leaveChallenge(challengeId: string): CommunityActionResult {
    return this.#challengeAction(challengeId, (ch, me, nowMs) => leaveChallengeCore(ch, me, nowMs));
  }

  cancelChallenge(challengeId: string): CommunityActionResult {
    return this.#challengeAction(challengeId, (ch, me, nowMs) =>
      cancelChallengeCore(ch, me, nowMs),
    );
  }

  // ---- leaderboard selection -----------------------------------------------------------------

  setLeaderboardView(query: Partial<LeaderboardViewQuery>): CommunityActionResult {
    const next: LeaderboardViewQuery = { ...this.#meta.leaderboard, ...query };
    if (!LEADERBOARD_PERIODS.includes(next.period)) return { ok: false, error: 'Unknown period.' };
    if (!TOTALS_METRICS.includes(next.metric)) return { ok: false, error: 'Unknown metric.' };
    if (next.scope !== 'friends' && !this.#state.challenges[next.scope]) {
      return { ok: false, error: 'That challenge does not exist.' };
    }
    this.#meta = { ...this.#meta, leaderboard: next };
    this.#saveMeta();
    this.#refreshView();
    return { ok: true };
  }

  // ---- group session ------------------------------------------------------------------------

  /**
   * Starts syncing with a group session: publishes identity at once (everyone is unidentified),
   * merges what the others share and re-publishes on every relevant change.
   */
  attach(group: CommunityGroupLink): void {
    this.detach();
    if (this.#disposed) return;
    this.#group = group;
    this.#lastResyncAt = this.#clock();
    this.#groupOff = [
      // Synchronous, before the newcomer can be served: narrow what we publish right here.
      group.onPeerJoined((peer) => this.#guard(() => this.#sync([peer.peerId]))),
      group.onPeersChange(() => this.#guard(() => this.#onPeersChange())),
      group.onDocumentChange((peerId, kind) =>
        this.#guard(() => {
          if (isCommunityKind(kind)) this.#mergePeer(peerId);
        }),
      ),
    ];
    this.#log.info('community sync attached to the group');
    this.#guard(() => {
      this.#sync();
      for (const d of group.getSharedDocuments()) this.#mergePeer(d.peerId);
    });
    this.#refreshView();
  }

  /** Stops syncing (call before leaving the group). Withdraws our community documents. */
  detach(): void {
    const group = this.#group;
    if (!group) return;
    for (const off of this.#groupOff) off();
    this.#groupOff = [];
    this.#group = null;
    for (const kind of COMMUNITY_KINDS) {
      try {
        group.unshareDocument(kind);
      } catch {
        // leaving anyway
      }
    }
    this.#peerRiders.clear();
    this.#peerSignatures.clear();
    this.#membershipKey = '';
    this.#level = null;
    this.#log.info('community sync detached');
    this.#refreshView();
  }

  /**
   * Re-publishes with `reserveBytes` kept free of the transport budget, e.g. right before the
   * app shares a workout of that size (the workout takes precedence over relays/challenges).
   */
  makeRoom(reserveBytes: number): void {
    this.#guard(() => this.#sync([], Math.max(0, reserveBytes)));
  }

  /** Re-evaluates what to publish (after the app's own documents changed). */
  resync(): void {
    this.#guard(() => this.#sync());
  }

  // ---- housekeeping -------------------------------------------------------------------------

  /**
   * Call often (the app's 250 ms tick is fine): does nothing until the minute changes, then
   * refreshes time-based view values; every 5 minutes in a session it also refreshes the
   * contacts' last-seen and re-publishes (standing refresh, relays).
   */
  tick(): void {
    if (this.#disposed) return;
    const nowMs = this.#clock();
    const minute = Math.floor(nowMs / MINUTE_MS);
    if (minute === this.#viewMinute) return;
    this.#viewMinute = minute;
    if (this.#group && nowMs - this.#lastResyncAt >= RESYNC_INTERVAL_MS) {
      this.#lastResyncAt = nowMs;
      this.#guard(() => {
        let state = this.#state;
        for (const riderId of new Set(this.#peerRiders.values())) {
          const c = riderId ? state.contacts[riderId] : undefined;
          if (riderId && c && !c.blocked) state = meetContact(state, riderId, c.name, nowMs);
        }
        if (state !== this.#state) {
          this.#state = state;
          this.#scheduleSave();
        }
        this.#sync();
      });
    }
    this.#refreshView();
  }

  /** Writes pending changes now. */
  flush(): void {
    if (this.#saveTimer !== null) {
      this.#timers.clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    if (this.#dirty) this.#save();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.detach();
    this.flush();
    this.#disposed = true;
    this.#listeners.clear();
  }

  // ---- internals: state changes ---------------------------------------------------------------

  #now(): Now {
    const ms = this.#clock();
    return { ms, utcOffsetMin: this.#offset(ms) };
  }

  /** Time for view models: quantised to the minute so views are stable within a minute. */
  #viewNow(): Now {
    const ms = Math.floor(this.#clock() / MINUTE_MS) * MINUTE_MS;
    return { ms, utcOffsetMin: this.#offset(ms) };
  }

  #apply(next: CommunityState): void {
    if (next === this.#state || this.#disposed) return;
    this.#state = next;
    this.#changed();
  }

  /** After a local change: persist, re-publish to the session (synchronously), refresh views. */
  #changed(): void {
    this.#scheduleSave();
    this.#guard(() => this.#sync());
    this.#refreshView();
  }

  #guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#log.error('community sync step failed', { error: errorText(err) });
    }
  }

  #contactCount(): number {
    return Object.values(this.#state.contacts).filter((c) => !c.blocked).length;
  }

  #inviteProblem(riderId: string): string | null {
    const c = this.#state.contacts[riderId];
    if (riderId === this.#state.profile.riderId) return 'You are already in the challenge.';
    if (!c || c.blocked) return 'Only friends you have ridden with can be invited.';
    return null;
  }

  /** Invitees are listed under their own name (the alias is local and never published). */
  #invitee(riderId: string): { riderId: string; name: string } {
    return { riderId, name: this.#state.contacts[riderId]?.name ?? 'Rider' };
  }

  #reason(r: Extract<ChallengeResult, { ok: false }>, input: CreateChallengeInput): string {
    if (r.reason === 'invalid-target') {
      const tpl = CHALLENGE_TEMPLATES.find((t) => t.type === input.type);
      const metric = input.metric ?? tpl?.metrics[0]?.metric;
      const range = tpl?.metrics.find((m) => m.metric === metric)?.target;
      if (range) return `The target must be a whole number from ${range.min} to ${range.max}.`;
    }
    return REASONS[r.reason];
  }

  #challengeAction(
    challengeId: string,
    action: (ch: Challenge, me: string, nowMs: number) => ChallengeResult,
  ): CommunityActionResult {
    const ch = this.#state.challenges[challengeId];
    if (!ch) return { ok: false, error: 'That challenge does not exist (any more).' };
    const r = action(ch, this.#state.profile.riderId, this.#clock());
    if (!r.ok) return { ok: false, error: REASONS[r.reason] };
    this.#apply(putChallenge(this.#state, r.challenge));
    this.#log.info('challenge updated', { type: ch.type });
    return { ok: true, challengeId };
  }

  #setBackfill(next: BackfillView): void {
    this.#backfill = next;
    this.#refreshView();
  }

  // ---- internals: persistence -----------------------------------------------------------------

  #load(): { state: CommunityState; meta: Meta; fresh: boolean } {
    const nowMs = this.#clock();
    let raw: string | null = null;
    let metaRaw: string | null = null;
    try {
      raw = this.#storage?.getItem(COMMUNITY_STORAGE_KEY) ?? null;
      metaRaw = this.#storage?.getItem(COMMUNITY_META_KEY) ?? null;
    } catch (err) {
      this.#log.warn('community storage is not readable; keeping data in memory', {
        error: errorText(err),
      });
    }
    let fresh = raw === null;
    if (raw !== null) {
      let parsed = true;
      try {
        JSON.parse(raw);
      } catch {
        parsed = false;
      }
      if (!parsed) {
        fresh = true;
        this.#log.warn('stored community data was unreadable; starting fresh', {
          bytes: raw.length,
        });
        try {
          this.#storage?.setItem(COMMUNITY_CORRUPT_KEY, raw);
        } catch {
          // best effort only
        }
      }
    }
    const state = migrate(raw, this.#random, nowMs);
    const meta: Meta = { backfillDone: false, leaderboard: DEFAULT_QUERY };
    try {
      const m: unknown = metaRaw ? JSON.parse(metaRaw) : null;
      if (m && typeof m === 'object') {
        const r = m as Record<string, unknown>;
        meta.backfillDone = r.backfillDone === true;
        const q = r.leaderboard as Partial<LeaderboardViewQuery> | undefined;
        if (
          q &&
          LEADERBOARD_PERIODS.includes(q.period as LeaderboardPeriod) &&
          TOTALS_METRICS.includes(q.metric as TotalsMetric) &&
          typeof q.scope === 'string'
        ) {
          meta.leaderboard = {
            period: q.period as LeaderboardPeriod,
            metric: q.metric as TotalsMetric,
            scope: q.scope === 'friends' || state.challenges[q.scope] ? q.scope : 'friends',
          };
        }
      }
    } catch {
      // defaults
    }
    return { state, meta, fresh };
  }

  #scheduleSave(): void {
    this.#dirty = true;
    if (!this.#storage || this.#disposed) return;
    if (this.#saveDelayMs === 0) {
      this.#save();
      return;
    }
    if (this.#saveTimer !== null) return;
    this.#saveTimer = this.#timers.setTimeout(() => {
      this.#saveTimer = null;
      this.#save();
    }, this.#saveDelayMs);
  }

  /** The persisted form: period accumulators are derived and rebuilt by `migrate`. */
  #serialise(): string {
    const s = this.#state;
    return JSON.stringify({ ...s, ledger: { rides: s.ledger.rides, periods: {} } });
  }

  #save(): void {
    if (!this.#storage) return;
    const text = this.#serialise();
    const wasFailed = this.#saveFailed;
    try {
      this.#storage.setItem(COMMUNITY_STORAGE_KEY, text);
      this.#dirty = false;
      this.#saveFailed = false;
      if (wasFailed) this.#log.info('community data saved again');
    } catch (err) {
      this.#saveFailed = true;
      this.#log.warn('could not save community data', {
        bytes: utf8Length(text),
        error: errorText(err),
      });
      this.#onNotice(
        'error',
        'Could not save your community data (the app storage is full or blocked). ' +
          'It is kept until the app closes; deleting imported workouts frees space.',
      );
    }
    this.#bytes = utf8Length(text);
    if (wasFailed !== this.#saveFailed || this.#view.storage.bytes !== this.#bytes) {
      this.#refreshView();
    }
  }

  #saveMeta(): void {
    try {
      this.#storage?.setItem(COMMUNITY_META_KEY, JSON.stringify(this.#meta));
    } catch {
      // a preference and a marker: losing them is harmless
    }
  }

  // ---- internals: group sync ------------------------------------------------------------------

  #onPeersChange(): void {
    const group = this.#group;
    if (!group) return;
    const key = group
      .getPeers()
      .map((p) => p.peerId)
      .sort()
      .join(' ');
    if (key === this.#membershipKey) return;
    this.#sync();
    // A peer that left took its documents along; forget what we merged from it.
    for (const peerId of [...this.#peerSignatures.keys()]) {
      if (!this.#peerRiders.has(peerId)) this.#peerSignatures.delete(peerId);
    }
    this.#refreshView();
  }

  /**
   * Publishes exactly what `documentsToShare` allows for the riders present now. Synchronous:
   * nothing can be served in between. `alsoPresent`: peers that just joined (counted even if
   * the link does not list them yet). Fails closed: a document that cannot be shared is
   * withdrawn rather than left at an older (possibly richer) version.
   */
  #sync(alsoPresent: readonly string[] = [], reserveBytes = 0): void {
    const group = this.#group;
    if (!group || this.#syncing) return;
    this.#syncing = true;
    try {
      const ids = new Set([...group.getPeers().map((p) => p.peerId), ...alsoPresent]);
      for (const id of ids) if (!this.#peerRiders.has(id)) this.#peerRiders.set(id, null);
      for (const id of [...this.#peerRiders.keys()]) if (!ids.has(id)) this.#peerRiders.delete(id);
      this.#membershipKey = [...ids].sort().join(' ');

      let other = 0;
      for (const d of group.getLocalDocuments()) {
        if (!isCommunityKind(d.kind)) other += utf8Length(d.text);
      }
      const maxTotalBytes = Math.min(
        DEFAULT_TOTAL_BYTES,
        TRANSPORT_TOTAL_BYTES - other - reserveBytes,
      );
      const peers = [...this.#peerRiders.values()].map((riderId) => ({ riderId }));
      const result = documentsToShare(this.#state, peers, this.#now(), { maxTotalBytes });
      if (result.state !== this.#state) {
        this.#state = result.state;
        this.#scheduleSave();
      }
      const wanted = new Map(result.documents.map((d) => [d.kind, d.text]));
      // Withdraw first (narrows at once and frees budget), then share the rest.
      for (const kind of COMMUNITY_KINDS) if (!wanted.has(kind)) group.unshareDocument(kind);
      for (const [kind, text] of wanted) {
        const refused = group.shareDocument(kind, text);
        if (refused) {
          group.unshareDocument(kind);
          this.#log.warn(`could not publish ${kind}`, { reason: refused, bytes: utf8Length(text) });
        }
      }
      if (result.level !== this.#level) {
        this.#log.info(`community publishing level: ${result.level}`, {
          peers: ids.size,
          identified: [...this.#peerRiders.values()].filter((r) => r !== null).length,
          documents: wanted.size,
          relayed: result.relayed.length,
          challenges: result.challenges.length,
        });
        this.#level = result.level;
      }
    } finally {
      this.#syncing = false;
    }
  }

  #mergePeer(peerId: string): void {
    const group = this.#group;
    if (!group || !this.#peerRiders.has(peerId)) return; // only riders actually present
    const docs = group
      .getSharedDocuments()
      .filter((d) => d.peerId === peerId && isCommunityKind(d.kind));
    const signature = docs
      .map((d) => `${d.kind}:${d.id}`)
      .sort()
      .join(',');
    if (this.#peerSignatures.get(peerId) === signature) return;
    this.#peerSignatures.set(peerId, signature);
    if (docs.length === 0) return;
    const before = this.#state;
    const result = mergeIncoming(
      before,
      { peerId, peerName: docs[0]?.peerName },
      docs.map((d) => ({ kind: d.kind, text: d.text })),
      this.#now(),
    );
    const previousRider = this.#peerRiders.get(peerId) ?? null;
    if (result.riderId !== null) this.#peerRiders.set(peerId, result.riderId);
    this.#logChanges(result.changes);
    if (result.state !== before) {
      this.#state = result.state;
      this.#scheduleSave();
    }
    if (result.state !== before || result.riderId !== previousRider) {
      this.#sync();
      this.#refreshView();
    }
  }

  #logChanges(changes: readonly CommunityChange[]): void {
    if (changes.length === 0) return;
    const counts: Record<string, number> = {};
    for (const c of changes) counts[c.type] = (counts[c.type] ?? 0) + 1;
    const rejected = changes.filter((c) => c.type === 'rejected');
    this.#log[rejected.length > 0 ? 'warn' : 'info']('community documents merged', {
      ...counts,
      ...(rejected.length > 0
        ? { reasons: rejected.map((c) => (c.type === 'rejected' ? `${c.kind}:${c.reason}` : '')) }
        : {}),
    });
  }

  // ---- internals: view models -----------------------------------------------------------------

  #refreshView(): void {
    if (this.#disposed) return;
    const next = this.#computeView(this.#view);
    if (next === this.#view) return;
    this.#view = next;
    for (const l of [...this.#listeners]) {
      try {
        l(next);
      } catch (err) {
        this.#log.error('community view listener failed', { error: errorText(err) });
      }
    }
  }

  #period(key: string, now: Now): OwnPeriodView {
    const b = periodBounds(key, now.utcOffsetMin) ?? { startMs: 0, endMs: 0 };
    return {
      key,
      startsAt: b.startMs,
      endsAt: b.endMs,
      totals: ledgerTotals(this.#state.ledger, key),
    };
  }

  #leaderboard(query: LeaderboardViewQuery, now: Now): LeaderboardView {
    const week = weekKey(now.ms, now.utcOffsetMin);
    const month = monthKey(now.ms, now.utcOffsetMin);
    const periodKey =
      query.period === 'thisWeek'
        ? week
        : query.period === 'lastWeek'
          ? addWeeks(week, -1)
          : query.period === 'thisMonth'
            ? month
            : addMonths(month, -1);
    const scope =
      query.scope === 'friends' || this.#state.challenges[query.scope] ? query.scope : 'friends';
    return {
      period: query.period,
      metric: query.metric,
      scope,
      periodKey,
      rows: leaderboardCore(this.#state, { period: periodKey, metric: query.metric, scope }, now),
    };
  }

  #challenges(now: Now): ChallengeView[] {
    const s = this.#state;
    const me = s.profile.riderId;
    const standings = allStandings(s, now);
    const order: Record<ChallengeProgress['status'], number> = {
      running: 0,
      upcoming: 1,
      finished: 2,
      cancelled: 3,
    };
    return Object.values(s.challenges)
      .map((ch): ChallengeView => {
        const progress = challengeProgress(ch, standings, now);
        const creator = ch.participants.find((p) => p.riderId === ch.creator);
        return {
          id: ch.id,
          title: ch.title,
          type: ch.type,
          metric: ch.metric,
          target: ch.target,
          week: ch.week,
          status: ch.status,
          creatorId: ch.creator,
          creatorName:
            ch.creator === me ? s.profile.name : (creator?.name ?? displayName(s, ch.creator)),
          isCreator: ch.creator === me,
          myState: ch.participants.find((p) => p.riderId === me)?.state ?? null,
          canInvite:
            ch.creator === me &&
            ch.status === 'active' &&
            progress.status !== 'finished' &&
            ch.participants.length < TEMPLATES[ch.type].maxParticipants,
          current: challengeIsCurrent(ch, now),
          progress,
        };
      })
      .sort(
        (a, b) =>
          order[a.progress.status] - order[b.progress.status] ||
          (s.challenges[b.id]?.updatedAt ?? 0) - (s.challenges[a.id]?.updatedAt ?? 0) ||
          (a.id < b.id ? -1 : 1),
      );
  }

  #contacts(now: Now): { contacts: ContactView[]; blocked: BlockedContactView[] } {
    const s = this.#state;
    const present = new Set(this.#peerRiders.values());
    const contacts: ContactView[] = [];
    const blocked: BlockedContactView[] = [];
    for (const c of Object.values(s.contacts)) {
      if (c.blocked) {
        blocked.push({ riderId: c.riderId, name: c.name, since: c.lastSeen });
        continue;
      }
      const cached = s.standings[c.riderId];
      contacts.push({
        riderId: c.riderId,
        name: c.name,
        alias: c.alias,
        displayName: c.alias ?? c.name,
        visibility: c.visibility,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        present: present.has(c.riderId),
        standing: cached
          ? {
              updatedAt: cached.standing.updatedAt,
              ageHours: Math.max(0, Math.floor((now.ms - cached.standing.updatedAt) / HOUR_MS)),
              stale: now.ms - cached.standing.updatedAt > STALE_AFTER_MS,
              viaRiderId: cached.via,
              viaName: cached.via ? displayName(s, cached.via) : null,
            }
          : null,
      });
    }
    contacts.sort(
      (a, b) =>
        Number(b.present) - Number(a.present) ||
        b.lastSeen - a.lastSeen ||
        (a.riderId < b.riderId ? -1 : 1),
    );
    blocked.sort((a, b) => b.since - a.since || (a.riderId < b.riderId ? -1 : 1));
    return { contacts, blocked };
  }

  #computeView(prev: CommunityView | undefined): CommunityView {
    const now = this.#viewNow();
    const s = this.#state;
    const challenges = keep(prev?.challenges, this.#challenges(now));
    const invitationsNext = challenges.filter(
      (c) => c.myState === 'invited' && c.status === 'active' && c.progress.status !== 'finished',
    );
    const { contacts, blocked } = this.#contacts(now);
    const identified = [...this.#peerRiders.values()].filter((r) => r !== null).length;
    const next: CommunityView = {
      profile: keep(prev?.profile, {
        riderId: s.profile.riderId,
        name: s.profile.name,
        defaultVisibility: s.profile.defaultVisibility,
        friendsOfFriends: s.profile.friendsOfFriends,
      }),
      week: keep(prev?.week, this.#period(weekKey(now.ms, now.utcOffsetMin), now)),
      month: keep(prev?.month, this.#period(monthKey(now.ms, now.utcOffsetMin), now)),
      leaderboard: keep(prev?.leaderboard, this.#leaderboard(this.#meta.leaderboard, now)),
      challenges,
      invitations: keep(prev?.invitations, invitationsNext),
      contacts: keep(prev?.contacts, contacts),
      blocked: keep(prev?.blocked, blocked),
      session: keep(prev?.session, {
        active: this.#group !== null,
        peers: this.#peerRiders.size,
        identified,
        level: this.#level,
      }),
      backfill: keep(prev?.backfill, { ...this.#backfill }),
      storage: keep(prev?.storage, { bytes: this.#bytes, saveFailed: this.#saveFailed }),
    };
    if (prev && (Object.keys(next) as (keyof CommunityView)[]).every((k) => next[k] === prev[k])) {
      return prev;
    }
    return next;
  }
}
