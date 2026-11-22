import { describe, expect, it } from 'vitest';
import { CHALLENGE_TEMPLATES } from '../../core/communityService';
import type { ChallengeTemplateInfo } from '../../core/communityService';
import {
  challengeGroup,
  challengeSummary,
  draftFor,
  formatAgeHours,
  formatDelta,
  formatMetric,
  formatRemaining,
  formatWeekRange,
  sessionText,
  targetSpec,
  tiedRanks,
  validateDraft,
  weekNumber,
  weekOptions,
} from './communityView';
import type { ChallengeView } from '../../core/communityService';

const tpl = (type: ChallengeTemplateInfo['type']): ChallengeTemplateInfo =>
  CHALLENGE_TEMPLATES.find((t) => t.type === type)!;

describe('community formatting', () => {
  it('formats every metric with its unit', () => {
    expect(formatMetric('points', 1234)).toBe('1,234 points');
    expect(formatMetric('points', 1)).toBe('1 point');
    expect(formatMetric('distanceM', 12_345)).toBe('12.3 km');
    expect(formatMetric('distanceM', 152_400)).toBe('152 km');
    expect(formatMetric('movingS', 45 * 60)).toBe('45 min');
    expect(formatMetric('movingS', 2 * 3600 + 5 * 60)).toBe('2:05 h');
    expect(formatMetric('movingS', 3 * 3600)).toBe('3 h');
    expect(formatMetric('elevationGainM', 1185)).toBe('1,185 m');
    expect(formatMetric('energyKj', 2586)).toBe('2,586 kJ');
    expect(formatMetric('rides', 1)).toBe('1 ride');
    expect(formatMetric('rideDays', 3)).toBe('3 days');
    expect(formatMetric('groupRides', 2)).toBe('2 group rides');
    expect(formatMetric('p20m', 251)).toBe('251 W');
  });

  it('formats deltas with a typographic minus and calls tiny ones level', () => {
    expect(formatDelta('points', 90)).toBe('+90 points');
    expect(formatDelta('points', -30)).toBe('−30 points');
    expect(formatDelta('distanceM', 0)).toBe('level');
    expect(formatDelta('distanceM', 20)).toBe('level');
    expect(formatDelta('distanceM', -1500)).toBe('−1.5 km');
  });

  it('formats ages, remaining time and weeks', () => {
    expect(formatAgeHours(0.4)).toBe('just now');
    expect(formatAgeHours(5)).toBe('5 h ago');
    expect(formatAgeHours(47)).toBe('47 h ago');
    expect(formatAgeHours(5 * 24 + 3)).toBe('5 d ago');
    expect(formatRemaining(2 * 86_400_000 + 5 * 3_600_000)).toBe('2 d 5 h left');
    expect(formatRemaining(3 * 86_400_000)).toBe('3 d left');
    expect(formatRemaining(5 * 3_600_000 + 1)).toBe('5 h left');
    expect(formatRemaining(40 * 60_000)).toBe('40 min left');
    expect(formatRemaining(0)).toBe('ends now');
    expect(weekNumber('2026-W08')).toBe('Week 8');
    const mon = new Date(2026, 10, 16).getTime();
    expect(formatWeekRange(mon, new Date(2026, 10, 23).getTime())).toBe('16–22 Nov');
    expect(formatWeekRange(new Date(2026, 10, 30).getTime(), new Date(2026, 11, 7).getTime())).toBe(
      '30 Nov – 6 Dec',
    );
  });

  it('offers this week, next week and later weeks for a challenge', () => {
    const opts = weekOptions(Date.UTC(2026, 10, 18, 12), 0, 4);
    expect(opts.map((o) => o.value)).toEqual(['thisWeek', 'nextWeek', '2026-W49', '2026-W50']);
    expect(opts[0]?.label).toMatch(/^This week · /);
    expect(opts[2]?.label).toMatch(/^Week 49 · /);
  });

  it('finds tied ranks', () => {
    expect([...tiedRanks([{ rank: 1 }, { rank: 2 }, { rank: 2 }, { rank: 4 }])]).toEqual([2]);
    expect(tiedRanks([{ rank: 1 }]).size).toBe(0);
  });

  it('describes what a session receives', () => {
    expect(sessionText('totals')).toBe('Sharing totals with this session.');
    expect(sessionText('none')).toMatch(/^Sharing nothing: someone here is set to Nothing/);
    expect(sessionText(null)).toMatch(/not yet identified/);
    expect(sessionText('silent')).toMatch(/removed/);
    expect(sessionText('everything')).toMatch(/best efforts/);
  });
});

