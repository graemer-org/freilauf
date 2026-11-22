import { describe, expect, it } from 'vitest';
import {
  buildInviteLink,
  buildJoinLink,
  formatInviteCode,
  formatRoomCode,
  generateInviteSecret,
  INVITE_SECRET_LENGTH,
  isValidInviteSecret,
  parseInvite,
  generateRoomCode,
  isValidRoomCode,
  normaliseRoomCode,
  parseJoinLink,
  parseRoomCode,
  ROOM_CODE_ALPHABET,
} from './roomCode';

describe('room codes', () => {
  it('generates valid 6-char codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(code).not.toMatch(/[01OIL]/);
      expect(isValidRoomCode(code)).toBe(true);
    }
    expect(ROOM_CODE_ALPHABET).toHaveLength(31);
  });

  it('uses rejection sampling with an injected random source', () => {
    // 255 >= 248 is rejected, 0 -> 'A', 30 -> '9', 31 -> 'A'
    const bytes = [255, 0, 30, 31, 250, 1, 2, 3];
    let i = 0;
    const random = (n: number) =>
      Uint8Array.from({ length: n }, () => bytes[i++ % bytes.length] ?? 0);
    expect(generateRoomCode(random)).toBe('A9ABCD');
  });

  it('normalises user input', () => {
    expect(normaliseRoomCode(' abc-def ')).toBe('ABCDEF');
    expect(parseRoomCode('abc def')).toBe('ABCDEF');
    expect(parseRoomCode('a_b.c-d e\tf')).toBe('ABCDEF');
    expect(parseRoomCode('ABCDE')).toBeNull();
    expect(parseRoomCode('ABCDEFG')).toBeNull();
    expect(parseRoomCode('ABCDE0')).toBeNull();
    expect(parseRoomCode('ABCDEI')).toBeNull();
    expect(formatRoomCode('ABCDEF')).toBe('ABC-DEF');
  });

  it('builds and parses join links', () => {
    const link = buildJoinLink('abc-def', 'wss://signal.example.org/rooms?x=1');
    expect(link).toBe('freilauf://join/ABCDEF?s=wss%3A%2F%2Fsignal.example.org%2Frooms%3Fx%3D1');
    expect(parseJoinLink(link)).toEqual({
      roomCode: 'ABCDEF',
      signallingUrl: 'wss://signal.example.org/rooms?x=1',
    });
    expect(buildJoinLink('ABCDEF')).toBe('freilauf://join/ABCDEF');
    expect(parseJoinLink('freilauf://join/ABCDEF')).toEqual({ roomCode: 'ABCDEF' });
    expect(() => buildJoinLink('nope')).toThrow();
    expect(() => buildJoinLink('ABCDEF', 'http://x')).toThrow();
  });

  it('accepts bare codes and sloppy links, rejects garbage', () => {
    expect(parseJoinLink('  abc-def ')).toEqual({ roomCode: 'ABCDEF' });
    expect(parseJoinLink('FREILAUF://join/abc-def/?s=ws://localhost:8787')).toEqual({
      roomCode: 'ABCDEF',
      signallingUrl: 'ws://localhost:8787',
    });
    expect(parseJoinLink('freilauf://join/ABCDEF?s=javascript:alert(1)')).toEqual({
      roomCode: 'ABCDEF',
    });
    expect(parseJoinLink('freilauf://join/ABCDEF?s=%E0%A4%A')).toEqual({ roomCode: 'ABCDEF' });
    expect(parseJoinLink('freilauf://join/')).toBeNull();
    expect(parseJoinLink('https://example.com/join/ABCDEF')).toBeNull();
    expect(parseJoinLink('')).toBeNull();
  });
});

