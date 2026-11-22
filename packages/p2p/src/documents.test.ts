import { describe, expect, it } from 'vitest';
import {
  contentHash,
  decodeDocMessage,
  DOC_SERVE_BUDGET,
  encodeChunks,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_PEER,
  SharedDocuments,
  utf8Length,
  type DocumentEvent,
  type StartAnnouncement,
} from './documents';
import { decodeStateMessage, encodeStateMessage } from './riderState';
import { FakeClock } from './testing';

const SAMPLE = 'Sweet spot 3×12 "quoted" \\ back\nslash\ttab \u0001 ctrl — 🚴‍♀️ emoji ünïcödé';

function engine(maxMessageBytes?: number) {
  const clock = new FakeClock();
  const sent: Array<{ to: string | '*'; data: string }> = [];
  const docs = new SharedDocuments({
    send: (to, data) => {
      sent.push({ to, data });
      return true;
    },
    broadcast: (data) => {
      sent.push({ to: '*', data });
      return 1;
    },
    peerName: (id) => `name-${id}`,
    now: clock.now,
    timers: clock.timers,
    maxMessageBytes,
  });
  const events: DocumentEvent[] = [];
  const starts: StartAnnouncement[] = [];
  docs.on('document', (e) => events.push(e));
  docs.on('start', (s) => starts.push(s));
  const parsed = () => sent.map((s) => ({ to: s.to, msg: decodeDocMessage(s.data) }));
  return { clock, sent, docs, events, starts, parsed };
}

function listMsg(sid: string, rev: number, docs: Array<{ k: string; text: string; c?: number }>) {
  return JSON.stringify({
    v: 1,
    type: 'doc-list',
    sid,
    rev,
    docs: docs.map((d) => ({
      k: d.k,
      id: contentHash(d.text),
      n: utf8Length(d.text),
      c: d.c ?? 1,
    })),
  });
}

function chunkMsg(k: string, text: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    type: 'doc-chunk',
    k,
    id: contentHash(text),
    n: utf8Length(text),
    c: 1,
    i: 0,
    d: text,
    ...overrides,
  });
}

describe('content hash and UTF-8 helpers', () => {
  it('is stable, 16 hex digits and sensitive to every character', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hellp'));
    expect(contentHash('ab')).not.toBe(contentHash('ba'));
    expect(contentHash('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('counts UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('ü')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('🚴')).toBe(4);
    expect(utf8Length('\ud800')).toBe(3); // lone surrogate
  });
});

describe('chunk encoding', () => {
  it('splits into messages within the byte limit that reassemble exactly', () => {
    const text = SAMPLE.repeat(40);
    for (const limit of [200, 333, 1100, 16 * 1024]) {
      const chunks = encodeChunks('workout', contentHash(text), text, limit);
      expect(chunks).not.toBeNull();
      const decoded = chunks!.map((c) => {
        expect(utf8Length(c)).toBeLessThanOrEqual(limit);
        const m = decodeDocMessage(c);
        if (m?.type !== 'doc-chunk') throw new Error('not a chunk');
        return m;
      });
      expect(decoded.every((m) => m.c === chunks!.length)).toBe(true);
      expect(decoded.map((m) => m.d).join('')).toBe(text);
      if (limit < 2000) expect(chunks!.length).toBeGreaterThan(1);
    }
  });

  it('never splits a surrogate pair', () => {
    const text = '🚴'.repeat(500);
    const chunks = encodeChunks('x', contentHash(text), text, 220)!;
    for (const c of chunks) {
      const m = decodeDocMessage(c);
      if (m?.type !== 'doc-chunk') throw new Error('not a chunk');
      expect(m.d.length % 2).toBe(0);
    }
  });

  it('refuses documents that would need too many chunks', () => {
    const text = '\u0001'.repeat(MAX_DOCUMENT_BYTES); // 6 bytes each once escaped
    expect(encodeChunks('x', contentHash(text), text, 200)).toBeNull();
  });
});

