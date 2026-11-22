import {
  buildInviteLink,
  formatInviteCode,
  generateInviteSecret,
  GroupError,
  SignallingError,
} from '@freilauf/p2p';
import { describe, expect, it } from 'vitest';
import {
  classifyGroupError,
  describeProbe,
  describeGroupFailure,
  emptyRoomHint,
  GroupSetupError,
  groupNotes,
  PEER_TROUBLE_AFTER_MS,
  peerViews,
  relayStateFrom,
  resolveHostTarget,
  resolveJoinTarget,
  type GroupSettings,
  serverLabel,
  signallingUrlKind,
  signallingUrlProblem,
  type GroupFailureKind,
} from './groupConnection';

const LINK = 'freilauf://join/ABCDEF?s=wss%3A%2F%2Fnas.example.org%2Fsignal';

describe('signallingUrlKind', () => {
  it('tells none, invalid, local, lan and remote apart', () => {
    expect(signallingUrlKind('')).toBe('none');
    expect(signallingUrlKind('   ')).toBe('none');
    expect(signallingUrlKind('nas.example.org')).toBe('invalid');
    expect(signallingUrlKind('https://nas.example.org')).toBe('invalid');
    expect(signallingUrlKind('ws://')).toBe('invalid');
    for (const url of [
      'ws://localhost:8787',
      'ws://127.0.0.1:8787',
      'ws://[::1]:8787',
      'ws://app.localhost/signal',
    ]) {
      expect(signallingUrlKind(url)).toBe('local');
    }
    for (const url of [
      'ws://192.168.1.20:8080/signal',
      'ws://10.0.0.5',
      'ws://172.20.1.1',
      'ws://nas.local:8080/signal',
    ]) {
      expect(signallingUrlKind(url)).toBe('lan');
    }
    expect(signallingUrlKind('ws://172.40.1.1')).toBe('remote');
    expect(signallingUrlKind('wss://freilauf.example.org/signal')).toBe('remote');
  });

  it('labels a server by host only', () => {
    expect(serverLabel('wss://user:pw@nas.example.org:8443/signal')).toBe('nas.example.org:8443');
  });
});

describe('signallingUrlProblem', () => {
  it('accepts ws:// and wss:// addresses', () => {
    expect(signallingUrlProblem('wss://nas.example.org/signal')).toBeNull();
    expect(signallingUrlProblem(' ws://127.0.0.1:8787 ')).toBeNull();
  });

  it('explains what to change', () => {
    expect(signallingUrlProblem('')).toMatch(/Enter the address/);
    expect(signallingUrlProblem('https://nas.example.org/signal')).toBe(
      'Use wss:// instead of https:// — e.g. wss://nas.example.org/signal',
    );
    expect(signallingUrlProblem('http://nas:8080/signal')).toMatch(/^Use ws:\/\/ instead of http/);
    expect(signallingUrlProblem('nas.example.org/signal')).toBe(
      'Start the address with wss:// — e.g. wss://nas.example.org/signal',
    );
    expect(signallingUrlProblem('ftp://x')).toMatch(/must start with wss/);
    expect(signallingUrlProblem('wss://a b')).toMatch(/spaces/);
  });
});

const RELAYS: GroupSettings = { useOwnServer: false, signallingUrl: '', relayUrls: [] };
const own = (signallingUrl: string): GroupSettings => ({
  useOwnServer: true,
  signallingUrl,
  relayUrls: [],
});
const SECRET = generateInviteSecret('ABCDEF');
const INVITE = buildInviteLink('ABCDEF', SECRET);

