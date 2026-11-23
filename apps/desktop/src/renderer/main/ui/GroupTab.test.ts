// Server-side render tests of the Group tab's states (no DOM needed).
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState } from '../appStore';
import { CommunityService } from '../../core/communityService';
import { describeGroupFailure, GROUP_GUIDE_URL } from '../../core/groupConnection';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { GroupTab } from './GroupTab';
import { AppContext } from './hooks';

function state(
  signallingUrl: string,
  group: AppState['group'] = { phase: 'idle' },
  useOwnServer = signallingUrl !== '',
): AppState {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.group.signallingUrl = signallingUrl;
  settings.group.useOwnServer = useOwnServer;
  return {
    ready: true,
    simMode: true,
    settings,
    live: null,
    picker: null,
    busy: {},
    rides: [],
    group,
    notices: [],
    overlayEditMode: false,
    simEffortW: 180,
    workouts: [],
    selectedWorkoutId: null,
    ftpOutcome: null,
    sharedWorkouts: [],
    sharingWorkoutId: null,
    groupCountdownS: null,
    community: new CommunityService({ storage: null }).view,
    lastButton: null,
    levers: null,
    routes: [],
    selectedRouteId: null,
    routeTrack: null,
    sharedRoutes: [],
    sharingRouteId: null,
    lastRide: null,
  };
}

function render(s: AppState): string {
  const app = { store: createStore<AppState>(() => s) } as unknown as App;
  return renderToString(
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(GroupTab, { onOpenSettings() {} }),
    ),
  );
}

const testId = (id: string): string => `data-testid="${id}"`;
const LINK = 'freilauf://join/ABCDEF?s=wss%3A%2F%2Fnas.example.org%2Fsignal';
const INVITE = 'freilauf://join/ABCDEF#GHJKMNPQRSTU';

function joined(
  overrides: Partial<Extract<AppState['group'], { phase: 'joined' }>> = {},
): AppState['group'] {
  return {
    phase: 'joined',
    roomCode: 'ABCDEF',
    joinLink: INVITE,
    inviteCode: 'ABC-DEF-GHJK-MNPQ-RSTU',
    transport: 'relays',
    relay: 'ready',
    role: 'host',
    signallingUrl: '',
    peers: [],
    notes: [],
    ...overrides,
  };
}

