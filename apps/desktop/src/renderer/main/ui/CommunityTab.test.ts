// Server-side render tests of the Community tab and the new Settings cards (no DOM needed).
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ChallengeProgress, ParticipantProgress } from '@freilauf/community';
import type { App, AppState } from '../appStore';
import type { ChallengeView, CommunityView, ContactView } from '../../core/communityService';
import { CommunityService } from '../../core/communityService';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import type { LiveState } from '../../../shared/contract';
import type { TabId } from './MainApp';
import { MainApp } from './index';

const NOW = Date.now();
const H = 3_600_000;
const DAY = 24 * H;
const ME = 'me-rider-0001';

function live(): LiveState {
  return {
    ride: {
      state: 'idle',
      elapsedS: 0,
      distanceM: 0,
      speedMps: 0,
      powerW: 0,
      power3sW: 0,
      wattsPerKg: 0,
      cadenceRpm: 0,
      heartRateBpm: null,
      gear: 12,
      gearCount: 24,
      gradePercent: 0,
    },
    devices: {
      trainer: { name: 'T', state: 'connected' },
      heartRate: null,
      controller: { name: 'C', state: 'connected' },
    },
    group: null,
    localName: 'Rider',
  };
}

function emptyView(): CommunityView {
  const v = new CommunityService({ storage: null }).view;
  return { ...v, profile: { ...v.profile, riderId: ME, name: 'Rider' } };
}

function state(community: CommunityView, extra: Partial<AppState> = {}): AppState {
  return {
    ready: true,
    simMode: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    live: live(),
    picker: null,
    busy: {},
    rides: [],
    group: { phase: 'idle' },
    notices: [],
    overlayEditMode: false,
    simEffortW: 180,
    workouts: [],
    selectedWorkoutId: null,
    ftpOutcome: null,
    sharedWorkouts: [],
    sharingWorkoutId: null,
    groupCountdownS: null,
    community,
    lastButton: null,
    levers: null,
    ...extra,
  };
}

function render(s: AppState, tab: TabId = 'community'): string {
  const app = { store: createStore<AppState>(() => s) } as unknown as App;
  return renderToString(createElement(MainApp, { app, initialTab: tab }));
}

/** The HTML from `marker` to the next occurrence of `next` (or the end). */
function slice(html: string, marker: string, next = marker): string {
  const start = html.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  const end = html.indexOf(next, start + marker.length);
  return html.slice(start, end === -1 ? undefined : end);
}

const text = (html: string): string => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '');

function contact(id: string, name: string, over: Partial<ContactView> = {}): ContactView {
  return {
    riderId: id,
    name,
    alias: null,
    displayName: name,
    visibility: 'totals',
    firstSeen: NOW - 20 * DAY,
    lastSeen: NOW - 3 * H,
    present: false,
    standing: {
      updatedAt: NOW - 3 * H,
      ageHours: 3,
      stale: false,
      viaRiderId: null,
      viaName: null,
    },
    ...over,
  };
}

function participant(
  riderId: string,
  name: string,
  over: Partial<ParticipantProgress> = {},
): ParticipantProgress {
  return {
    riderId,
    name,
    state: 'accepted',
    value: null,
    target: null,
    fraction: null,
    complete: false,
    final: false,
    ...over,
  };
}

