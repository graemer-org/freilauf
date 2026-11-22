import { SignallingError } from '@freilauf/p2p';
import { describe, expect, it } from 'vitest';
import {
  classifyGroupError,
  describeProbe,
  describeGroupFailure,
  emptyRoomHint,
  GroupSetupError,
  PEER_TROUBLE_AFTER_MS,
  peerViews,
  resolveHostServer,
  resolveJoinTarget,
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

describe('resolveJoinTarget', () => {
  it('takes the server from the link, whatever is configured', () => {
    for (const configured of ['', 'wss://mine.example.org']) {
      expect(resolveJoinTarget(LINK, configured)).toEqual({
        roomCode: 'ABCDEF',
        signallingUrl: 'wss://nas.example.org/signal',
        fromLink: true,
        input: LINK,
      });
    }
  });

  it('finds the link inside a longer message', () => {
    const t = resolveJoinTarget(`Ride with me tonight: ${LINK} see you!`, '');
    expect(t.roomCode).toBe('ABCDEF');
    expect(t.input).toBe(LINK);
  });

  it('uses the configured server for a bare code', () => {
    expect(resolveJoinTarget('abc-def', 'wss://mine.example.org')).toMatchObject({
      roomCode: 'ABCDEF',
      signallingUrl: 'wss://mine.example.org',
      fromLink: false,
    });
  });

  it('refuses a bare code without a server, and anything that is not an invite', () => {
    const kind = (input: string, url: string): GroupFailureKind | null => {
      try {
        resolveJoinTarget(input, url);
        return null;
      } catch (err) {
        return err instanceof GroupSetupError ? err.kind : null;
      }
    };
    expect(kind('ABC-DEF', '')).toBe('no-server');
    expect(kind('ABC-DEF', 'nonsense')).toBe('invalid-server');
    expect(kind('hello', 'wss://x.example')).toBe('invalid-invite');
    // A link without a server behaves like a bare code.
    expect(kind('freilauf://join/ABCDEF', '')).toBe('no-server');
  });

  it('needs a server to host', () => {
    expect(resolveHostServer(' wss://x.example ')).toBe('wss://x.example');
    expect(() => resolveHostServer('')).toThrow(GroupSetupError);
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
  it('tells a guest that a wrong code opens an empty room', () => {
    expect(emptyRoomHint('guest', 'ABCDEF').message).toMatch(/wrong code.*empty room/);
    expect(emptyRoomHint('guest', 'ABCDEF').message).toContain('ABC-DEF');
    expect(emptyRoomHint('host', 'ABCDEF').title).toBe('Waiting for friends');
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