describe('message decoding', () => {
  it('accepts well-formed messages and ignores extra fields', () => {
    expect(decodeDocMessage(listMsg('abcd1234', 1, [{ k: 'workout', text: 'x' }]))).toMatchObject({
      type: 'doc-list',
      docs: [{ k: 'workout', n: 1, c: 1 }],
    });
    const withExtra = JSON.parse(chunkMsg('workout', 'hi')) as Record<string, unknown>;
    withExtra['future'] = { anything: true };
    expect(decodeDocMessage(JSON.stringify(withExtra))).toMatchObject({
      type: 'doc-chunk',
      d: 'hi',
    });
  });

  it('rejects malformed, oversized and unknown messages without throwing', () => {
    const id = contentHash('x');
    const bad: unknown[] = [
      null,
      42,
      '',
      'not json "doc-list"',
      '{"v":1,"type":"doc-list"',
      JSON.stringify({ v: 2, type: 'doc-list', sid: 'abcd', rev: 1, docs: [] }),
      JSON.stringify({ v: 1, type: 'doc-future', x: 1 }),
      JSON.stringify({ v: 1, type: 'doc-list', sid: 'AB', rev: 1, docs: [] }),
      JSON.stringify({ v: 1, type: 'doc-list', sid: 'abcd', rev: 0, docs: [] }),
      JSON.stringify({ v: 1, type: 'doc-list', sid: 'abcd', rev: 1, docs: {} }),
      JSON.stringify({
        v: 1,
        type: 'doc-list',
        sid: 'abcd',
        rev: 1,
        docs: [
          { k: 'a', id, n: 1, c: 1 },
          { k: 'a', id, n: 1, c: 1 }, // duplicate kind
        ],
      }),
      JSON.stringify({
        v: 1,
        type: 'doc-list',
        sid: 'abcd',
        rev: 1,
        docs: [{ k: 'A', id, n: 1, c: 1 }],
      }),
      JSON.stringify({
        v: 1,
        type: 'doc-list',
        sid: 'abcd',
        rev: 1,
        docs: [{ k: 'a', id: 'zz', n: 1, c: 1 }],
      }),
      JSON.stringify({
        v: 1,
        type: 'doc-list',
        sid: 'abcd',
        rev: 1,
        docs: [{ k: 'a', id, n: MAX_DOCUMENT_BYTES + 1, c: 1 }],
      }),
      JSON.stringify({
        v: 1,
        type: 'doc-list',
        sid: 'abcd',
        rev: 1,
        docs: [{ k: 'a', id, n: 2, c: 3 }],
      }),
      JSON.stringify({
        v: 1,
        type: 'doc-list',
        sid: 'abcd',
        rev: 1,
        docs: Array.from({ length: 17 }, (_, i) => ({ k: `k${i}`, id, n: 1, c: 1 })),
      }),
      JSON.stringify({ v: 1, type: 'doc-req', k: 'a', id, m: [] }),
      JSON.stringify({ v: 1, type: 'doc-req', k: 'a', id, m: [-1] }),
      JSON.stringify({ v: 1, type: 'doc-req', k: 'a', id, m: [1.5] }),
      JSON.stringify({ v: 1, type: 'doc-req', k: 'a', id, m: new Array(200).fill(0) }),
      chunkMsg('a', 'x', { i: 1 }),
      chunkMsg('a', 'x', { d: '' }),
      chunkMsg('a', 'x', { d: 5 }),
      chunkMsg('a', 'x', { c: 0 }),
      chunkMsg('a', 'x', { n: Number.NaN }),
      chunkMsg('a', 'xy', { n: 1 }),
      JSON.stringify({ v: 1, type: 'doc-start', a: 'abcd', k: 'a', id, in: -1 }),
      JSON.stringify({ v: 1, type: 'doc-start', a: 'abcd', k: 'a', id, in: 1e12 }),
      JSON.stringify({ v: 1, type: 'doc-start', a: '!', k: 'a', id, in: 10 }),
      `{"v":1,"type":"doc-chunk","d":"${'x'.repeat(17_000)}"}`,
    ];
    for (const raw of bad) expect(decodeDocMessage(raw)).toBeNull();
  });

  it('old and new message types do not leak into each other', () => {
    const state = encodeStateMessage({
      name: 'A',
      sentAt: 1,
      distanceM: 1,
      speedMps: 1,
      powerW: 1,
      cadenceRpm: 1,
      heartRateBpm: null,
      gear: 1,
    });
    expect(decodeDocMessage(state)).toBeNull();
    const text = SAMPLE;
    const docMessages = [
      listMsg('abcd1234', 1, [{ k: 'workout', text }]),
      JSON.stringify({ v: 1, type: 'doc-req', k: 'workout', id: contentHash(text) }),
      ...encodeChunks('workout', contentHash(text), text, 1100)!,
      JSON.stringify({
        v: 1,
        type: 'doc-start',
        a: 'abcd',
        k: 'workout',
        id: contentHash(text),
        in: 5,
      }),
    ];
    for (const m of docMessages) {
      expect(decodeDocMessage(m)).not.toBeNull();
      expect(decodeStateMessage(m)).toBeNull(); // what an old client does with it
    }
  });
});