describe('resolveJoinTarget', () => {
  const kind = (input: string, settings: GroupSettings): GroupFailureKind | null => {
    try {
      resolveJoinTarget(input, settings);
      return null;
    } catch (err) {
      return err instanceof GroupSetupError ? err.kind : null;
    }
  };

  it('a relay invite (link or full code) joins over the relays, whatever is configured', () => {
    for (const settings of [RELAYS, own('wss://mine.example.org')]) {
      for (const input of [INVITE, formatInviteCode('ABCDEF', SECRET)]) {
        expect(resolveJoinTarget(input, settings)).toEqual({
          transport: 'relays',
          roomCode: 'ABCDEF',
          secret: SECRET,
          relayUrls: [],
          input,
        });
      }
    }
    const custom = { ...RELAYS, relayUrls: ['wss://relay.example'] };
    expect(resolveJoinTarget(INVITE, custom)).toMatchObject({ relayUrls: ['wss://relay.example'] });
  });

  it('finds the link inside a longer message', () => {
    const t = resolveJoinTarget(`Ride with me tonight: ${INVITE} see you!`, RELAYS);
    expect(t).toMatchObject({ roomCode: 'ABCDEF', secret: SECRET, input: INVITE });
  });

  it('an old-style link takes its server from the link, whatever is configured', () => {
    for (const settings of [RELAYS, own('wss://mine.example.org')]) {
      expect(resolveJoinTarget(LINK, settings)).toEqual({
        transport: 'self-hosted',
        roomCode: 'ABCDEF',
        signallingUrl: 'wss://nas.example.org/signal',
        fromLink: true,
        input: LINK,
      });
    }
  });

  it('a bare code uses the own server when switched on', () => {
    expect(resolveJoinTarget('abc-def', own('wss://mine.example.org'))).toMatchObject({
      transport: 'self-hosted',
      roomCode: 'ABCDEF',
      signallingUrl: 'wss://mine.example.org',
      fromLink: false,
    });
  });

  it('a bare code alone lacks the secret; typos and garbage are told apart', () => {
    expect(kind('ABC-DEF', RELAYS)).toBe('secret-missing');
    // A link without a server or secret behaves like a bare code.
    expect(kind('freilauf://join/ABCDEF', RELAYS)).toBe('secret-missing');
    expect(kind('ABC-DEF', own(''))).toBe('no-server');
    expect(kind('ABC-DEF', own('nonsense'))).toBe('invalid-server');
    expect(kind('hello', RELAYS)).toBe('invalid-invite');
    const typo = INVITE.slice(0, -1) + (INVITE.endsWith('A') ? 'B' : 'A');
    expect(kind(typo, RELAYS)).toBe('invite-typo');
    expect(kind(`Join: ${typo}`, RELAYS)).toBe('invite-typo');
  });
});

describe('resolveHostTarget', () => {
  it('relays by default, the own server when switched on', () => {
    expect(resolveHostTarget(RELAYS)).toEqual({ transport: 'relays', relayUrls: [] });
    // A saved address alone does not switch anything.
    expect(resolveHostTarget({ ...RELAYS, signallingUrl: 'wss://x.example' })).toEqual({
      transport: 'relays',
      relayUrls: [],
    });
    expect(resolveHostTarget(own(' wss://x.example '))).toEqual({
      transport: 'self-hosted',
      signallingUrl: 'wss://x.example',
    });
    expect(() => resolveHostTarget(own(''))).toThrow(GroupSetupError);
  });
});

describe('classifyGroupError', () => {
  const timeout = new SignallingError('join-timeout', 'Could not reach the signalling server.');

  it('maps signalling errors and setup errors', () => {
    expect(classifyGroupError(new SignallingError('room-full', 'full'))).toBe('room-full');
    expect(classifyGroupError(new SignallingError('invalid-room', 'x'))).toBe('invalid-invite');
    expect(classifyGroupError(new GroupSetupError('no-server', 'x'))).toBe('no-server');
    expect(classifyGroupError(new Error('boom'))).toBe('unknown');
  });

  it('maps relay failures', () => {
    const noRelay = new GroupError('no-relay', 'none answered');
    expect(classifyGroupError(noRelay)).toBe('no-relay');
    expect(classifyGroupError(noRelay, { online: false })).toBe('offline');
    expect(classifyGroupError({ code: 'no-relay', message: 'x' })).toBe('no-relay');
    expect(classifyGroupError(new GroupError('invalid-secret', 'x'))).toBe('invite-typo');
    expect(classifyGroupError(new GroupError('room-full', 'x'))).toBe('room-full');
    expect(classifyGroupError(new GroupError('relay-unavailable', 'x'))).toBe('unknown');
  });

  it('uses the probe to explain a timeout', () => {
    expect(classifyGroupError(timeout)).toBe('unreachable');
    expect(classifyGroupError(timeout, { probe: { kind: 'unreachable' } })).toBe('unreachable');
    expect(classifyGroupError(timeout, { probe: { kind: 'not-signalling' } })).toBe(
      'not-signalling',
    );
    expect(
      classifyGroupError(timeout, { probe: { kind: 'wrong-path', suggestion: 'wss://x/signal' } }),
    ).toBe('not-signalling');
    expect(classifyGroupError(timeout, { probe: { kind: 'invalid', message: 'x' } })).toBe(
      'invalid-server',
    );
    expect(classifyGroupError(timeout, { probe: { kind: 'ok', ms: 5 } })).toBe('unknown');
  });

  it('says offline before anything else that needs the network', () => {
    expect(classifyGroupError(timeout, { online: false })).toBe('offline');
    expect(classifyGroupError(timeout, { probe: { kind: 'offline' } })).toBe('offline');
    // A full room was answered by the server, so the network works.
    expect(classifyGroupError(new SignallingError('room-full', 'x'), { online: false })).toBe(
      'room-full',
    );
  });
});

