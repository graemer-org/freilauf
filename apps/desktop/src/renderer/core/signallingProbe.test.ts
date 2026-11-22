import { describe, expect, it } from 'vitest';
import type { WebSocketLike } from '@freilauf/p2p';
import { probeSignallingServer, withSignalPath } from './signallingProbe';

type Behaviour = 'signalling' | 'refuse' | 'silent' | 'echo-garbage' | 'hang' | 'throw';

/** A scripted WebSocket: what happens depends on the URL's path. */
function fakeFactory(byUrl: (url: string) => Behaviour) {
  const opened: string[] = [];
  const factory = (url: string): WebSocketLike => {
    const behaviour = byUrl(url);
    if (behaviour === 'throw') throw new SyntaxError(`The URL '${url}' is invalid.`);
    opened.push(url);
    const ws: WebSocketLike = {
      readyState: 0,
      send(data: string) {
        if (behaviour === 'signalling') {
          const msg = JSON.parse(data) as { type: string };
          queueMicrotask(() =>
            ws.onmessage?.({
              data: JSON.stringify({
                type: 'error',
                code: 'invalid-message',
                message: `Unknown message type ${msg.type}.`,
              }),
            }),
          );
        } else if (behaviour === 'echo-garbage') {
          queueMicrotask(() => ws.onmessage?.({ data: '<html>hello</html>' }));
        } else if (behaviour === 'silent') {
          queueMicrotask(() => ws.onclose?.({ code: 1000, reason: '' }));
        }
      },
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    queueMicrotask(() => {
      if (behaviour === 'refuse') {
        ws.onerror?.({});
        ws.onclose?.({ code: 1006, reason: '' });
      } else if (behaviour !== 'hang') {
        ws.onopen?.({});
      }
    });
    return ws;
  };
  return { factory, opened };
}

describe('withSignalPath', () => {
  it('replaces the path with /signal, or returns null when it already is', () => {
    expect(withSignalPath('wss://nas.example')).toBe('wss://nas.example/signal');
    expect(withSignalPath('wss://nas.example:8443/app?x=1')).toBe('wss://nas.example:8443/signal');
    expect(withSignalPath('wss://nas.example/signal')).toBeNull();
    expect(withSignalPath('wss://nas.example/signal/')).toBeNull();
    expect(withSignalPath('not a url')).toBeNull();
  });
});

describe('probeSignallingServer (scripted sockets)', () => {
  it('reports ok when the protocol error comes back', async () => {
    const { factory } = fakeFactory(() => 'signalling');
    const r = await probeSignallingServer('wss://a.example/signal', { createWebSocket: factory });
    expect(r.kind).toBe('ok');
  });

  it('reports unreachable when no socket opens', async () => {
    const { factory } = fakeFactory(() => 'refuse');
    expect(
      await probeSignallingServer('wss://a.example/signal', { createWebSocket: factory }),
    ).toEqual({ kind: 'unreachable' });
  });

  it('reports not-signalling when the other end opens but does not speak the protocol', async () => {
    for (const b of ['echo-garbage', 'silent'] as const) {
      const { factory } = fakeFactory(() => b);
      const r = await probeSignallingServer('wss://a.example/signal', { createWebSocket: factory });
      expect(r).toEqual({ kind: 'not-signalling' });
    }
  });

  it('times out: unreachable if never opened', async () => {
    const { factory } = fakeFactory(() => 'hang');
    const r = await probeSignallingServer('wss://a.example/signal', {
      createWebSocket: factory,
      timeoutMs: 20,
    });
    expect(r).toEqual({ kind: 'unreachable' });
  });

  it('suggests /signal when only that path answers', async () => {
    const { factory, opened } = fakeFactory((url) =>
      url.endsWith('/signal') ? 'signalling' : 'refuse',
    );
    const r = await probeSignallingServer('wss://nas.example', { createWebSocket: factory });
    expect(r).toEqual({ kind: 'wrong-path', suggestion: 'wss://nas.example/signal' });
    expect(opened).toEqual(['wss://nas.example', 'wss://nas.example/signal']);
  });

  it('reports invalid when the WebSocket constructor throws, and offline first', async () => {
    const { factory } = fakeFactory(() => 'throw');
    const r = await probeSignallingServer('wss://a.example/signal', { createWebSocket: factory });
    expect(r.kind).toBe('invalid');
    expect(
      await probeSignallingServer('wss://a.example/signal', {
        createWebSocket: factory,
        online: () => false,
      }),
    ).toEqual({ kind: 'offline' });
  });
});

// Against the real server: apps/desktop/e2e/group.spec.ts (Test connection, open and closed port).
