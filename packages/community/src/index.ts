// @freilauf/community — pure core of leaderboards, points, challenges and friend sync.
// No DOM/Node APIs, no timers: time, time-zone offset and randomness are always passed in.
// See docs/community.md.

export {
  BEST_EFFORT_KEYS,
  BEST_EFFORT_WINDOWS,
  POINTS_IF_CAP,
  POINTS_PER_DAY_CAP,
  POINTS_PER_RIDE_CAP,
  SCORING_VERSION,
  bestAverage,
  normalizedPower,
  pointsFor,
  rideFacts,
  validateRideFacts,
} from './scoring';
export type {
  BestEfforts,
  RideFacts,
  RideFactsInput,
  RideFactsSample,
  RideSource,
} from './scoring';

export {
  addMonths,
  addWeeks,
  dayKey,
  isDayKey,
  isMonthKey,
  isPeriodKey,
  isWeekKey,
  isoWeeksInYear,
  monthKey,
  monthKeyOfDay,
  normalizeOffset,
  periodBounds,
  periodKind,
  recentMonths,
  recentWeeks,
  weekDays,
  weekKey,
  weekKeyOfDay,
  weeksBetween,
} from './periods';
export type { DayKey, MonthKey, Now, PeriodKey, PeriodKind, WeekKey } from './periods';

export {
  TOTALS_METRICS,
  aggregate,
  averageSpeedMps,
  bestEfforts,
  emptyLedger,
  emptyTotals,
  ledgerAdd,
  ledgerFromFacts,
  ledgerRemove,
  ledgerTotals,
} from './totals';
export type { Ledger, PeriodAccumulator, PeriodTotals, Totals, TotalsMetric } from './totals';

export {
  FUTURE_TOLERANCE_MS,
  HISTORY_WEEKS,
  MAX_BLOCKED,
  MAX_CONTACTS,
  MAX_RELAY_LIST,
  STANDING_MONTHS,
  STANDING_WEEKS,
  VISIBILITIES,
  buildOwnStanding,
  createProfile,
  decodeStanding,
  displayName,
  encodeStanding,
  meetContact,
  newRiderId,
  relayAllowedTo,
  relayPolicy,
  removeContact,
  renameContact,
  setContactVisibility,
  setDefaultVisibility,
  setDisplayName,
  setFriendsOfFriends,
  standingFor,
  standingPeriod,
  unblockContact,
  visibilityFor,
} from './profile';
export type {
  CachedStanding,
  Contact,
  PeriodStanding,
  Profile,
  PublicStanding,
  StandingLevel,
  StandingRelayPolicy,
  Visibility,
} from './profile';

export {
  CHALLENGE_TYPES,
  MAX_CHALLENGES,
  MAX_PARTICIPANTS,
  TEMPLATES,
  cancelChallenge,
  challengeIsCurrent,
  challengeProgress,
  createChallenge,
  decodeChallenge,
  encodeChallenge,
  inviteToChallenge,
  leaveChallenge,
  mergeChallenge,
  newChallengeId,
  putChallenge,
  respondToChallenge,
  streakWeeks,
} from './challenges';
export type {
  Challenge,
  ChallengeInput,
  ChallengeMetric,
  ChallengeParticipant,
  ChallengeProgress,
  ChallengeResult,
  ChallengeType,
  DuelResult,
  GoalMetric,
  InvitationState,
  ParticipantProgress,
  StandingsByRider,
} from './challenges';

export { STALE_AFTER_MS, leaderboard } from './leaderboard';
export type { LeaderboardQuery, LeaderboardRow } from './leaderboard';

export {
  COMMUNITY_KINDS,
  DEFAULT_TOTAL_BYTES,
  KIND_CHALLENGES,
  KIND_RELAY,
  KIND_STANDING,
  MAX_CHALLENGES_PER_DOCUMENT,
  MAX_DOCUMENT_BYTES,
  MAX_RELAY_ENTRIES,
  STANDING_REFRESH_MS,
  documentsToShare,
  isCommunityKind,
  mergeIncoming,
  sessionLevel,
} from './sync';
export type {
  CommunityChange,
  IncomingDocument,
  MergeResult,
  OutgoingDocument,
  PeerInfo,
  SessionLevel,
  SessionPeer,
  ShareOptions,
  ShareResult,
} from './sync';

export {
  MAX_CACHED_STANDINGS,
  MAX_OWN_RIDES,
  SCHEMA_VERSION,
  addRide,
  allStandings,
  emptyState,
  estimateStateBytes,
  migrate,
  ownStanding,
  removeRide,
} from './state';
export type { CommunityState, PublishedRevision } from './state';

export { seededRandom, utf8Length } from './util';
