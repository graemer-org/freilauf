/**
 * Guards the client copy of the signalling protocol against drift from the server's
 * source of truth (apps/signalling/src/protocol.ts). Type-level checks fail `tsc`, runtime checks
 * fail the test run; websocket.test.ts additionally round-trips against the real server.
 */
import { describe, expect, it } from 'vitest';
import * as server from '@freilauf/signalling/protocol';
import * as client from './protocol';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const typesMatch: [
  Equal<client.ClientMessage, server.ClientMessage>,
  Equal<client.ServerMessage, server.ServerMessage>,
  Equal<client.PeerInfo, server.PeerInfo>,
  Equal<client.ErrorCode, server.ErrorCode>,
] = [true, true, true, true];

describe('signalling protocol copy', () => {
  it('has identical types (checked by tsc)', () => {
    expect(typesMatch).toEqual([true, true, true, true]);
  });

  it('has identical constants', () => {
    expect(client.PROTOCOL_VERSION).toBe(server.PROTOCOL_VERSION);
    expect(client.MAX_NAME_LENGTH).toBe(server.MAX_NAME_LENGTH);
    expect(client.MAX_PEERS_PER_ROOM).toBe(server.MAX_PEERS_PER_ROOM);
    expect(client.MAX_MESSAGE_BYTES).toBe(server.MAX_MESSAGE_BYTES);
    expect(client.CLOSE_REPLACED).toBe(server.CLOSE_REPLACED);
    expect(client.ROOM_CODE_PATTERN.source).toBe(server.ROOM_CODE_PATTERN.source);
    expect(client.PEER_ID_PATTERN.source).toBe(server.PEER_ID_PATTERN.source);
  });

  it('parses every server message shape and rejects junk', () => {
    const samples: server.ServerMessage[] = [
      { type: 'joined', room: 'ABCDEF', peerId: 'peer-a', peers: [{ peerId: 'b', name: 'B' }] },
      { type: 'peer-joined', peer: { peerId: 'peer-b', name: 'B' } },
      { type: 'peer-left', peerId: 'peer-b' },
      { type: 'signal', from: 'peer-b', data: { any: ['thing'] } },
      { type: 'error', code: 'room-full', message: 'full' },
    ];
    for (const m of samples) expect(client.parseServerMessage(JSON.stringify(m))).toEqual(m);
    for (const junk of ['', '{', '[]', '{"type":"joined"}', '{"type":"error","code":"x"}', 5]) {
      expect(client.parseServerMessage(junk)).toBeNull();
    }
  });

  it('produces client messages the server accepts', () => {
    const msgs: client.ClientMessage[] = [
      { type: 'join', room: 'ABCDEF', peerId: 'peer-a', name: 'Anna' },
      { type: 'leave' },
      { type: 'signal', to: 'peer-b', data: { kind: 'offer', gen: 1, sdp: 'v=0' } },
    ];
    for (const m of msgs) {
      expect(server.parseClientMessage(JSON.stringify(m))).toEqual({ ok: true, message: m });
    }
  });
});