describe('Group tab (SSR)', () => {
  it('fresh install: Create and Join right away, the honest note, own server tucked away', () => {
    const html = render(state(''));
    for (const id of [
      'group-start',
      'group-create',
      'group-join-input',
      'group-join',
      'group-how',
      'group-advanced',
      'group-own-server-toggle',
      'group-server-input',
      'group-use-local',
    ]) {
      expect(html).toContain(testId(id));
    }
    expect(html).toContain('Nothing to set up');
    expect(html).toContain('public relay servers');
    expect(html).toContain('run by others');
    expect(html).toContain('encrypted handshake');
    expect(html).toContain(`href="${GROUP_GUIDE_URL}"`);
    // The own server is an advanced option, closed by default.
    expect(html).toMatch(
      /<details class="disclosure group-advanced" data-testid="group-advanced">/,
    );
    expect(html).not.toContain(testId('group-own-server-note'));
    expect(html).not.toContain('I want to host');
  });

  it('a saved address alone does not switch to the own server', () => {
    const html = render(state('wss://nas.example.org/signal', { phase: 'idle' }, false));
    expect(html).toContain(testId('group-create'));
    expect(html).not.toContain(testId('group-own-server-note'));
    expect(html).toMatch(
      /<details class="disclosure group-advanced" data-testid="group-advanced">/,
    );
  });

  it('own server switched on: says so, opens the section, offers Test connection', () => {
    const html = render(state('wss://nas.example.org/signal'));
    for (const id of [
      'group-create',
      'group-own-server-note',
      'group-server',
      'group-server-test',
    ]) {
      expect(html).toContain(testId(id));
    }
    expect(html).toMatch(/data-testid="group-advanced" open=""/);
    expect(html).toContain('nas.example.org');
    expect(html).not.toContain(testId('group-local-note'));
  });

  it('own server switched on without an address: the form, no doomed Create in an error', () => {
    const html = render(state('', { phase: 'idle' }, true));
    expect(html).toContain(testId('group-server-input'));
    expect(html).toMatch(/data-testid="group-server-test" disabled=""/);
    expect(render(state('signal.example.org'))).toContain(testId('group-server-invalid'));
  });

  it('warns that a server on this computer or the home network is limited', () => {
    expect(render(state('ws://127.0.0.1:8787'))).toContain(testId('group-local-note'));
    expect(render(state('ws://192.168.1.20:8080/signal'))).toContain(testId('group-lan-note'));
  });

  it('says what it is doing while connecting', () => {
    expect(render(state('', { phase: 'connecting', action: 'create' }))).toContain(
      'Opening a ride',
    );
    expect(render(state('wss://x.example', { phase: 'connecting', action: 'create' }))).toContain(
      'Opening a room on your server',
    );
    expect(render(state('', { phase: 'connecting', action: 'join' }))).toContain(
      'Joining the ride',
    );
  });

  it('shows a failure in plain words with what to do, and keeps the input', () => {
    const failure = describeGroupFailure('no-relay', { action: 'join' });
    const html = render(
      state('', { phase: 'error', message: failure.title, failure, action: 'join', input: INVITE }),
    );
    expect(html).toContain('data-failure="no-relay"');
    expect(html).toContain('No relay server reachable');
    expect(html).toContain('What to do');
    expect(html).toContain(`value="${INVITE}"`);
    // Relays need no setup: a new ride can always be tried.
    expect(html).toContain(testId('group-create'));

    const ownFailure = describeGroupFailure('unreachable', {
      signallingUrl: 'wss://nas.example.org/signal',
      action: 'join',
    });
    const own = render(
      state(
        '',
        { phase: 'error', message: '', failure: ownFailure, action: 'join', input: LINK },
        true,
      ),
    );
    expect(own).toContain('Nothing answered at nas.example.org');
    expect(own).toContain(`value="${LINK.replace(/&/g, '&amp;')}"`);
    // Own server switched on but not set up: no Create button that would fail again.
    expect(own).not.toContain(testId('group-create'));

    const hostFailure = describeGroupFailure('not-signalling', {
      probe: { kind: 'wrong-path', suggestion: 'wss://nas.example.org/signal' },
      action: 'create',
    });
    const host = render(
      state('wss://nas.example.org', {
        phase: 'error',
        message: '',
        failure: hostFailure,
        action: 'create',
        input: '',
      }),
    );
    expect(host).toContain(testId('group-create'));
    expect(host).toContain('Try again');
    expect(host).toContain(testId('group-use-suggestion'));
  });

  it('joined over relays: the invite link first, the full code, relay state and notes', () => {
    const html = render(
      state(
        '',
        joined({
          role: 'guest',
          relay: 'connecting',
          peers: [
            { peerId: 'p1', name: 'Ben', state: 'connected' },
            { peerId: 'p2', name: 'Rider', state: 'connected' },
          ],
          notes: [{ code: 'secret-mismatch', text: 'Someone tried to join with another secret.' }],
        }),
      ),
    );
    expect(html.indexOf(testId('group-link'))).toBeLessThan(html.indexOf(testId('group-code')));
    expect(html).toContain(INVITE);
    expect(html).toContain('Friends only need this link.');
    expect(html).toContain('ABC-DEF-GHJK-MNPQ-RSTU');
    expect(html).toContain('the first six characters alone do not work');
    expect(html).toContain('data-testid="group-relay-state" data-state="connecting"');
    expect(html).toContain('Looking for the relay servers');
    expect(html).toContain('data-code="secret-mismatch"');
    expect(html).toContain(testId('group-how'));
    expect(html).not.toContain(testId('group-server'));
    expect(html).not.toContain(testId('group-advanced'));
    const ready = render(state('', joined()));
    expect(ready).toContain('friends with the invite can find you');
  });

  it('joined on an own server: per-rider status, the server, the old code hint', () => {
    const html = render(
      state(
        '',
        joined({
          transport: 'self-hosted',
          joinLink: LINK,
          inviteCode: 'ABC-DEF',
          role: 'guest',
          signallingUrl: 'wss://nas.example.org/signal',
          peers: [
            { peerId: 'p1', name: 'Ben', state: 'connected' },
            { peerId: 'p2', name: 'Cleo', state: 'trouble' },
            { peerId: 'p3', name: 'Dan', state: 'connecting' },
          ],
        }),
      ),
    );
    expect(html).toContain(testId('group-copy-link'));
    expect(html).toContain('ABC-DEF');
    expect(html).toContain(testId('group-leave'));
    expect(html).toContain(testId('group-riders'));
    expect(html).toContain('data-state="connected"');
    expect(html).toContain('data-state="trouble"');
    expect(html).toContain('data-state="connecting"');
    expect(html).toContain(testId('group-peer-trouble'));
    expect(html).toContain('Cannot reach Cleo directly.');
    expect(html).toContain('restrictive network');
    expect(html).toContain('(from the invite link)');
    expect(html).toContain('A code alone only works for friends who have set up the same server.');
    expect(html).not.toContain(testId('group-relay-state'));
    expect(html).not.toContain(testId('group-empty'));
  });

  it('joined alone: hosts wait; guests get the hint that fits the transport', () => {
    expect(render(state('', joined({ role: 'host' })))).toContain('Waiting for friends');
    const guest = render(state('', joined({ role: 'guest' })));
    expect(guest).toContain('Nobody else is here yet');
    expect(guest).toContain('current ride');
    const own = render(
      state('', joined({ role: 'guest', transport: 'self-hosted', signallingUrl: 'wss://x' })),
    );
    expect(own).toContain('a wrong code simply opens a new, empty room');
    expect(own).not.toContain(testId('group-peer-trouble'));
  });
});
