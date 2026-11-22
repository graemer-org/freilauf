import { Events, randomPeerId, type Unsubscribe } from '../runtime';
import {
  SignallingError,
  type SignallingChannel,
  type SignallingEvents,
  type SignallingState,
} from '../signalling/channel';
import { MAX_PEERS_PER_ROOM, ROOM_CODE_PATTERN, type PeerInfo } from '../signalling/protocol';

const later = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};

/**
 * In-process signalling "server" with the same semantics as apps/signalling (room limit, peer
 * list on join, peer-joined / peer-left, relay within a room). For tests that do not want a
 * real WebSocket server.
 */
export class InMemorySignallingHub {
  readonly maxPeersPerRoom: number;
  readonly rooms = new Map<string, Map<string, InMemorySignalling>>();

  constructor(maxPeersPerRoom = MAX_PEERS_PER_ROOM) {
    this.maxPeersPerRoom = maxPeersPerRoom;
  }

  createChannel(peerId: string = randomPeerId()): InMemorySignalling {
    return new InMemorySignalling(this, peerId);
  }
}

export class InMemorySignalling implements SignallingChannel {
  readonly peerId: string;
  name = '';
  #hub: InMemorySignallingHub;
  #room: string | null = null;
  #state: SignallingState = 'idle';
  #events = new Events<SignallingEvents>();

  constructor(hub: InMemorySignallingHub, peerId: string) {
    this.#hub = hub;
    this.peerId = peerId;
  }

  get state(): SignallingState {
    return this.#state;
  }

  on<K extends keyof SignallingEvents>(
    event: K,
    listener: (value: SignallingEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  async join(room: string, name: string): Promise<PeerInfo[]> {
    if (this.#state !== 'idle') throw new SignallingError('already-joined', 'Already joined.');
    if (!ROOM_CODE_PATTERN.test(room)) throw new SignallingError('invalid-room', 'Invalid room.');
    let members = this.#hub.rooms.get(room);
    if (members && members.size >= this.#hub.maxPeersPerRoom) {
      this.#close('room-full');
      throw new SignallingError('room-full', `Room ${room} is full.`);
    }
    if (!members) {
      members = new Map();
      this.#hub.rooms.set(room, members);
    }
    const peers = [...members.values()].map((m) => ({ peerId: m.peerId, name: m.name }));
    this.name = name;
    this.#room = room;
    members.set(this.peerId, this);
    for (const other of members.values()) {
      if (other !== this) {
        later(() => other.#events.emit('peer-joined', { peerId: this.peerId, name }));
      }
    }
    this.#setState('joined');
    later(() => this.#events.emit('peers', peers));
    return peers;
  }

  leave(): void {
    if (this.#state === 'closed') return;
    const room = this.#room;
    const members = room === null ? undefined : this.#hub.rooms.get(room);
    if (room !== null && members?.get(this.peerId) === this) {
      members.delete(this.peerId);
      if (members.size === 0) this.#hub.rooms.delete(room);
      for (const other of members.values()) {
        later(() => other.#events.emit('peer-left', { peerId: this.peerId }));
      }
    }
    this.#room = null;
    this.#close('left');
  }

  sendSignal(to: string, data: unknown): boolean {
    if (this.#state !== 'joined' || this.#room === null) return false;
    const target = this.#hub.rooms.get(this.#room)?.get(to);
    if (!target) return false;
    const copy: unknown = JSON.parse(JSON.stringify(data)); // as if it went over the wire
    later(() => target.#events.emit('signal', { from: this.peerId, data: copy }));
    return true;
  }

  #setState(state: SignallingState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#events.emit('state', state);
  }

  #close(reason: string): void {
    this.#setState('closed');
    this.#events.emit('closed', { reason });
  }
}
