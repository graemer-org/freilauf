import { GroupRide, contentHash, type GroupRideDeps } from '@freilauf/p2p';
import type { HostTarget } from '../core/groupConnection';
import { ROUTE_KIND } from '../core/routeSharing';
import type { GroupConnector, JoinedGroup } from './appStore';

const WORKOUT_KIND = 'workout';

/** Adapts @freilauf/p2p's GroupRide to what the app store expects. */
export function adaptGroupRide(ride: GroupRide): JoinedGroup {
  return {
    roomCode: ride.roomCode,
    joinLink: ride.joinLink,
    inviteCode: ride.inviteCode,
    secret: ride.secret,
    transport: ride.transport,
    getConnectionState: () => ride.signallingState,
    getProblems: () => ride.getProblems().map((p) => p.code),
    onFailure: (listener) => ride.onFailure(listener),
    onLog: (listener) => ride.onLog(listener),
    // The group already knows the local name; it only wants the numbers.
    setLocalState: ({ name: _name, ...state }) => void ride.setLocalState(state),
    getRiders: () => ride.getRiders(),
    getRules: () => ride.getRules(),
    sendAttack: (to, payload) => ride.sendAttack(to, payload),
    onAttackResult: (listener) => ride.onAttackResult(listener),
    setAttackHandler: (handler) => ride.setAttackHandler(handler),
    leave: () => ride.leave(),

    shareWorkout: (text) => {
      const result = ride.shareDocument(WORKOUT_KIND, text);
      return result.ok ? null : result.reason;
    },
    stopSharingWorkout: () => void ride.unshareDocument(WORKOUT_KIND),
    getSharedWorkouts: () =>
      ride
        .getSharedDocuments()
        .filter((d) => d.kind === WORKOUT_KIND)
        .map((d) => ({ peerId: d.peerId, peerName: d.peerName, text: d.text })),
    onSharedWorkoutsChange: (listener) =>
      ride.onDocument((e) => {
        if ((e.type === 'available' ? e.document.kind : e.kind) === WORKOUT_KIND) listener();
      }),
    shareRoute: (text) => {
      const result = ride.shareDocument(ROUTE_KIND, text);
      return result.ok ? null : result.reason;
    },
    stopSharingRoute: () => void ride.unshareDocument(ROUTE_KIND),
    getSharedRoutes: () =>
      ride
        .getSharedDocuments()
        .filter((d) => d.kind === ROUTE_KIND)
        .map((d) => ({ peerId: d.peerId, peerName: d.peerName, text: d.text })),
    onSharedRoutesChange: (listener) =>
      ride.onDocument((e) => {
        if ((e.type === 'available' ? e.document.kind : e.kind) === ROUTE_KIND) listener();
      }),
    announceStart: (inMs) => {
      // The start refers to whatever each rider has selected; the id only labels it.
      const id = ride.getLocalDocuments().find((d) => d.kind === WORKOUT_KIND)?.id;
      return ride.announceStart(WORKOUT_KIND, id ?? contentHash('start'), inMs).ok;
    },
    onStart: (listener) => ride.onStart((s) => listener(s.startsInMs, s.peerName)),

    // Generic shared documents (community sync, see CommunityGroupLink).
    shareDocument: (kind, text) => {
      const result = ride.shareDocument(kind, text);
      return result.ok ? null : result.reason;
    },
    unshareDocument: (kind) => void ride.unshareDocument(kind),
    getLocalDocuments: () => ride.getLocalDocuments(),
    getSharedDocuments: () => ride.getSharedDocuments(),
    onDocumentChange: (listener) =>
      ride.onDocument((e) =>
        e.type === 'available'
          ? listener(e.document.peerId, e.document.kind)
          : listener(e.peerId, e.kind),
      ),
    getPeers: () => ride.getPeers().map((p) => ({ peerId: p.peerId, name: p.name })),
    getPeerStatuses: () =>
      ride.getPeers().map((p) => ({
        peerId: p.peerId,
        name: p.name,
        status: p.status,
        attempts: p.attempts,
      })),
    onPeerJoined: (listener) => ride.onPeerJoined(listener),
    onPeersChange: (listener) => ride.onChange(listener),
  };
}

function depsFor(target: HostTarget): GroupRideDeps {
  if (target.transport === 'relays') {
    // The relay library is loaded on first use (a separate chunk), see transports/relay.ts.
    return { relay: target.relayUrls.length > 0 ? { relayUrls: target.relayUrls } : {} };
  }
  return { signallingUrl: target.signallingUrl };
}

/**
 * Group rides over the renderer's own WebSocket and RTCPeerConnection: public relays by default
 * (Trystero), or an own signalling server.
 */
export const webRtcGroupConnector: GroupConnector = {
  async create(name, target) {
    return adaptGroupRide(await GroupRide.create(name, depsFor(target)));
  },

  async join(target, name) {
    if (target.transport === 'relays') {
      const relay = {
        secret: target.secret,
        ...(target.relayUrls.length > 0 ? { relayUrls: target.relayUrls } : {}),
      };
      return adaptGroupRide(await GroupRide.join(target.roomCode, name, { relay }));
    }
    return adaptGroupRide(
      await GroupRide.join(target.roomCode, name, { signallingUrl: target.signallingUrl }),
    );
  },
};
