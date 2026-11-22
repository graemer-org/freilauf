/**
 * The self-hosted transport (advanced fallback): our own signalling server (`apps/signalling`,
 * or the web build's `/signal`) introduces the peers, `PeerMesh` keeps one WebRTC data channel
 * per peer. This was the only transport before the relay transport (ADR 0003); it stays until
 * the relay path is confirmed on real networks. Removing it means deleting this file, `mesh.ts`,
 * `webrtc.ts`, `signalling/`, `testing/fakeRtc.ts`, `testing/memorySignalling.ts`,
 * `testing/wsTestUtils.ts` and the `signalling*` branch of `GroupRide` (see ADR 0003).
 */
import { PeerMesh } from '../mesh';
import { Events, type Timers, type Unsubscribe } from '../runtime';
import type { SignallingChannel } from '../signalling/channel';
import { WebSocketSignalling, type WebSocketFactory } from '../signalling/websocket';
import type { GroupTransport, MeshPeer, TransportEvents, TransportState } from '../transport';
import type { IceServerConfig, PeerConnectionFactory } from '../webrtc';

export interface SelfHostedTransportOptions {
  /** ws(s):// URL of the signalling server. Required unless `signalling` is given. */
  signallingUrl?: string;
  /** Custom signalling channel (overrides `signallingUrl`). Must not have joined yet. */
  signalling?: SignallingChannel;
  createWebSocket?: WebSocketFactory;
  createPeerConnection?: PeerConnectionFactory;
  iceServers?: IceServerConfig[];
  timers: Timers;
}

export class SignallingMeshTransport implements GroupTransport {
  readonly kind = 'self-hosted' as const;
  readonly signallingUrl: string | undefined;
  #signalling: SignallingChannel;
  #mesh: PeerMesh;
  #events = new Events<TransportEvents>();
  #off: Unsubscribe[];
  #closed = false;

  constructor(options: SelfHostedTransportOptions) {
    this.signallingUrl = options.signallingUrl;
    let signalling = options.signalling;
    if (!signalling) {
      if (!options.signallingUrl) throw new Error('GroupRide needs signallingUrl or signalling.');
      signalling = new WebSocketSignalling({
        url: options.signallingUrl,
        createWebSocket: options.createWebSocket,
        timers: options.timers,
      });
    }
    this.#signalling = signalling;
    this.#mesh = new PeerMesh({
      signalling,
      createPeerConnection: options.createPeerConnection,
      iceServers: options.iceServers,
      timers: options.timers,
    });
    const ev = this.#events;
    this.#off = [
      // The mesh emits this synchronously when it first learns of the peer, before the data
      // channel to that peer can exist (it needs further signalling round-trips).
      this.#mesh.on('peer-joined', (p) => ev.emit('peer-joined', p)),
      this.#mesh.on('peer-left', (p) => ev.emit('peer-left', p)),
      this.#mesh.on('status', (s) => ev.emit('status', s)),
      this.#mesh.on('message', (m) => ev.emit('message', m)),
      signalling.on('state', (s) => ev.emit('state', s)),
    ];
  }

  get localPeerId(): string {
    return this.#signalling.peerId;
  }

  get state(): TransportState {
    return this.#signalling.state;
  }

  async start(room: string, name: string): Promise<void> {
    await this.#signalling.join(room, name);
  }

  getPeers(): MeshPeer[] {
    return this.#mesh.getPeers();
  }

  send(peerId: string, data: string): boolean {
    return this.#mesh.send(peerId, data);
  }

  broadcast(data: string): number {
    return this.#mesh.broadcast(data);
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: (value: TransportEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#off) off();
    this.#mesh.close();
    this.#signalling.leave();
    this.#events.clear();
  }
}
