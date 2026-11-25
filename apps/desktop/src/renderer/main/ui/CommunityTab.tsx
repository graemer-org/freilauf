import type { KeyboardEvent } from 'react';
import { useMemo, useRef } from 'react';
import type { TotalsMetric } from '@freilauf/community';
import { kcalFromWorkKj } from '@freilauf/session';
import type { ContactView, LeaderboardPeriod } from '../../core/communityService';
import { LEADERBOARD_PERIODS } from '../../core/communityService';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { ChallengesSection } from './CommunityChallenges';
import { FriendsSection } from './CommunityFriends';
import {
  LEADERBOARD_METRICS,
  METRIC_LABEL,
  PERIOD_LABEL,
  formatAgeHours,
  formatDelta,
  formatWeekRange,
  metricParts,
  monthName,
  tiedRanks,
  weekNumber,
} from './communityView';
import { useApp, useAppState } from './hooks';

// ───────────── segmented control ─────────────

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  testId: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const j = (i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
    const next = options[j];
    if (next) {
      onChange(next.value);
      refs.current[j]?.focus();
    }
  };
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="segment"
          data-testid={`${testId}-${o.value}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────── your week ─────────────

/** Mechanical work → `≈ 1,234 kcal` (kJ ÷ (4.184 × 0.24), docs/energy.md). */
function weekKcal(energyKj: number): string {
  return `≈ ${KCAL_FORMAT.format(Math.round(kcalFromWorkKj(energyKj)))} kcal`;
}
const KCAL_FORMAT = new Intl.NumberFormat('en-GB');

function Fact({
  label,
  metric,
  value,
  testId,
  note,
}: {
  label: string;
  metric: TotalsMetric;
  value: number;
  testId?: string;
  /** A quiet second line, e.g. the energy in kcal. */
  note?: { text: string; testId: string };
}) {
  const p = metricParts(metric, value);
  return (
    <div className="cm-fact">
      <dt>{label}</dt>
      <dd data-testid={testId}>
        <span className="cm-fact-number">{p.number}</span>
        {metric !== 'rides' && <span className="cm-fact-unit">{p.unit}</span>}
      </dd>
      {note && (
        <dd className="hint cm-fact-note" data-testid={note.testId}>
          {note.text}
        </dd>
      )}
    </div>
  );
}

function YourWeek({ onOpenFtpTests }: { onOpenFtpTests: (() => void) | undefined }) {
  const week = useAppState((s) => s.community.week);
  const month = useAppState((s) => s.community.month);
  const ftpW = useAppState((s) => s.settings?.rider.ftpW ?? null);
  const t = week.totals;
  const m = month.totals;
  const defaultFtp = ftpW === DEFAULT_SETTINGS.rider.ftpW;
  const noPoints = t.rides > 0 && t.points === 0;
  const points = metricParts('points', t.points);
  return (
    <section className="card cm-week" aria-labelledby="cm-week-title" data-testid="community-week">
      <div className="cm-week-head">
        <h2 id="cm-week-title" className="section-title">
          Your week
        </h2>
        <span className="hint">
          {weekNumber(week.key)} · {formatWeekRange(week.startsAt, week.endsAt)}
        </span>
      </div>
      <div className="cm-week-body">
        <p className="cm-points">
          <span className="cm-points-number" data-testid="community-week-points">
            {points.number}
          </span>
          <span className="cm-points-unit">{points.unit}</span>
        </p>
        <dl className="cm-facts">
          <Fact label="Distance" metric="distanceM" value={t.distanceM} />
          <Fact label="Time" metric="movingS" value={t.movingS} />
          <Fact label="Elevation" metric="elevationGainM" value={t.elevationGainM} />
          <Fact
            label="Energy"
            metric="energyKj"
            value={t.energyKj}
            note={{ text: weekKcal(t.energyKj), testId: 'community-week-kcal' }}
          />
          <Fact label="Rides" metric="rides" value={t.rides} testId="community-week-rides" />
        </dl>
      </div>
      <p className="cm-month hint" data-testid="community-month">
        {monthName(month.startsAt)} so far: {metricParts('points', m.points).number} points ·{' '}
        {metricParts('distanceM', m.distanceM).number} km · {m.rides}{' '}
        {m.rides === 1 ? 'ride' : 'rides'}
        {m.energyKj > 0 && (
          <span data-testid="community-month-kcal"> · {weekKcal(m.energyKj)}</span>
        )}
      </p>
      <div className="cm-explain">
        <p>
          Points measure training load: how long you rode and how hard, relative to your own FTP —
          so riders of every level score alike for the same effort.
        </p>
        <details className="disclosure cm-how">
          <summary>How points work</summary>
          <ul className="cm-how-list">
            <li>
              An hour at your FTP is <strong>100 points</strong>. An easy hour (60 % of FTP) is
              about 36, a hard one (90 %) about 81.
            </li>
            <li>
              Points grow with time and with the square of intensity. Intensity counts up to 130 %
              of FTP, so a too-low FTP cannot inflate them.
            </li>
            <li>At most 400 points per ride and 500 per day.</li>
            <li>
              Each ride is scored once, with the FTP you had when you rode it. Changing your FTP
              later does not change past points.
            </li>
          </ul>
        </details>
      </div>
      {(defaultFtp || noPoints) && (
        <p className="cm-nudge" data-testid="community-ftp-nudge">
          {noPoints
            ? 'Your rides this week scored no points yet. Very short or very easy rides round to 0, and points need a realistic FTP.'
            : `Your FTP is still the default ${DEFAULT_SETTINGS.rider.ftpW} W. Points are only fair once it is your own.`}
          {onOpenFtpTests && (
            <>
              {' '}
              <button type="button" className="link" onClick={onOpenFtpTests}>
                Take an FTP test
              </button>
            </>
          )}
        </p>
      )}
    </section>
  );
}

// ───────────── leaderboard ─────────────

const PERIOD_OPTIONS = LEADERBOARD_PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p] }));
const METRIC_OPTIONS = LEADERBOARD_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }));

function BoardEmpty({ onOpenGroup }: { onOpenGroup: (() => void) | undefined }) {
  return (
    <div className="empty cm-board-empty" data-testid="leaderboard-empty">
      <svg className="empty-icon" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="17" cy="17" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="33" cy="19" r="5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path
          d="M6 39c1.5-7 6-10.5 11-10.5S26.5 32 28 39M29 30.5c1.2-.6 2.6-1 4-1 4 0 7.6 3 9 9.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <p className="empty-title">Ride with friends once and they appear here</p>
      <p className="empty-text">
        Everyone you share a group ride with becomes a friend. Your standings are exchanged whenever
        you are in a session together — there is no server that keeps them.
      </p>
      {onOpenGroup && (
        <button type="button" className="btn btn-quiet" onClick={onOpenGroup}>
          Ride together in Group
        </button>
      )}
    </div>
  );
}

function Leaderboard({ onOpenGroup }: { onOpenGroup: (() => void) | undefined }) {
  const app = useApp();
  const board = useAppState((s) => s.community.leaderboard);
  const contacts = useAppState((s) => s.community.contacts);
  const byId = useMemo(
    () => new Map<string, ContactView>(contacts.map((c) => [c.riderId, c])),
    [contacts],
  );
  const ties = useMemo(() => tiedRanks(board.rows), [board.rows]);
  const others = board.rows.filter((r) => !r.you).length;
  const metric = board.metric;
  return (
    <section aria-labelledby="cm-board-title" data-testid="community-leaderboard">
      <div className="section-head">
        <h2 id="cm-board-title" className="section-title">
          Leaderboard
        </h2>
        <span className="hint">Friends who share their totals with you</span>
      </div>
      <div className="card cm-board">
        <div className="cm-board-controls">
          <Segmented<LeaderboardPeriod>
            label="Period"
            testId="board-period"
            options={PERIOD_OPTIONS}
            value={board.period}
            onChange={(period) => app.setLeaderboardView({ period })}
          />
          <Segmented<TotalsMetric>
            label="Compare by"
            testId="board-metric"
            options={METRIC_OPTIONS}
            value={metric}
            onChange={(m) => app.setLeaderboardView({ metric: m })}
          />
        </div>
        {contacts.length === 0 && others === 0 ? (
          <BoardEmpty onOpenGroup={onOpenGroup} />
        ) : (
          <>
            <ol
              className="list cm-rows"
              aria-label={`${PERIOD_LABEL[board.period]}, by ${METRIC_LABEL[metric].toLowerCase()}`}
            >
              {board.rows.map((r) => {
                const c = byId.get(r.riderId);
                const via = c?.standing?.viaName ?? null;
                const value = metricParts(metric, r.value);
                const tied = ties.has(r.rank);
                return (
                  <li
                    key={r.riderId}
                    className={`cm-row${r.you ? ' is-you' : ''}${r.stale ? ' is-stale' : ''}`}
                    data-testid="board-row"
                    data-rank={r.rank}
                    data-you={r.you || undefined}
                    data-stale={r.stale || undefined}
                  >
                    <span className="cm-rank" title={tied ? 'Tied' : undefined}>
                      {r.rank}
                      {tied && <span className="visually-hidden"> (tied)</span>}
                    </span>
                    <span className="cm-who">
                      <span className="cm-name">{r.you ? 'You' : r.name}</span>
                      {r.stale && (
                        <span className="cm-note">
                          updated{' '}
                          {c?.standing ? formatAgeHours(c.standing.ageHours) : 'a while ago'}
                        </span>
                      )}
                      {via && !r.you && <span className="cm-note">via {via}</span>}
                    </span>
                    <span className="cm-value">
                      <span className="cm-value-number">{value.number}</span>
                      <span className="cm-value-unit">{value.unit}</span>
                    </span>
                    <span className="cm-delta">
                      {r.you ? '' : r.deltaToYou === null ? '–' : formatDelta(metric, r.deltaToYou)}
                    </span>
                  </li>
                );
              })}
            </ol>
            {others === 0 && (
              <p className="hint cm-board-note">
                None of your friends has shared values for this period with you yet.
              </p>
            )}
          </>
        )}
      </div>
      <p className="hint section-foot" data-testid="leaderboard-footnote">
        Friends who share nothing with you are not listed. Standings travel only when you ride in a
        session together, or with a friend you both share; older ones are dimmed.
      </p>
    </section>
  );
}

// ───────────── status lines ─────────────

function StatusLines() {
  const backfill = useAppState((s) => s.community.backfill);
  const saveFailed = useAppState((s) => s.community.storage.saveFailed);
  return (
    <>
      {backfill.status === 'running' && backfill.total > 0 && (
        <p className="hint cm-status" role="status" data-testid="community-backfill">
          <span className="spinner" aria-hidden="true" /> Adding {backfill.total} earlier{' '}
          {backfill.total === 1 ? 'ride' : 'rides'}… {backfill.processed} of {backfill.total} done
        </p>
      )}
      {saveFailed && (
        <p className="callout-warn" role="alert" data-testid="community-save-failed">
          Community data could not be saved (storage full or blocked). It is kept while the app
          stays open.
        </p>
      )}
    </>
  );
}

// ───────────── tab ─────────────

export interface CommunityTabProps {
  onOpenGroup?: () => void;
  onOpenFtpTests?: () => void;
}

export function CommunityTab({ onOpenGroup, onOpenFtpTests }: CommunityTabProps) {
  return (
    <div className="page community">
      <StatusLines />
      <YourWeek onOpenFtpTests={onOpenFtpTests} />
      <Leaderboard onOpenGroup={onOpenGroup} />
      <ChallengesSection />
      <FriendsSection />
    </div>
  );
}