function challenge(
  type: ChallengeView['type'],
  over: Partial<ChallengeView> = {},
  progress: Partial<ChallengeProgress> = {},
): ChallengeView {
  const metric: ChallengeView['metric'] =
    over.metric ??
    (
      {
        'personal-goal': 'distanceM',
        'group-goal': 'points',
        duel: 'points',
        streak: 'rides',
        consistency: 'rideDays',
        'beat-your-best': 'p20m',
        'ride-together': 'groupRides',
      } as const
    )[type];
  return {
    id: `ch-${type}`,
    title: `Title ${type}`,
    type,
    metric,
    target: 0,
    week: '2026-W47',
    status: 'active',
    creatorId: ME,
    creatorName: 'Rider',
    isCreator: true,
    myState: 'accepted',
    canInvite: false,
    current: true,
    ...over,
    progress: {
      challengeId: `ch-${type}`,
      type,
      metric,
      status: 'running',
      startsAt: NOW - 3 * DAY,
      endsAt: type === 'streak' ? null : NOW + 2 * DAY + 5 * H + 60_000,
      remainingMs: type === 'streak' ? null : 2 * DAY + 5 * H + 60_000,
      participants: [participant(ME, 'Rider')],
      combined: null,
      leader: null,
      result: null,
      ...progress,
    },
  };
}

