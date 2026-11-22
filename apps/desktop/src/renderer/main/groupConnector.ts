import { GroupRide, parseJoinLink } from '@freilauf/p2p';
import type { GroupConnector, JoinedGroup } from './appStore';

/** Adapts @freilauf/p2p's GroupRide to what the app store expects. */
function adapt(ride: GroupRide): JoinedGroup {
  return {
    roomCode: ride.roomCode,
    joinLink: ride.joinLink,
    // The group already knows the local name; it only wants the numbers.
    setLocalState: ({ name: _name, ...state }) => void ride.setLocalState(state),
    getRiders: () => ride.getRiders(),
    leave: () => ride.leave(),
  };
}

/** Group rides over the renderer's own WebSocket and RTCPeerConnection. */
export const webRtcGroupConnector: GroupConnector = {
  async create(name, signallingUrl) {
    return adapt(await GroupRide.create(name, { signallingUrl }));
  },

  async join(codeOrLink, name, signallingUrl) {
    const link = parseJoinLink(codeOrLink);
    if (!link) throw new Error('That is not a valid room code or join link.');
    // A link names the signalling server its group lives on; a bare code uses ours.
    return adapt(
      await GroupRide.join(link.roomCode, name, {
        signallingUrl: link.signallingUrl ?? signallingUrl,
      }),
    );
  },
};
