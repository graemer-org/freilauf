import { useId, useMemo, useState } from 'react';
import type { ChallengeMetric, ChallengeType, ParticipantProgress } from '@freilauf/community';
import type {
  ChallengeTemplateInfo,
  ChallengeView,
  CommunityActionResult,
  ContactView,
} from '../../core/communityService';
import { CHALLENGE_TEMPLATES } from '../../core/communityService';
import type { ChallengeDraft } from './communityView';
import {
  CHALLENGE_TYPE_LABEL,
  CHALLENGE_TYPE_TEXT,
  MAX_TITLE_LENGTH,
  METRIC_LABEL,
  barFraction,
  challengeGroup,
  challengeSummary,
  draftFor,
  formatDay,
  formatMetric,
  formatRemaining,
  formatWeekRange,
  metricParts,
  targetSpec,
  validateDraft,
  weekNumber,
  weekOptions,
} from './communityView';
import { useApp, useAppState } from './hooks';

const STATE_TAG: Record<ParticipantProgress['state'], string | null> = {
  accepted: null,
  invited: 'invited',
  declined: 'declined',
  left: 'left',
};

// ───────────── shared bits ─────────────

function useMe(): string {
  return useAppState((s) => s.community.profile.riderId);
}

/** Accepted participants, me first. */
function riders(c: ChallengeView, me: string): ParticipantProgress[] {
  const accepted = c.progress.participants.filter((p) => p.state === 'accepted');
  return [...accepted.filter((p) => p.riderId === me), ...accepted.filter((p) => p.riderId !== me)];
}

function nameOf(p: { riderId: string; name: string }, me: string): string {
  return p.riderId === me ? 'You' : p.name;
}

