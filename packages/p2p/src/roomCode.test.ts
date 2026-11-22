import { describe, expect, it } from 'vitest';
import {
  buildJoinLink,
  formatRoomCode,
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