describe('challenge texts and grouping', () => {
  it('summarises each type in plain words', () => {
    const s = (type: ChallengeView['type'], metric: ChallengeView['metric'], target: number) =>
      challengeSummary({ type, metric, target });
    expect(s('personal-goal', 'distanceM', 150_000)).toBe('Personal goal · 150 km each');
    expect(s('group-goal', 'points', 1500)).toBe('Group goal · 1,500 points together');
    expect(s('duel', 'points', 0)).toBe('Duel · most points');
    expect(s('streak', 'rides', 2)).toBe('Streak · 2+ rides every week');
    expect(s('consistency', 'rideDays', 4)).toBe('Consistency · 4 days with a ride');
    expect(s('beat-your-best', 'p20m', 0)).toBe('Beat your best · 20-minute power');
    expect(s('ride-together', 'groupRides', 2)).toBe('Ride together · 2 group rides');
  });

  it('sorts challenges into running, upcoming and finished', () => {
    const g = (status: ChallengeView['progress']['status'], c: 'active' | 'cancelled' = 'active') =>
      challengeGroup({ status: c, progress: { status } as ChallengeView['progress'] });
    expect(g('running')).toBe('running');
    expect(g('upcoming')).toBe('upcoming');
    expect(g('finished')).toBe('finished');
    expect(g('running', 'cancelled')).toBe('finished');
  });
});

describe('new challenge form', () => {
  it('derives friendly target ranges from the templates', () => {
    expect(targetSpec(tpl('personal-goal'), 'distanceM')).toMatchObject({
      unit: 'km',
      min: 1,
      max: 2000,
      suggested: 100,
      factor: 1000,
    });
    expect(targetSpec(tpl('group-goal'), 'distanceM')).toMatchObject({ max: 32_000 });
    expect(targetSpec(tpl('personal-goal'), 'movingS')).toMatchObject({
      unit: 'h',
      min: 0.5,
      max: 168,
      factor: 3600,
    });
    expect(targetSpec(tpl('streak'), 'rides')).toMatchObject({ min: 1, max: 14, suggested: 2 });
    expect(targetSpec(tpl('consistency'), 'rideDays')).toMatchObject({ min: 1, max: 7 });
    expect(targetSpec(tpl('ride-together'), 'groupRides')).toMatchObject({ min: 1, max: 20 });
    expect(targetSpec(tpl('duel'), 'points')).toBeNull();
    expect(targetSpec(tpl('beat-your-best'), 'p20m')).toBeNull();
  });

  it('every template has a valid default draft', () => {
    for (const t of CHALLENGE_TEMPLATES) {
      const r = validateDraft(t, draftFor(t, 'thisWeek'));
      expect(r.ok, t.type).toBe(true);
    }
  });

  it('converts the target to the stored unit and keeps a title', () => {
    const t = tpl('personal-goal');
    const r = validateDraft(t, {
      ...draftFor(t, 'nextWeek'),
      target: '150',
      title: '  Big week ',
      invite: ['a'],
    });
    expect(r).toEqual({
      ok: true,
      input: {
        type: 'personal-goal',
        metric: 'distanceM',
        week: 'nextWeek',
        target: 150_000,
        title: 'Big week',
        invite: ['a'],
      },
    });
    const hours = validateDraft(t, {
      ...draftFor(t, 'thisWeek'),
      metric: 'movingS',
      target: '2,5',
    });
    expect(hours.ok && hours.input.target).toBe(9000);
  });

  it('reports out-of-range targets, long titles and too many invitations', () => {
    const t = tpl('consistency');
    const r = validateDraft(t, { ...draftFor(t, 'thisWeek'), target: '9', title: 'x'.repeat(61) });
    expect(r).toEqual({
      ok: false,
      errors: {
        target: 'Enter a number from 1 to 7 days.',
        title: 'Keep the title to 60 characters.',
      },
    });
    expect(validateDraft(t, { ...draftFor(t, 'thisWeek'), target: '' }).ok).toBe(false);
    expect(validateDraft(t, { ...draftFor(t, 'thisWeek'), target: 'abc' }).ok).toBe(false);
    const duel = tpl('duel');
    expect(validateDraft(duel, { ...draftFor(duel, 'thisWeek'), invite: ['a', 'b'] })).toEqual({
      ok: false,
      errors: { invite: 'A duel is between two riders: invite one friend.' },
    });
  });
});
