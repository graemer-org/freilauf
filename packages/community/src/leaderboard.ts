/**
 * Leaderboards over the friends' (or a challenge's participants') standings. Riders who share
 * nothing with us have no standing and are absent — never shown as zero.
 */

import { type Now, type PeriodKey, isPeriodKey } from './periods';
import { type PublicStanding, displayName, standingPeriod } from './profile';
import type { CommunityState } from './state';
import { TOTALS_METRICS, type TotalsMetric, ledgerTotals } from './totals';

/** A friend's standing older than this is marked stale (unless the period was already over). */
export const STALE_AFTER_MS = 36 * 3_600_000;

export interface LeaderboardQuery {
  period: PeriodKey;
  metric: TotalsMetric;
  /** 'friends', or a challenge id: that challenge's accepted participants. */
  scope: 'friends' | (string & {});
}

export interface LeaderboardRow {
  /** Competition ranking: equal values share a rank (1, 1, 3). */
  rank: number;
  riderId: string;
  name: string;
  value: number;
  /** value − my value; null when I am not on this board. */
  deltaToYou: number | null;
  /** The rider's data is old and the period may have moved on since. */
  stale: boolean;
  you: boolean;
  relation: 'you' | 'friend' | 'friend-of-friend';
}

export function leaderboard(
  state: CommunityState,
  query: LeaderboardQuery,
  now: Now,
): LeaderboardRow[] {
  if (!isPeriodKey(query.period) || !TOTALS_METRICS.includes(query.metric)) return [];
  const me = state.profile.riderId;

  let riders: string[];
  if (query.scope === 'friends') {
    riders = [
      me,
      ...Object.keys(state.standings).filter((id) => {
        const c = state.contacts[id];
        return c !== undefined && !c.blocked;
      }),
    ];
  } else {
    const ch = state.challenges[query.scope];
    if (!ch) return [];
    riders = ch.participants
      .filter((p) => p.state === 'accepted' && !state.contacts[p.riderId]?.blocked)
      .map((p) => p.riderId);
  }

  const rows: Omit<LeaderboardRow, 'rank' | 'deltaToYou'>[] = [];
  for (const id of new Set(riders)) {
    const you = id === me;
    const contact = state.contacts[id];
    if (you) {
      // My own totals are always known, for any period, straight from the ledger.
      const t = ledgerTotals(state.ledger, query.period);
      rows.push({
        riderId: id,
        name: displayName(state, id),
        value: t[query.metric],
        stale: false,
        you,
        relation: 'you',
      });
      continue;
    }
    const standing: PublicStanding | undefined = state.standings[id]?.standing;
    if (!standing) continue;
    const sp = standingPeriod(standing, query.period);
    if (!sp) continue;
    rows.push({
      riderId: id,
      name: displayName(state, id),
      value: sp.totals[query.metric],
      stale: !sp.complete && now.ms - standing.updatedAt > STALE_AFTER_MS,
      you,
      relation: you ? 'you' : contact && !contact.blocked ? 'friend' : 'friend-of-friend',
    });
  }

  rows.sort(
    (a, b) =>
      b.value - a.value ||
      a.name.localeCompare(b.name) ||
      (a.riderId < b.riderId ? -1 : a.riderId > b.riderId ? 1 : 0),
  );
  const mine = rows.find((r) => r.you)?.value;
  let rank = 0;
  return rows.map((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.value !== r.value) rank = i + 1;
    return { ...r, rank, deltaToYou: mine === undefined ? null : r.value - mine };
  });
}