describe('Community tab (SSR)', () => {
  it('sits after Group and shows an empty week, an empty leaderboard and no challenges', () => {
    const html = render(state(emptyView()));
    expect(html.indexOf('data-testid="tab-group"')).toBeLessThan(
      html.indexOf('data-testid="tab-community"'),
    );
    expect(html.indexOf('data-testid="tab-community"')).toBeLessThan(
      html.indexOf('data-testid="tab-history"'),
    );
    expect(html).toContain('data-testid="panel-community"');
    expect(html).toMatch(/data-testid="community-week-points">0</);
    expect(html).toMatch(/data-testid="community-week-rides">.*?>0</);
    expect(text(html)).toContain('How points work');
    expect(text(html)).toContain('An hour at your FTP is 100 points');
    // Default FTP: nudge towards the test.
    expect(html).toContain('data-testid="community-ftp-nudge"');
    expect(text(html)).toContain('Your FTP is still the default 200 W');
    expect(html).toContain('data-testid="leaderboard-empty"');
    expect(text(html)).toContain('Ride with friends once and they appear here');
    expect(text(html)).toContain('there is no server');
    expect(text(html)).toContain('Ride together in Group');
    expect(html).toContain('data-testid="challenges-empty"');
    expect(html).toContain('data-testid="contacts-empty"');
    expect(html).not.toContain('data-testid="session-level"');
    expect(html).not.toContain('data-testid="community-backfill"');
    expect(html).not.toContain('data-testid="community-save-failed"');
    // Segmented controls for period and metric (no average speed).
    for (const id of [
      'board-period-thisWeek',
      'board-period-lastWeek',
      'board-period-thisMonth',
      'board-period-lastMonth',
      'board-metric-points',
      'board-metric-distanceM',
      'board-metric-movingS',
      'board-metric-elevationGainM',
      'board-metric-energyKj',
      'board-metric-rides',
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="board-period-thisWeek"/);
  });

  it('nudges when rides scored no points and stays quiet with a real FTP', () => {
    const v = emptyView();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.rider.ftpW = 262;
    expect(render(state(v, { settings }))).not.toContain('community-ftp-nudge');
    const zero = { ...v, week: { ...v.week, totals: { ...v.week.totals, rides: 2, points: 0 } } };
    expect(text(render(state(zero, { settings })))).toContain('scored no points yet');
  });

  it('ranks the leaderboard with ties, you, stale and relayed standings', () => {
    const v = emptyView();
    const row = (
      rank: number,
      riderId: string,
      name: string,
      value: number,
      over: Partial<CommunityView['leaderboard']['rows'][number]> = {},
    ) => ({
      rank,
      riderId,
      name,
      value,
      deltaToYou: value - 234,
      stale: false,
      you: false,
      relation: 'friend' as const,
      ...over,
    });
    const view: CommunityView = {
      ...v,
      week: { ...v.week, totals: { ...v.week.totals, points: 234, rides: 4, distanceM: 118_000 } },
      leaderboard: {
        ...v.leaderboard,
        rows: [
          row(1, 'ben', 'Ben', 324),
          row(2, ME, 'Rider', 234, { you: true, relation: 'you', deltaToYou: 0 }),
          row(3, 'anna', 'Anna', 204),
          row(3, 'cleo', 'Cleo', 204),
          row(5, 'emil', 'Emil', 200, { stale: true }),
        ],
      },
      contacts: [
        contact('ben', 'Ben'),
        contact('anna', 'Anna'),
        contact('cleo', 'Cleo'),
        contact('emil', 'Emil', {
          standing: {
            updatedAt: NOW - 5 * DAY,
            ageHours: 5 * 24 + 2,
            stale: true,
            viaRiderId: 'ben',
            viaName: 'Ben',
          },
        }),
        contact('dario', 'Dario', { standing: null }),
      ],
    };
    const html = render(state(view));
    expect(html).toMatch(/data-testid="community-week-points">234</);
    const rows = html.match(/data-testid="board-row"[\s\S]*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => /data-rank="(\d)"/.exec(r)?.[1])).toEqual(['1', '2', '3', '3', '5']);
    expect(text(rows[0]!)).toContain('+90 points');
    expect(rows[1]).toContain('data-you="true"');
    expect(text(rows[1]!)).toContain('You');
    expect(text(rows[2]!)).toContain('(tied)');
    expect(text(rows[3]!)).toContain('−30 points');
    expect(rows[4]).toContain('data-stale="true"');
    expect(text(rows[4]!)).toContain('updated 5 d ago');
    expect(text(rows[4]!)).toContain('via Ben');
    // Dario shares nothing: not on the board, explained in the footnote.
    expect(rows.join('')).not.toContain('Dario');
    expect(text(html)).toContain('Friends who share nothing with you are not listed');
    expect(html).not.toContain('data-testid="leaderboard-empty"');
  });

  it('renders a card per challenge type with a fitting progress visual', () => {
    const v = emptyView();
    const challenges: ChallengeView[] = [
      challenge(
        'personal-goal',
        { target: 150_000, canInvite: true },
        {
          participants: [
            participant(ME, 'Rider', { value: 118_000, target: 150_000, fraction: 0.79 }),
            participant('ben', 'Ben', {
              value: 194_000,
              target: 150_000,
              fraction: 1.29,
              complete: true,
            }),
            participant('anna', 'Anna', { state: 'invited' }),
          ],
        },
      ),
      challenge(
        'group-goal',
        { target: 1500 },
        {
          participants: [
            participant(ME, 'Rider', { value: 234 }),
            participant('ben', 'Ben', { value: 324 }),
            participant('cleo', 'Cleo', { value: null }),
          ],
          combined: { value: 558, target: 1500, fraction: 0.372, complete: false, partial: true },
        },
      ),
      challenge(
        'duel',
        { isCreator: false, creatorId: 'ben', creatorName: 'Ben' },
        {
          participants: [
            participant('ben', 'Ben', { value: 324 }),
            participant(ME, 'Rider', { value: 234 }),
          ],
          leader: 'ben',
        },
      ),
      challenge(
        'streak',
        { target: 2 },
        {
          participants: [
            participant(ME, 'Rider', { value: 3 }),
            participant('finn', 'Finn', { value: 1 }),
          ],
        },
      ),
      challenge(
        'consistency',
        { target: 4 },
        { participants: [participant(ME, 'Rider', { value: 2, target: 4, fraction: 0.5 })] },
      ),
      challenge(
        'beat-your-best',
        {},
        {
          participants: [
            participant(ME, 'Rider', { value: 262, target: 250, fraction: 1.05, complete: true }),
            participant('anna', 'Anna', { value: null }),
          ],
        },
      ),
      challenge(
        'ride-together',
        { target: 3 },
        { participants: [participant(ME, 'Rider', { value: 1, target: 3, fraction: 1 / 3 })] },
      ),
    ];
    const html = render(
      state({ ...v, challenges, contacts: [contact('ben', 'Ben'), contact('dario', 'Dario')] }),
    );
    const card = (type: string) =>
      slice(
        html,
        `data-testid="challenge-card" data-type="${type}"`,
        'data-testid="challenge-card"',
      );
    expect(html.match(/data-testid="challenge-card"/g)).toHaveLength(7);

    const personal = card('personal-goal');
    expect(text(personal)).toContain('Personal goal · 150 km each');
    expect(text(personal)).toContain('2 d 5 h left');
    expect(text(personal)).toContain('118 / 150 km');
    expect(text(personal)).toContain('done');
    expect(personal).toContain('role="meter"');
    expect(text(personal)).toContain('Anna (invited)');
    // Creator: invite a contact not yet in it, and cancel.
    expect(personal).toContain('data-testid="challenge-invite"');
    expect(personal).toContain('>Dario<');
    expect(personal).not.toMatch(/<option[^>]*>Ben</);
    expect(personal).toContain('data-testid="challenge-cancel"');
    expect(personal).not.toContain('data-testid="challenge-leave"');

    const group = card('group-goal');
    expect(text(group)).toContain('558 points of 1,500 points');
    expect(text(group)).toContain('37 %');
    expect(group.match(/class="cm-seg /g)).toHaveLength(2); // stacked contributions
    expect(text(group)).toContain('Riders who share nothing with you are missing from the sum.');

    const duel = card('duel');
    expect(text(duel)).toContain('Ben leads by 90 points');
    expect(duel.match(/cm-duel-side/g)).toHaveLength(2);
    expect(duel).toContain('data-testid="challenge-leave"'); // not the creator
    expect(text(duel)).toContain('by Ben');

    const streak = card('streak');
    expect(text(streak)).toContain('Open-ended');
    expect(text(streak)).toContain('3 weeks');
    expect(streak).toContain('aria-label="3 weeks in a row"');

    const consistency = card('consistency');
    expect(consistency.match(/class="cm-dot[ "]/g)).toHaveLength(7);
    expect(consistency.match(/cm-dot is-on/g)).toHaveLength(2);
    expect(text(consistency)).toContain('2 / 4 days');

    const best = card('beat-your-best');
    expect(text(best)).toContain('Before');
    expect(text(best)).toContain('250 W');
    expect(text(best)).toContain('262 W');
    expect(text(best)).toContain('beaten');
    expect(text(best)).toContain('needs “Everything” shared with you');

    const together = card('ride-together');
    expect(together.match(/class="cm-dot[ "]/g)).toHaveLength(3);
    expect(text(together)).toContain('1 / 3 group rides');
  });

  it('puts invitations first with accept and decline, then upcoming and finished', () => {
    const v = emptyView();
    const invite = challenge(
      'consistency',
      {
        id: 'inv',
        title: 'Four days',
        target: 4,
        isCreator: false,
        creatorName: 'Cleo',
        myState: 'invited',
      },
      {
        participants: [
          participant('cleo', 'Cleo', { value: 3 }),
          participant(ME, 'Rider', { state: 'invited' }),
        ],
      },
    );
    const upcoming = challenge(
      'ride-together',
      { id: 'up', title: 'Next week together', target: 2 },
      { status: 'upcoming', startsAt: NOW + DAY },
    );
    const done = challenge(
      'personal-goal',
      { id: 'old', title: 'Last week goal', target: 100_000 },
      { status: 'finished', remainingMs: 0 },
    );
    const cancelled = challenge(
      'duel',
      { id: 'gone', title: 'Called off', status: 'cancelled' },
      { status: 'cancelled' },
    );
    const html = render(
      state({ ...v, challenges: [invite, upcoming, done, cancelled], invitations: [invite] }),
    );
    const inv = slice(html, 'data-testid="challenge-invitations"', 'class="cm-ch-group"');
    expect(inv).toContain('Four days');
    expect(inv).toContain('data-testid="challenge-accept"');
    expect(inv).toContain('data-testid="challenge-decline"');
    // Listed once only.
    expect(html.match(/Four days/g)).toHaveLength(1);
    const order = ['Invitations', 'Upcoming', 'Finished'].map((h) => html.indexOf(`>${h}<`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text(slice(html, 'Next week together', 'data-testid="challenge-card"'))).toContain(
      'Starts ',
    );
    const old = slice(html, 'Last week goal', 'data-testid="challenge-card"');
    expect(text(old)).toContain('Finished');
    expect(old).not.toContain('challenge-cancel');
    expect(text(slice(html, 'Called off'))).toContain('Cancelled');
  });

  it('opens the create flow on the template picker', async () => {
    const { ChallengesSection } = await import('./CommunityChallenges');
    const { AppContext } = await import('./hooks');
    const s = state(emptyView());
    const app = { store: createStore<AppState>(() => s) } as unknown as App;
    const picker = renderToString(
      createElement(AppContext, { value: app }, createElement(ChallengesSection, {})),
    );
    expect(picker).toContain('data-testid="challenge-new"');
    // With a type chosen: the form with defaults from the template.
    const form = renderToString(
      createElement(
        AppContext,
        { value: app },
        createElement(ChallengesSection, { initialCreate: 'personal-goal' }),
      ),
    );
    expect(form).toContain('data-testid="challenge-create"');
    expect(form).toContain('data-testid="challenge-form"');
    expect(form).toMatch(/data-testid="challenge-target"[^>]*value="100"/);
    expect(text(form)).toContain('Target for each rider (km)');
    expect(text(form)).toContain('1–2,000 km');
    expect(form).toContain('data-testid="challenge-week"');
    expect(text(form)).toContain('This week · ');
    expect(form).toContain('data-testid="challenge-submit"');
    const duel = renderToString(
      createElement(
        AppContext,
        { value: app },
        createElement(ChallengesSection, { initialCreate: 'duel' }),
      ),
    );
    expect(duel).not.toContain('data-testid="challenge-target"');
    expect(text(duel)).toContain('Your opponent');
    const { CHALLENGE_TEMPLATES } = await import('../../core/communityService');
    const { ChallengeCreate } = await import('./CommunityChallenges');
    const templates = renderToString(
      createElement(
        AppContext,
        { value: app },
        createElement(ChallengeCreate, { contacts: [], onClose: () => {} }),
      ),
    );
    for (const t of CHALLENGE_TEMPLATES) {
      expect(templates, t.type).toContain(`data-testid="challenge-template-${t.type}"`);
    }
    expect(text(templates)).toContain('You against one friend: most points in the week wins.');
  });

  it('shows friends with visibility, standing age, the session rule and blocked riders', () => {
    const v = emptyView();
    const view: CommunityView = {
      ...v,
      contacts: [
        contact('anna', 'Anna', { present: true, visibility: 'everything' }),
        contact('ben', 'Ben', {
          alias: 'Ben (club)',
          displayName: 'Ben (club)',
          lastSeen: NOW - 22 * H,
        }),
        contact('dario', 'Dario', { standing: null, visibility: 'none' }),
      ],
      blocked: [{ riderId: 'gus', name: 'Gus', since: NOW - 4 * DAY }],
      session: { active: true, peers: 2, identified: 1, level: 'none' },
    };
    const html = render(state(view));
    const friends = slice(html, 'data-testid="community-friends"');
    expect(text(friends)).toContain('In a group session everyone present receives the same data.');
    expect(text(friends)).toContain('most restricted person present');
    expect(text(slice(friends, 'data-testid="session-level"', '</p>'))).toContain(
      'Sharing nothing: someone here is set to Nothing or is not yet identified.',
    );
    const rows = friends.match(/data-testid="contact-row"[\s\S]*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(text(rows[0]!)).toContain('here now');
    expect(rows[0]).toMatch(
      /<option value="everything" selected="">Everything \(incl\. best efforts\)/,
    );
    expect(text(rows[1]!)).toContain('calls themself Ben');
    expect(text(rows[1]!)).toContain('last seen 22 h ago');
    expect(text(rows[2]!)).toContain('shares nothing with you');
    expect(rows[2]).toMatch(/<option value="none" selected="">Nothing/);
    for (const r of rows) {
      expect(r).toContain('data-testid="contact-rename"');
      expect(r).toContain('data-testid="contact-remove"');
    }
    expect(friends).toContain('data-testid="community-default-visibility"');
    expect(friends).toContain('data-testid="community-fof"');
    expect(text(friends)).toContain('Friends of friends may see my totals');
    expect(text(friends)).toContain('whose rider ids are then listed in what you share');
    expect(text(slice(friends, 'data-testid="blocked-row"', '</li>'))).toContain('Gus');
    expect(friends).toContain('data-testid="contact-unblock"');

    const totals = render(state({ ...view, session: { ...view.session, level: 'totals' } }));
    expect(text(totals)).toContain('Sharing totals with this session.');
  });

  it('shows backfill progress and a failed save', () => {
    const v = emptyView();
    const html = render(
      state({
        ...v,
        backfill: { status: 'running', processed: 4, total: 12, added: 3 },
        storage: { bytes: 100, saveFailed: true },
      }),
    );
    expect(text(slice(html, 'data-testid="community-backfill"', '</p>'))).toContain(
      'Adding 12 earlier rides… 4 of 12 done',
    );
    expect(html).toContain('data-testid="community-save-failed"');
  });
});

describe('Settings: controller buttons and diagnostics (SSR)', () => {
  it('lists all sixteen buttons by grip with a reset and the live indicator', () => {
    const idle = render(state(emptyView()), 'settings');
    expect(idle.match(/data-testid="button-row-[a-zA-Z]+"/g)?.length).toBe(16);
    const left = slice(idle, '>Left grip<', '>Right grip<');
    expect(left.match(/data-testid="button-map-/g)).toHaveLength(8);
    expect(left).toContain('D-pad up');
    expect(idle).toContain('data-testid="button-map-onOffRight"');
    expect(idle).toMatch(/data-testid="button-map-reset"[^>]*disabled/);
    expect(text(idle)).toContain('Press a button on the controller');
    expect(idle).not.toContain('data-pressed');

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.shifting.buttons.a = 'startPause';
    const pressed = render(
      state(emptyView(), { settings, lastButton: { button: 'shiftUpRight', at: Date.now() } }),
      'settings',
    );
    expect(pressed).not.toMatch(/data-testid="button-map-reset"[^>]*disabled/);
    expect(text(pressed)).toContain('Last button: Right grip · Upper shift button');
    const row = slice(pressed, 'data-testid="button-row-shiftUpRight"', '</li>');
    expect(row).toContain('data-pressed="true"');
    expect(text(row)).toContain('pressed');
    expect(pressed).toMatch(/data-testid="button-map-a"[\s\S]*?value="startPause" selected=""/);
    // An old press only names the button, no row is lit.
    const old = render(
      state(emptyView(), { lastButton: { button: 'b', at: Date.now() - 60_000 } }),
      'settings',
    );
    expect(text(old)).toContain('Last button: Right grip · B');
    expect(old).not.toContain('data-pressed');
  });

  it('has a diagnostics card with export, copy and open folder', () => {
    const html = render(state(emptyView()), 'settings');
    const card = slice(html, 'data-testid="settings-diagnostics"');
    for (const id of ['log-export', 'log-copy', 'log-open-folder']) {
      expect(card, id).toContain(`data-testid="${id}"`);
    }
    expect(text(card)).toContain('Export log…');
    expect(text(card)).toContain('Copy recent log');
    expect(text(card)).toContain('Open log folder');
    expect(text(card)).toContain('but not your name');
    expect(text(card)).toContain('docs/diagnostics.md');
    expect(text(card)).toContain('Help decode the controllers');
    expect(text(card)).toContain('pull the brake all the way');
  });

  it('shows a live bar per lever with the dead zone, the raw value and the result', () => {
    const html = render(
      state(emptyView(), { levers: { left: -0.43, right: -0.715, at: Date.now() } }),
      'settings',
    );
    const card = slice(html, 'data-testid="lever-mapping"', 'data-testid="lever-hint"');
    const left = slice(card, 'data-testid="lever-left"', 'data-testid="lever-right"');
    const right = slice(card, 'data-testid="lever-right"', 'data-testid="lever-deadzone"');
    expect(text(left)).toContain('Left lever');
    expect(text(left)).toContain('−43 %');
    expect(left).toContain('aria-valuenow="-43"');
    expect(left).toContain('data-value="-43"');
    // Default dead zone ±5 %: a band of 5 % of the bar centred on 0.
    expect(left).toContain('left:47.5%;width:5%');
    expect(left).toContain('left:28.5%;width:21.5%');
    expect(text(left)).toContain('Steering: 40 % left');
    expect(text(right)).toContain('Brake: 70 %');
    for (const side of ['left', 'right']) {
      expect(card).toContain(`data-testid="lever-${side}-swap"`);
      expect(card).toContain(`data-testid="lever-${side}-positive"`);
      expect(card).toContain(`data-testid="lever-${side}-negative"`);
    }
    expect(text(left)).toContain('When the bar moves left (−)');
    expect(text(left)).toContain('When the bar moves right (+)');
    expect(text(card)).toContain('Swap brake and steer on this lever');
    expect(left).toMatch(/data-testid="lever-left-positive"[\s\S]*?value="brake" selected=""/);
    expect(right).toMatch(
      /data-testid="lever-right-positive"[\s\S]*?value="steerRight" selected=""/,
    );
    expect(html).toMatch(/data-testid="lever-reset"[^>]*disabled/);
    expect(text(html)).toContain('confirmed on the real controllers');
    expect(text(card)).toContain('±5 %');
  });

  it('lever display: at rest, swapped assignment, not connected', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.shifting.levers.right = { positive: 'brake', negative: 'steerRight' };
    const swapped = render(
      state(emptyView(), { settings, levers: { left: 0.01, right: 0.9, at: Date.now() } }),
      'settings',
    );
    expect(text(slice(swapped, 'data-testid="lever-left-result"', '</p>'))).toContain('At rest');
    expect(text(slice(swapped, 'data-testid="lever-right-result"', '</p>'))).toContain(
      'Brake: 89 %',
    );
    expect(swapped).not.toMatch(/data-testid="lever-reset"[^>]*disabled/);

    const offline = live();
    offline.devices.controller = null;
    const html = render(state(emptyView(), { live: offline }), 'settings');
    expect(text(html)).toContain('Connect the controller to see the levers move here.');
    expect(text(slice(html, 'data-testid="lever-left-result"', '</p>'))).toContain('Not connected');
    expect(html).toContain('aria-valuenow="0"');
  });
});

describe('Ride tab: brake key, brake cue and simulated levers (SSR)', () => {
  it('lists the brake key, has a hidden brake cue and two lever sliders in sim mode', () => {
    const html = render(
      state(emptyView(), { levers: { left: 0, right: -0.5, at: Date.now() } }),
      'ride',
    );
    expect(text(slice(html, 'class="hint shortcuts"', '</p>'))).toContain('S brake (hold)');
    expect(html).toMatch(/data-testid="scene-brake"[^>]*hidden/);
    expect(html).toContain('data-braking="0"');
    expect(html).toContain('data-testid="sim-lever-left"');
    expect(html).toMatch(/data-testid="sim-lever-right"[^>]*value="-50"/);
    expect(html).toContain('data-testid="sim-levers-release"');
  });
});
