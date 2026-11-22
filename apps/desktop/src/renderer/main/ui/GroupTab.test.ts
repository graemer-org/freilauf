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

function state(signallingUrl: string, group: AppState['group'] = { phase: 'idle' }): AppState {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.group.signallingUrl = signallingUrl;
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

describe('Group tab (SSR)', () => {
  it('without a server: explains and offers "invited" and "host", no doomed Create button', () => {
    const html = render(state(''));
    for (const id of [
      'group-setup',
      'group-path-join',
      'group-path-host',
      'group-join-input',
      'group-join',
      'group-server-input',
      'group-server-test',
      'group-server-save',
      'group-use-local',
    ]) {
      expect(html).toContain(testId(id));
    }
    expect(html).not.toContain(testId('group-create'));
    expect(html).not.toContain(testId('group-server'));
    expect(html).toContain('A friend invited me');
    expect(html).toContain('I want to host');
    expect(html).toContain('nothing to set up');
    expect(html).toContain('ride data never goes through it');
    expect(html).toContain(`href="${GROUP_GUIDE_URL}"`);
    expect(html).toContain('Use a server on this computer (for testing)');
    expect(html).toContain('pnpm signalling');
    // Test and Save stay disabled until an address is entered.
    expect(html).toMatch(/data-testid="group-server-test" disabled=""/);
  });

  it('shows an invalid saved address in the setup state', () => {
    const html = render(state('signal.example.org'));
    expect(html).toContain(testId('group-setup'));
    expect(html).toContain(testId('group-server-invalid'));
    expect(html).toContain('value="signal.example.org"');
  });

  it('with a server: Create, Join, the address with Test connection', () => {
    const html = render(state('wss://nas.example.org/signal'));
    for (const id of [
      'group-create',
      'group-join-input',
      'group-join',
      'group-server',
      'group-server-test',
    ]) {
      expect(html).toContain(testId(id));
    }
    expect(html).not.toContain(testId('group-setup'));
    expect(html).not.toContain(testId('group-local-note'));
    expect(html).toContain('Only the host needs a server set here');
  });

  it('warns that a server on this computer or the home network is limited', () => {
    expect(render(state('ws://127.0.0.1:8787'))).toContain(testId('group-local-note'));
    expect(render(state('ws://192.168.1.20:8080/signal'))).toContain(testId('group-lan-note'));
  });

  it('says what it is doing while connecting', () => {
    expect(render(state('wss://x.example', { phase: 'connecting', action: 'create' }))).toContain(
      'Opening a room on your server',
    );
    expect(render(state('', { phase: 'connecting', action: 'join' }))).toContain(
      'Joining the ride',
    );
  });

  it('shows a failure in plain words with what to do, and keeps the input', () => {
    const failure = describeGroupFailure('unreachable', {
      signallingUrl: 'wss://nas.example.org/signal',
      action: 'join',
    });
    const html = render(
      state('', { phase: 'error', message: failure.title, failure, action: 'join', input: LINK }),
    );
    expect(html).toContain('data-failure="unreachable"');
    expect(html).toContain('Server not reachable');
    expect(html).toContain('Nothing answered at nas.example.org');
    expect(html).toContain('What to do');
    expect(html).toContain(`value="${LINK.replace(/&/g, '&amp;')}"`);
    // No server of our own: no Create button that would fail again.
    expect(html).not.toContain(testId('group-create'));

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

  it('joined: the invite link first, the code, and per-rider connection status', () => {
    const html = render(
      state('', {
        phase: 'joined',
        roomCode: 'ABCDEF',
        joinLink: LINK,
        role: 'guest',
        signallingUrl: 'wss://nas.example.org/signal',
        peers: [
          { peerId: 'p1', name: 'Ben', state: 'connected' },
          { peerId: 'p2', name: 'Cleo', state: 'trouble' },
          { peerId: 'p3', name: 'Dan', state: 'connecting' },
        ],
      }),
    );
    expect(html.indexOf(testId('group-link'))).toBeLessThan(html.indexOf(testId('group-code')));
    expect(html).toContain('Friends only need this link.');
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
    expect(html).not.toContain(testId('group-empty'));
  });

  it('joined alone: hosts wait, guests learn that a wrong code opens an empty room', () => {
    const joined = (role: 'host' | 'guest'): AppState['group'] => ({
      phase: 'joined',
      roomCode: 'ABCDEF',
      joinLink: LINK,
      role,
      signallingUrl: 'wss://nas.example.org/signal',
      peers: [],
    });
    expect(render(state('wss://nas.example.org/signal', joined('host')))).toContain(
      'Waiting for friends',
    );
    const guest = render(state('wss://nas.example.org/signal', joined('guest')));
    expect(guest).toContain('Nobody else is here yet');
    expect(guest).toContain('a wrong code simply opens a new, empty room');
    expect(guest).not.toContain(testId('group-peer-trouble'));
  });
});