describe('SharedDocuments engine (defensive handling)', () => {
  it('requests, verifies and stores a document; resets on a hash mismatch', () => {
    const { clock, docs, events, parsed, sent } = engine();
    expect(docs.handleMessage('p1', listMsg('sess1', 1, [{ k: 'workout', text: 'hello' }]))).toBe(
      true,
    );
    expect(parsed()).toEqual([
      { to: 'p1', msg: { v: 1, type: 'doc-req', k: 'workout', id: contentHash('hello') } },
    ]);
    // A corrupted chunk (right length, wrong content) does not verify.
    docs.handleMessage('p1', chunkMsg('workout', 'hello', { d: 'hellp' }));
    expect(docs.getShared()).toEqual([]);
    expect(events).toEqual([]);
    sent.length = 0;
    clock.advance(500);
    expect(parsed().filter((s) => s.msg?.type === 'doc-req')).toHaveLength(1); // re-requested
    docs.handleMessage('p1', chunkMsg('workout', 'hello'));
    expect(docs.getShared()).toEqual([
      expect.objectContaining({
        peerId: 'p1',
        peerName: 'name-p1',
        kind: 'workout',
        text: 'hello',
      }),
    ]);
    expect(events).toEqual([
      { type: 'available', document: expect.objectContaining({ text: 'hello' }) },
    ]);
    // Duplicates and reordered old lists change nothing.
    docs.handleMessage('p1', chunkMsg('workout', 'hello'));
    docs.handleMessage('p1', listMsg('sess1', 1, []));
    expect(docs.getShared()).toHaveLength(1);
    expect(events).toHaveLength(1);
    // Requests stop once complete.
    sent.length = 0;
    clock.advance(10_000);
    expect(parsed().filter((s) => s.msg?.type === 'doc-req')).toEqual([]);
  });

  it('ignores unsolicited and inconsistent chunks', () => {
    const { docs, events } = engine();
    docs.handleMessage('p1', chunkMsg('workout', 'hello')); // nobody asked
    docs.handleMessage('p1', listMsg('sess1', 1, [{ k: 'workout', text: 'hello' }]));
    docs.handleMessage('p2', chunkMsg('workout', 'hello')); // wrong sender
    docs.handleMessage('p1', chunkMsg('workout', 'other')); // wrong id
    docs.handleMessage('p1', chunkMsg('workout', 'hello', { c: 2, n: 5 })); // wrong chunk count
    expect(docs.getShared()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('enforces the per-peer caps on kinds and bytes', () => {
    const { docs, parsed } = engine();
    const many = Array.from({ length: 6 }, (_, i) => ({ k: `kind-${i}`, text: `doc ${i}` }));
    docs.handleMessage('p1', listMsg('sess1', 1, many));
    const requested = parsed().filter((s) => s.msg?.type === 'doc-req');
    expect(requested).toHaveLength(MAX_DOCUMENTS_PER_PEER);

    const big = (ch: string) => ch.repeat(15 * 1024); // 2 fit into 32 KiB, 3 do not
    const e2 = engine();
    e2.docs.handleMessage(
      'p1',
      listMsg('sess1', 1, [
        { k: 'a', text: big('a'), c: 16 },
        { k: 'b', text: big('b'), c: 16 },
        { k: 'c', text: big('c'), c: 16 }, // would exceed 32 KiB per peer
        { k: 'd', text: 'small' },
      ]),
    );
    const kinds = e2
      .parsed()
      .map((s) => (s.msg?.type === 'doc-req' ? s.msg.k : null))
      .filter(Boolean);
    expect(kinds).toEqual(['a', 'b', 'd']);
  });

  it('limits concurrent transfers across peers', () => {
    const { docs, parsed } = engine();
    for (let p = 0; p < 6; p++) {
      const list = Array.from({ length: 4 }, (_, i) => ({ k: `k${i}`, text: `p${p} d${i}` }));
      docs.handleMessage(`p${p}`, listMsg('sess1', 1, list));
    }
    expect(parsed().filter((s) => s.msg?.type === 'doc-req')).toHaveLength(16);
  });

  it('rate-limits answers per requesting peer', () => {
    const { clock, docs, sent } = engine();
    const text = 'x'.repeat(MAX_DOCUMENT_BYTES);
    const shared = docs.share('workout', text);
    if (!shared.ok) throw new Error(shared.reason);
    const req = JSON.stringify({ v: 1, type: 'doc-req', k: 'workout', id: shared.id });
    sent.length = 0;
    for (let i = 0; i < 20; i++) docs.handleMessage('p1', req);
    const bytes = sent.reduce((sum, s) => sum + utf8Length(s.data), 0);
    expect(bytes).toBeLessThanOrEqual(DOC_SERVE_BUDGET.burstBytes);
    expect(bytes).toBeGreaterThan(DOC_SERVE_BUDGET.burstBytes - 2_000);
    // Another peer has its own budget; the first one refills over time.
    sent.length = 0;
    docs.handleMessage('p2', req);
    expect(sent.length).toBeGreaterThan(10);
    sent.length = 0;
    clock.advance(1_000);
    docs.handleMessage('p1', req);
    const refill = sent.filter((s) => s.to === 'p1').reduce((n, s) => n + utf8Length(s.data), 0);
    expect(refill).toBeLessThanOrEqual(DOC_SERVE_BUDGET.bytesPerSecond + 1_100);
    expect(refill).toBeGreaterThan(0);
    // Requests for unknown documents are ignored.
    sent.length = 0;
    docs.handleMessage(
      'p3',
      JSON.stringify({ v: 1, type: 'doc-req', k: 'workout', id: contentHash('?') }),
    );
    docs.handleMessage('p3', JSON.stringify({ v: 1, type: 'doc-req', k: 'other', id: shared.id }));
    expect(sent).toEqual([]);
  });

  it('answers only the requested missing chunks', () => {
    const { docs, parsed, sent } = engine(250);
    const shared = docs.share('workout', SAMPLE.repeat(5));
    if (!shared.ok) throw new Error(shared.reason);
    sent.length = 0;
    docs.handleMessage(
      'p1',
      JSON.stringify({ v: 1, type: 'doc-req', k: 'workout', id: shared.id, m: [2, 0, 2, 99] }),
    );
    expect(parsed().map((s) => (s.msg?.type === 'doc-chunk' ? s.msg.i : -1))).toEqual([2, 0]);
  });

  it('survives garbage input', () => {
    const { docs } = engine();
    const garbage = [
      '"doc-list"',
      '[1,2,"doc-req"]',
      '{"v":1,"type":"doc-list","sid":"abcd","rev":1,"docs":[null]}',
      '{"__proto__":{"polluted":1},"v":1,"type":"doc-req","k":"a","id":"0000000000000000"}',
      '\u0000"doc-'.repeat(100),
    ];
    for (const g of garbage) expect(() => docs.handleMessage('p1', g)).not.toThrow();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(docs.getShared()).toEqual([]);
  });

  it('de-duplicates start announcements and keeps the earliest consistent estimate', () => {
    const { clock, docs, starts } = engine();
    const id = contentHash('w');
    const start = (a: string, inMs: number, k = 'workout') =>
      JSON.stringify({ v: 1, type: 'doc-start', a, k, id, in: inMs });
    const t0 = clock.now();
    docs.handleMessage('p1', start('ann1', 5_000));
    expect(starts).toEqual([
      expect.objectContaining({
        announceId: 'ann1',
        peerId: 'p1',
        startsInMs: 5_000,
        startsAt: t0 + 5_000,
      }),
    ]);
    clock.advance(250);
    docs.handleMessage('p1', start('ann1', 4_700)); // arrived faster: earlier estimate
    docs.handleMessage('p1', start('ann1', 4_750)); // duplicate/late
    docs.handleMessage('p1', start('ann1', 100)); // inconsistent: ignored
    docs.handleMessage('p1', start('ann1', 4_700, 'other')); // inconsistent kind: ignored
    expect(starts).toHaveLength(1);
    expect(docs.getStarts()).toEqual([expect.objectContaining({ startsAt: t0 + 250 + 4_700 })]);
    for (let i = 0; i < 20; i++) docs.handleMessage('p1', start(`many${i}`, 1_000));
    expect(docs.getStarts().length).toBeLessThanOrEqual(8);
    clock.advance(30_000);
    expect(docs.getStarts()).toEqual([]);
  });
});