describe('describeGroupFailure', () => {
  const kinds: GroupFailureKind[] = [
    'no-server',
    'invalid-invite',
    'invite-typo',
    'secret-missing',
    'no-relay',
    'invalid-server',
    'offline',
    'unreachable',
    'not-signalling',
    'room-full',
    'unknown',
  ];

  it('has a title, a message and a next step for every kind, never a raw error', () => {
    for (const kind of kinds) {
      const f = describeGroupFailure(kind, { signallingUrl: 'ws://localhost:8787' });
      expect(f.kind).toBe(kind);
      for (const text of [f.title, f.message, f.next]) {
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/could not connect to localhost|SignallingError|join-timeout/i);
      }
    }
  });

  it('names the server and tailors the next step to host or guest', () => {
    const host = describeGroupFailure('unreachable', {
      signallingUrl: 'wss://nas.example.org/signal',
      action: 'create',
    });
    expect(host.message).toContain('nas.example.org');
    expect(host.next).toMatch(/Test connection/);
    const guest = describeGroupFailure('unreachable', { action: 'join' });
    expect(guest.next).toMatch(/person who sent the invite/);
  });

  it('passes on the /signal suggestion', () => {
    const f = describeGroupFailure('not-signalling', {
      probe: { kind: 'wrong-path', suggestion: 'wss://nas.example.org/signal' },
    });
    expect(f.suggestion).toBe('wss://nas.example.org/signal');
    expect(f.next).toContain('wss://nas.example.org/signal');
  });

  it('room full mentions the limit', () => {
    expect(describeGroupFailure('room-full').message).toContain('8 riders');
  });

  it('no relay: says who runs them and what to try, plainly', () => {
    const f = describeGroupFailure('no-relay');
    expect(f.title).toBe('No relay server reachable');
    expect(f.message).toMatch(/public relay servers run by others/);
    expect(f.next).toMatch(/another network/);
    expect(describeGroupFailure('secret-missing').next).toMatch(/whole invite link/);
  });
});

describe('peerViews', () => {
  it('shows connecting, then trouble after a while or after failed attempts', () => {
    const seen = new Map<string, number>();
    const sample = (status: 'connecting' | 'connected' | 'failed', attempts = 1) => [
      { peerId: 'b', name: 'Ben', status, attempts },
    ];
    expect(peerViews(sample('connecting'), seen, 1000)[0]!.state).toBe('connecting');
    expect(peerViews(sample('connecting'), seen, 1000 + PEER_TROUBLE_AFTER_MS)[0]!.state).toBe(
      'trouble',
    );
    expect(peerViews(sample('connected'), seen, 99_000)[0]!.state).toBe('connected');
    expect(seen.size).toBe(0);
    expect(peerViews(sample('failed'), seen, 100_000)[0]!.state).toBe('trouble');
    expect(peerViews(sample('connecting', 2), new Map(), 0)[0]!.state).toBe('trouble');
    expect(peerViews([], seen, 100_001)).toEqual([]);
    expect(seen.size).toBe(0);
  });
});

describe('emptyRoomHint', () => {
  it('own server: tells a guest that a wrong code opens an empty room', () => {
    const own = emptyRoomHint('guest', 'ABCDEF', 'self-hosted');
    expect(own.message).toMatch(/wrong code.*empty room/);
    expect(own.message).toContain('ABC-DEF');
    expect(emptyRoomHint('host', 'ABCDEF').title).toBe('Waiting for friends');
  });

  it('relays: points at the current invite', () => {
    expect(emptyRoomHint('guest', 'ABCDEF', 'relays').message).toMatch(/current ride/);
  });
});

describe('relay state and notes', () => {
  it('maps transport states and problem codes to plain text', () => {
    expect(relayStateFrom('connecting')).toBe('connecting');
    expect(relayStateFrom('joined')).toBe('ready');
    expect(relayStateFrom('reconnecting')).toBe('reconnecting');
    expect(groupNotes(['secret-mismatch', 'peer-unreachable', 'other']).map((n) => n.code)).toEqual(
      ['peer-unreachable', 'secret-mismatch'],
    );
    expect(groupNotes(['peer-unreachable'])[0]?.text).toMatch(/restrictive network/);
  });
});

describe('describeProbe', () => {
  it('says reachable, not reachable or not a signalling server', () => {
    const url = 'wss://nas.example.org/signal';
    expect(describeProbe({ kind: 'ok', ms: 42 }, url)).toEqual({
      tone: 'ok',
      text: 'Reachable: nas.example.org is a Freilauf signalling server (answered in 42 ms).',
    });
    expect(describeProbe({ kind: 'unreachable' }, url).text).toMatch(/^Not reachable/);
    expect(describeProbe({ kind: 'not-signalling' }, url).text).toMatch(/^Not a signalling server/);
    const wrong = describeProbe(
      { kind: 'wrong-path', suggestion: `${url}` },
      'wss://nas.example.org',
    );
    expect(wrong.suggestion).toBe(url);
    expect(describeProbe({ kind: 'offline' }, url).tone).toBe('error');
    expect(describeProbe({ kind: 'invalid', message: 'x' }, url).tone).toBe('error');
  });
});