function Bar({ fraction, you, label }: { fraction: number | null; you: boolean; label: string }) {
  const f = barFraction(fraction);
  return (
    <span
      className={`cm-bar${you ? ' is-you' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(f * 100)}
    >
      <span className="cm-bar-fill" style={{ width: `${f * 100}%` }} />
    </span>
  );
}

function Dots({
  count,
  filled,
  goal,
  label,
}: {
  count: number;
  filled: number;
  /** Dots up to here are part of the goal (drawn with a stronger ring). */
  goal?: number;
  label: string;
}) {
  return (
    <span className="cm-dots" role="img" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={`cm-dot${i < filled ? ' is-on' : ''}${goal !== undefined && i < goal ? ' is-goal' : ''}`}
        />
      ))}
    </span>
  );
}

function Unknown() {
  return <span className="cm-unknown">not shared</span>;
}

// ───────────── progress per type ─────────────

function GoalRows({ c, me }: { c: ChallengeView; me: string }) {
  return (
    <ul className="cm-prog-rows">
      {riders(c, me).map((p) => (
        <li key={p.riderId} className="cm-prog-row">
          <span className="cm-prog-name">{nameOf(p, me)}</span>
          <Bar
            fraction={p.fraction}
            you={p.riderId === me}
            label={`${nameOf(p, me)}: progress towards the goal`}
          />
          <span className="cm-prog-value">
            {p.value === null ? (
              <Unknown />
            ) : (
              <>
                {metricParts(c.metric, p.value).number}
                <span className="cm-of"> / {formatMetric(c.metric, c.target)}</span>
                {p.complete && <span className="tag tag-accent">done</span>}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function GroupGoal({ c, me }: { c: ChallengeView; me: string }) {
  const combined = c.progress.combined;
  const list = riders(c, me);
  const target = combined?.target ?? c.target;
  return (
    <div className="cm-group">
      <p className="cm-prog-headline">
        <strong>{formatMetric(c.metric, combined?.value ?? 0)}</strong>
        <span className="cm-of"> of {formatMetric(c.metric, target)}</span>
        <span className="cm-pct">{Math.round(barFraction(combined?.fraction) * 100)} %</span>
        {combined?.complete && <span className="tag tag-accent">reached</span>}
      </p>
      <span
        className="cm-stack"
        role="meter"
        aria-label="Shared progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barFraction(combined?.fraction) * 100)}
      >
        {list.map((p, i) =>
          p.value ? (
            <span
              key={p.riderId}
              className={`cm-seg cm-seg-${p.riderId === me ? 'you' : i % 2 ? 'b' : 'a'}`}
              style={{ width: `${Math.min(100, (p.value / Math.max(1, target)) * 100)}%` }}
              title={`${nameOf(p, me)}: ${formatMetric(c.metric, p.value)}`}
            />
          ) : null,
        )}
      </span>
      <ul className="cm-legend">
        {list.map((p, i) => (
          <li key={p.riderId}>
            <span
              className={`cm-swatch cm-seg-${p.riderId === me ? 'you' : i % 2 ? 'b' : 'a'}`}
              aria-hidden="true"
            />
            {nameOf(p, me)}{' '}
            <span className="cm-legend-value">
              {p.value === null ? 'not shared' : formatMetric(c.metric, p.value)}
            </span>
          </li>
        ))}
      </ul>
      {combined?.partial && (
        <p className="hint">Riders who share nothing with you are missing from the sum.</p>
      )}
    </div>
  );
}

function Duel({ c, me }: { c: ChallengeView; me: string }) {
  const [a, b] = riders(c, me);
  const pending = c.progress.participants.find((p) => p.state === 'invited');
  if (!a || !b) {
    return (
      <p className="hint cm-prog-headline">
        {pending
          ? `Waiting for ${pending.name} to accept.`
          : 'Invite one friend to start the duel.'}
      </p>
    );
  }
  const max = Math.max(1, a.value ?? 0, b.value ?? 0);
  const result = c.progress.result;
  const leader = c.progress.leader;
  const gap = Math.abs((a.value ?? 0) - (b.value ?? 0));
  let line: string;
  if (result) {
    const who = result.outcome === 'winner' ? (result.riderId === a.riderId ? a : b) : null;
    line = who
      ? `${who.riderId === me ? 'You won' : `${who.name} won`} by ${formatMetric('points', gap)}`
      : 'A draw';
    if (result.provisional) line += ' — provisional until both have shared their final totals';
  } else if (a.value === null || b.value === null) {
    line = 'Waiting for both standings.';
  } else if (leader) {
    const l = leader === a.riderId ? a : b;
    line = `${l.riderId === me ? 'You lead' : `${l.name} leads`} by ${formatMetric('points', gap)}`;
  } else {
    line = 'Level';
  }
  const side = (p: ParticipantProgress, dir: 'left' | 'right') => (
    <div className={`cm-duel-side is-${dir}${leader === p.riderId ? ' is-leader' : ''}`}>
      <span className="cm-duel-name">{nameOf(p, me)}</span>
      <span className="cm-duel-value">
        {p.value === null ? '–' : metricParts('points', p.value).number}
      </span>
      <Bar
        fraction={p.value === null ? 0 : p.value / max}
        you={p.riderId === me}
        label={`${nameOf(p, me)}: ${p.value === null ? 'unknown' : formatMetric('points', p.value)}`}
      />
    </div>
  );
  return (
    <div className="cm-duel">
      <div className="cm-duel-bars">
        {side(a, 'left')}
        {side(b, 'right')}
      </div>
      <p className="cm-prog-headline" data-testid="duel-line">
        {line}
      </p>
    </div>
  );
}

function Streak({ c, me }: { c: ChallengeView; me: string }) {
  return (
    <ul className="cm-prog-rows">
      {riders(c, me).map((p) => {
        const weeks = p.value ?? 0;
        return (
          <li key={p.riderId} className="cm-prog-row">
            <span className="cm-prog-name">{nameOf(p, me)}</span>
            {p.value === null ? (
              <Unknown />
            ) : (
              <Dots
                count={Math.max(4, Math.min(12, weeks + 1))}
                filled={Math.min(12, weeks)}
                label={`${weeks} ${weeks === 1 ? 'week' : 'weeks'} in a row`}
              />
            )}
            <span className="cm-prog-value">
              {p.value === null
                ? ''
                : `${weeks}${p.capped ? '+' : ''} ${weeks === 1 ? 'week' : 'weeks'}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CountDots({
  c,
  me,
  count,
  unit,
}: {
  c: ChallengeView;
  me: string;
  count: number;
  unit: 'rideDays' | 'groupRides';
}) {
  return (
    <ul className="cm-prog-rows">
      {riders(c, me).map((p) => (
        <li key={p.riderId} className="cm-prog-row">
          <span className="cm-prog-name">{nameOf(p, me)}</span>
          {p.value === null ? (
            <Unknown />
          ) : (
            <Dots
              count={count}
              filled={Math.min(count, p.value)}
              goal={c.target}
              label={`${p.value} of ${formatMetric(unit, c.target)}`}
            />
          )}
          <span className="cm-prog-value">
            {p.value === null ? (
              ''
            ) : (
              <>
                {p.value}
                <span className="cm-of"> / {formatMetric(unit, c.target)}</span>
                {p.complete && <span className="tag tag-accent">done</span>}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BeatBest({ c, me }: { c: ChallengeView; me: string }) {
  return (
    <ul className="cm-prog-rows cm-best">
      {riders(c, me).map((p) => {
        if (p.value === null || p.target === null) {
          return (
            <li key={p.riderId} className="cm-prog-row">
              <span className="cm-prog-name">{nameOf(p, me)}</span>
              <span className="cm-unknown">needs “Everything” shared with you</span>
            </li>
          );
        }
        const max = Math.max(1, p.value, p.target);
        return (
          <li key={p.riderId} className="cm-prog-row cm-best-row">
            <span className="cm-prog-name">{nameOf(p, me)}</span>
            <span className="cm-best-bars">
              <span className="cm-best-line">
                <span className="cm-best-label">Before</span>
                <Bar fraction={p.target / max} you={false} label="Best of the four weeks before" />
                <span className="cm-best-w">
                  {p.target > 0 ? formatMetric(c.metric, p.target) : '–'}
                </span>
              </span>
              <span className="cm-best-line">
                <span className="cm-best-label">This week</span>
                <Bar fraction={p.value / max} you={p.riderId === me} label="Best this week" />
                <span className="cm-best-w">{formatMetric(c.metric, p.value)}</span>
              </span>
            </span>
            <span className="cm-prog-value">
              {p.complete && <span className="tag tag-accent">beaten</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Progress({ c, me }: { c: ChallengeView; me: string }) {
  // The header already says when it starts; there is nothing to show yet.
  if (c.progress.status === 'upcoming') return null;
  switch (c.type) {
    case 'personal-goal':
      return <GoalRows c={c} me={me} />;
    case 'group-goal':
      return <GroupGoal c={c} me={me} />;
    case 'duel':
      return <Duel c={c} me={me} />;
    case 'streak':
      return <Streak c={c} me={me} />;
    case 'consistency':
      return <CountDots c={c} me={me} count={7} unit="rideDays" />;
    case 'ride-together':
      return <CountDots c={c} me={me} count={Math.max(c.target, 3)} unit="groupRides" />;
    case 'beat-your-best':
      return <BeatBest c={c} me={me} />;
  }
}

// ───────────── card ─────────────

function whenText(c: ChallengeView): string {
  if (c.status === 'cancelled' || c.progress.status === 'cancelled') return 'Cancelled';
  if (c.progress.status === 'finished') return 'Finished';
  if (c.progress.status === 'upcoming') return `Starts ${formatDay(c.progress.startsAt)}`;
  if (c.progress.remainingMs === null) return 'Open-ended';
  return formatRemaining(c.progress.remainingMs);
}

function periodText(c: ChallengeView): string {
  if (c.type === 'streak') return `from ${weekNumber(c.week)}`;
  const end = c.progress.endsAt;
  return end === null
    ? weekNumber(c.week)
    : `${weekNumber(c.week)} · ${formatWeekRange(c.progress.startsAt, end)}`;
}

function Participants({ c, me }: { c: ChallengeView; me: string }) {
  return (
    <p className="cm-people">
      <span className="visually-hidden">Riders: </span>
      {c.progress.participants.map((p, i) => {
        const tag = STATE_TAG[p.state];
        return (
          <span key={p.riderId} className={`cm-person${tag ? ' is-' + tag : ''}`}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            {nameOf(p, me)}
            {tag && <span className="cm-person-state"> ({tag})</span>}
          </span>
        );
      })}
    </p>
  );
}

function InviteControl({ c, contacts }: { c: ChallengeView; contacts: readonly ContactView[] }) {
  const app = useApp();
  const id = useId();
  const listed = new Set(c.progress.participants.map((p) => p.riderId));
  const options = contacts.filter((ct) => !listed.has(ct.riderId));
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (options.length === 0) return null;
  const chosen = options.some((o) => o.riderId === pick) ? pick : (options[0]?.riderId ?? '');
  return (
    <span className="cm-invite">
      <label className="visually-hidden" htmlFor={id}>
        Friend to invite
      </label>
      <select id={id} value={chosen} onChange={(e) => setPick(e.currentTarget.value)}>
        {options.map((o) => (
          <option key={o.riderId} value={o.riderId}>
            {o.displayName}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-small"
        data-testid="challenge-invite"
        onClick={() => {
          const r = app.inviteToChallenge(c.id, chosen);
          setError(r.ok ? null : r.error);
        }}
      >
        Invite
      </button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function CardActions({ c, contacts }: { c: ChallengeView; contacts: readonly ContactView[] }) {
  const app = useApp();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (r: CommunityActionResult): void => setError(r.ok ? null : r.error);
  const open =
    c.status === 'active' && c.progress.status !== 'finished' && c.progress.status !== 'cancelled';
  if (!open) return null;
  if (c.myState === 'invited') {
    return (
      <div className="button-row cm-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          data-testid="challenge-accept"
          onClick={() => act(app.respondToChallenge(c.id, 'accepted'))}
        >
          Accept
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="challenge-decline"
          onClick={() => act(app.respondToChallenge(c.id, 'declined'))}
        >
          Decline
        </button>
        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="button-row cm-actions">
      {c.canInvite && <InviteControl c={c} contacts={contacts} />}
      <span className="cm-actions-end button-row">
        {(c.myState === 'left' || c.myState === 'declined') && (
          <button
            type="button"
            className="btn btn-small"
            data-testid="challenge-rejoin"
            onClick={() => act(app.respondToChallenge(c.id, 'accepted'))}
          >
            Join again
          </button>
        )}
        {c.myState === 'accepted' && !c.isCreator && (
          <button
            type="button"
            className="btn btn-small btn-danger"
            data-testid="challenge-leave"
            onClick={() => act(app.leaveChallenge(c.id))}
          >
            Leave
          </button>
        )}
        {c.isCreator &&
          (confirmCancel ? (
            <span className="button-row" role="group" aria-label="Cancel this challenge?">
              <span className="confirm-label">Cancel it for everyone?</span>
              <button
                type="button"
                className="btn btn-small btn-danger-solid"
                data-testid="challenge-cancel-confirm"
                onClick={() => {
                  setConfirmCancel(false);
                  act(app.cancelChallenge(c.id));
                }}
              >
                Cancel challenge
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setConfirmCancel(false)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-danger"
              data-testid="challenge-cancel"
              onClick={() => setConfirmCancel(true)}
            >
              Cancel challenge
            </button>
          ))}
      </span>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function ChallengeCard({
  c,
  me,
  contacts,
}: {
  c: ChallengeView;
  me: string;
  contacts: readonly ContactView[];
}) {
  const titleId = useId();
  const ended = c.progress.status === 'finished' || c.progress.status === 'cancelled';
  return (
    <article
      className={`card cm-challenge${ended ? ' is-ended' : ''}`}
      aria-labelledby={titleId}
      data-testid="challenge-card"
      data-type={c.type}
      data-status={c.progress.status}
    >
      <header className="cm-ch-head">
        <div className="cm-ch-titles">
          <h4 id={titleId} className="cm-ch-title">
            {c.title}
          </h4>
          <p className="cm-ch-sub">
            {challengeSummary(c)} · {periodText(c)} · by {c.isCreator ? 'you' : c.creatorName}
          </p>
        </div>
        <span className={`cm-ch-when${ended ? '' : ' is-live'}`}>{whenText(c)}</span>
      </header>
      {c.status !== 'cancelled' && <Progress c={c} me={me} />}
      <Participants c={c} me={me} />
      <CardActions c={c} contacts={contacts} />
    </article>
  );
}

// ───────────── create ─────────────

function TemplatePicker({ onPick }: { onPick: (t: ChallengeTemplateInfo) => void }) {
  return (
    <ul className="cm-templates" aria-label="Challenge type">
      {CHALLENGE_TEMPLATES.map((t) => (
        <li key={t.type}>
          <button
            type="button"
            className="cm-template"
            data-testid={`challenge-template-${t.type}`}
            onClick={() => onPick(t)}
          >
            <span className="cm-template-name">{CHALLENGE_TYPE_LABEL[t.type]}</span>
            <span className="cm-template-text">{CHALLENGE_TYPE_TEXT[t.type]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChallengeForm({
  template,
  contacts,
  onBack,
  onDone,
}: {
  template: ChallengeTemplateInfo;
  contacts: readonly ContactView[];
  onBack: () => void;
  onDone: () => void;
}) {
  const app = useApp();
  const ids = { metric: useId(), target: useId(), week: useId(), title: useId() };
  const weeks = useMemo(() => weekOptions(Date.now(), -new Date().getTimezoneOffset(), 5), []);
  const [draft, setDraft] = useState<ChallengeDraft>(() => draftFor(template, 'thisWeek'));
  const [errors, setErrors] = useState<{ target?: string; title?: string; invite?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const spec = targetSpec(template, draft.metric);
  const set = (patch: Partial<ChallengeDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const type: ChallengeType = template.type;
  const isDuel = type === 'duel';

  const submit = (): void => {
    const v = validateDraft(template, draft);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    const r = app.createChallenge(v.input);
    if (r.ok) onDone();
    else setSubmitError(r.error);
  };

  return (
    <form
      className="cm-form"
      data-testid="challenge-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="cm-form-head">
        <div>
          <p className="cm-form-type">{CHALLENGE_TYPE_LABEL[type]}</p>
          <p className="hint">{CHALLENGE_TYPE_TEXT[type]}</p>
        </div>
        <button type="button" className="btn btn-small btn-quiet" onClick={onBack}>
          Other type
        </button>
      </div>
      <div className="rows">
        {template.metrics.length > 1 && (
          <div className="field">
            <div className="field-text">
              <label htmlFor={ids.metric}>Measure</label>
            </div>
            <div className="field-control">
              <select
                id={ids.metric}
                data-testid="challenge-metric"
                value={draft.metric}
                onChange={(e) => {
                  const metric = e.currentTarget.value as ChallengeMetric;
                  const next = targetSpec(template, metric);
                  set({ metric, target: next ? String(next.suggested) : '' });
                }}
              >
                {template.metrics.map((m) => (
                  <option key={m.metric} value={m.metric}>
                    {METRIC_LABEL[m.metric]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {spec && (
          <div className="field">
            <div className="field-text">
              <label htmlFor={ids.target}>
                {type === 'group-goal'
                  ? 'Shared target'
                  : type === 'personal-goal'
                    ? 'Target for each rider'
                    : 'Target'}{' '}
                ({spec.unit})
              </label>
              {errors.target ? (
                <span className="field-error" role="alert">
                  {errors.target}
                </span>
              ) : (
                <span className="field-hint">
                  {spec.min}–{spec.max.toLocaleString('en-GB')} {spec.unit}
                </span>
              )}
            </div>
            <div className="field-control">
              <input
                id={ids.target}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                data-testid="challenge-target"
                aria-invalid={errors.target ? true : undefined}
                value={draft.target}
                onChange={(e) => set({ target: e.currentTarget.value })}
              />
            </div>
          </div>
        )}
        <div className="field">
          <div className="field-text">
            <label htmlFor={ids.week}>{type === 'streak' ? 'First week' : 'Week'}</label>
            <span className="field-hint">
              {type === 'streak'
                ? 'Counts from this week on, with no end.'
                : 'Each rider’s own local week, Monday to Sunday.'}
            </span>
          </div>
          <div className="field-control">
            <select
              id={ids.week}
              data-testid="challenge-week"
              value={draft.week}
              onChange={(e) => set({ week: e.currentTarget.value })}
            >
              {weeks.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <div className="field-text">
            <label htmlFor={ids.title}>Title</label>
            {errors.title ? (
              <span className="field-error" role="alert">
                {errors.title}
              </span>
            ) : (
              <span className="field-hint">Optional; a title is made up from the target.</span>
            )}
          </div>
          <div className="field-control">
            <input
              id={ids.title}
              type="text"
              autoComplete="off"
              maxLength={MAX_TITLE_LENGTH + 20}
              data-testid="challenge-title"
              aria-invalid={errors.title ? true : undefined}
              placeholder={CHALLENGE_TYPE_LABEL[type]}
              value={draft.title}
              onChange={(e) => set({ title: e.currentTarget.value })}
            />
          </div>
        </div>
        <fieldset className="cm-invitees">
          <legend>
            {isDuel ? 'Your opponent' : 'Invite friends'}
            <span className="field-hint">
              {contacts.length === 0
                ? ' — none yet: friends appear after your first group ride. You can invite later.'
                : isDuel
                  ? ' — pick one friend.'
                  : ' — they get the invitation the next time you ride together.'}
            </span>
          </legend>
          {contacts.length > 0 && (
            <div className="cm-chips">
              {contacts.map((ct) => {
                const on = draft.invite.includes(ct.riderId);
                return (
                  <button
                    key={ct.riderId}
                    type="button"
                    className="cm-chip"
                    aria-pressed={on}
                    data-testid="challenge-invitee"
                    onClick={() =>
                      set({
                        invite: on
                          ? draft.invite.filter((x) => x !== ct.riderId)
                          : isDuel
                            ? [ct.riderId]
                            : [...draft.invite, ct.riderId],
                      })
                    }
                  >
                    {ct.displayName}
                  </button>
                );
              })}
            </div>
          )}
          {errors.invite && (
            <span className="field-error" role="alert">
              {errors.invite}
            </span>
          )}
        </fieldset>
        {type === 'beat-your-best' && (
          <p className="hint cm-form-note">
            Best efforts are only exchanged with friends who share “Everything” with each other.
          </p>
        )}
      </div>
      <div className="cm-form-foot">
        {submitError && (
          <span className="field-error" role="alert" data-testid="challenge-error">
            {submitError}
          </span>
        )}
        <span className="button-row end">
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" data-testid="challenge-submit">
            Create challenge
          </button>
        </span>
      </div>
    </form>
  );
}

export function ChallengeCreate({
  contacts,
  onClose,
  initialType,
}: {
  contacts: readonly ContactView[];
  onClose: () => void;
  initialType?: ChallengeType;
}) {
  const [template, setTemplate] = useState<ChallengeTemplateInfo | null>(
    () => CHALLENGE_TEMPLATES.find((t) => t.type === initialType) ?? null,
  );
  return (
    <div className="card cm-create" data-testid="challenge-create">
      {template ? (
        <ChallengeForm
          key={template.type}
          template={template}
          contacts={contacts}
          onBack={() => setTemplate(null)}
          onDone={onClose}
        />
      ) : (
        <>
          <div className="cm-form-head">
            <div>
              <p className="cm-form-type">New challenge</p>
              <p className="hint">Pick a type. You can invite friends in the next step.</p>
            </div>
            <button type="button" className="btn btn-small" onClick={onClose}>
              Cancel
            </button>
          </div>
          <TemplatePicker onPick={setTemplate} />
        </>
      )}
    </div>
  );
}

// ───────────── section ─────────────

const GROUP_TITLE = { running: 'Running', upcoming: 'Upcoming', finished: 'Finished' } as const;

export function ChallengesSection({ initialCreate }: { initialCreate?: ChallengeType }) {
  const challenges = useAppState((s) => s.community.challenges);
  const invitations = useAppState((s) => s.community.invitations);
  const contacts = useAppState((s) => s.community.contacts);
  const me = useMe();
  const [creating, setCreating] = useState(initialCreate !== undefined);
  const invited = new Set(invitations.map((c) => c.id));
  const rest = challenges.filter((c) => !invited.has(c.id));
  const groups = (['running', 'upcoming', 'finished'] as const).map((g) => ({
    g,
    list: rest.filter((c) => challengeGroup(c) === g),
  }));
  const card = (c: ChallengeView) => <ChallengeCard key={c.id} c={c} me={me} contacts={contacts} />;
  return (
    <section aria-labelledby="cm-ch-title" data-testid="community-challenges">
      <div className="section-head">
        <h2 id="cm-ch-title" className="section-title">
          Challenges
        </h2>
        {!creating && (
          <button
            type="button"
            className="btn btn-small btn-quiet"
            data-testid="challenge-new"
            onClick={() => setCreating(true)}
          >
            + New challenge
          </button>
        )}
      </div>
      <div className="cm-ch-stack">
        {creating && (
          <ChallengeCreate
            contacts={contacts}
            onClose={() => setCreating(false)}
            initialType={initialCreate}
          />
        )}
        {invitations.length > 0 && (
          <div className="cm-ch-group" data-testid="challenge-invitations">
            <h3 className="subhead">Invitations</h3>
            {invitations.map(card)}
          </div>
        )}
        {groups.map(({ g, list }) =>
          list.length > 0 ? (
            <div key={g} className="cm-ch-group">
              <h3 className="subhead">{GROUP_TITLE[g]}</h3>
              {list.map(card)}
            </div>
          ) : null,
        )}
        {challenges.length === 0 && !creating && (
          <div className="card empty cm-ch-empty" data-testid="challenges-empty">
            <p className="empty-title">No challenges yet</p>
            <p className="empty-text">
              Set yourself a goal for the week, or create one and invite friends. Invitations reach
              them the next time you ride together.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