describe('invite secrets', () => {
  const code = 'ABCDEF';

  it('generates 12-symbol secrets with a valid check symbol', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const secret = generateInviteSecret(code);
      expect(secret).toMatch(/^[A-HJKMNP-Z2-9]{12}$/);
      expect(isValidInviteSecret(code, secret)).toBe(true);
      expect(isValidInviteSecret('ABCDEG', secret)).toBe(false); // bound to the room code
      seen.add(secret);
    }
    expect(seen.size).toBe(300);
    expect(INVITE_SECRET_LENGTH).toBe(12);
    expect(() => generateInviteSecret('nope')).toThrow();
  });

  it('catches every single wrong symbol and every swap of neighbours', () => {
    const secret = generateInviteSecret(code);
    const all = code + secret;
    for (let i = 0; i < all.length; i++) {
      for (const ch of ROOM_CODE_ALPHABET) {
        if (ch === all[i]) continue;
        const bad = all.slice(0, i) + ch + all.slice(i + 1);
        expect(isValidInviteSecret(bad.slice(0, 6), bad.slice(6))).toBe(false);
      }
      if (i + 1 < all.length && all[i] !== all[i + 1]) {
        const swapped = all.slice(0, i) + all[i + 1] + all[i] + all.slice(i + 2);
        expect(isValidInviteSecret(swapped.slice(0, 6), swapped.slice(6))).toBe(false);
      }
    }
  });

  it('builds the link and the readable code; both parse back', () => {
    const secret = generateInviteSecret(code);
    const link = buildInviteLink('abc-def', secret.toLowerCase());
    expect(link).toBe(`freilauf://join/ABCDEF#${secret}`);
    const readable = formatInviteCode(code, secret);
    expect(readable).toMatch(/^ABC-DEF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const expected = { ok: true, invite: { roomCode: code, secret } };
    expect(parseInvite(link)).toEqual(expected);
    expect(parseInvite(readable)).toEqual(expected);
    expect(parseInvite(` ${readable.toLowerCase().replace(/-/g, ' ')} `)).toEqual(expected);
    expect(parseInvite(`freilauf://join/${readable}`)).toEqual(expected);
    expect(parseInvite(`freilauf://join/abc-def#${secret.slice(0, 4)}-${secret.slice(4)}`)).toEqual(
      expected,
    );
    expect(parseJoinLink(link)).toEqual({ roomCode: code, secret });
    expect(() => buildInviteLink(code, 'ABCDEFGHJKMN')).toThrow();
  });

  it('reports typos instead of opening another room', () => {
    const secret = generateInviteSecret(code);
    const wrong = secret.slice(0, 11) + (secret[11] === 'A' ? 'B' : 'A');
    expect(parseInvite(`freilauf://join/${code}#${wrong}`)).toEqual({ ok: false, reason: 'typo' });
    expect(parseInvite(`freilauf://join/${code}#${secret.slice(0, 10)}`)).toEqual({
      ok: false,
      reason: 'typo',
    });
    expect(parseInvite(formatInviteCode(code, wrong))).toEqual({ ok: false, reason: 'typo' });
    expect(parseInvite(code + secret.slice(1))).toEqual({ ok: false, reason: 'typo' }); // 17
    expect(parseInvite(code + secret + 'A')).toEqual({ ok: false, reason: 'typo' }); // 19
    expect(parseJoinLink(`freilauf://join/${code}#${wrong}`)).toBeNull();
  });

  it('keeps bare codes and legacy self-hosted links working', () => {
    expect(parseInvite('abc-def')).toEqual({ ok: true, invite: { roomCode: code } });
    const legacy = buildJoinLink(code, 'wss://signal.example.org/signal');
    expect(parseInvite(legacy)).toEqual({
      ok: true,
      invite: { roomCode: code, signallingUrl: 'wss://signal.example.org/signal' },
    });
    expect(parseInvite('hello there')).toEqual({ ok: false, reason: 'not-an-invite' });
    expect(parseInvite('freilauf://join/%E0%A4%A')).toEqual({ ok: false, reason: 'not-an-invite' });
  });
});
