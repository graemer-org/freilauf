/**
 * The subset of the WebRTC API PeerMesh uses, as structural types so the package type-checks
 * without the DOM lib and can be driven by the in-memory fake in `./testing` under Node.
 * A browser `RTCPeerConnection` satisfies these at runtime; `defaultPeerConnectionFactory` casts.
 */
import type { IceServerConfig } from './ice';

// Shared with the relay transport (./ice.ts).
export { DEFAULT_ICE_SERVERS, type IceServerConfig } from './ice';

export interface SessionDescriptionLike {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface IceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface DataChannelInitLike {
  ordered?: boolean;
  maxRetransmits?: number;
  negotiated?: boolean;
  id?: number;
}

export type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed';

export interface DataChannelLike {
  readonly label: string;
  readonly readyState: DataChannelState;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type PeerConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface PeerConnectionLike {
  readonly connectionState: PeerConnectionState;
  readonly signalingState: string;
  readonly remoteDescription: SessionDescriptionLike | null;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  createDataChannel(label: string, init: DataChannelInitLike): DataChannelLike;
  close(): void;
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
}

export interface PeerConnectionConfig {
  iceServers: IceServerConfig[];
}

export type PeerConnectionFactory = (config: PeerConnectionConfig) => PeerConnectionLike;

/** Uses the host's global `RTCPeerConnection` (browser / Electron renderer). */
export const defaultPeerConnectionFactory: PeerConnectionFactory = (config) => {
  const Ctor = (
    globalThis as unknown as {
      RTCPeerConnection?: new (config: PeerConnectionConfig) => PeerConnectionLike;
    }
  ).RTCPeerConnection;
  if (!Ctor) throw new Error('No global RTCPeerConnection available; pass createPeerConnection.');
  return new Ctor(config);
};
