import { describe, expect, it } from 'vitest';
import type { DocumentEvent } from './documents';
import { GroupRide } from './group';
import { FakeClock, FakeRtcNetwork, InMemorySignallingHub } from './testing';

/**
 * Peer-join ordering: an app that replaces a document inside `onPeerJoined` must never have the
 * previous version served to the newcomer — whichever side offers, with delays, duplicates and
 * reordering on the data channels, and while other peers are still fetching the old version.
 */

const RICH = `rich:${'x'.repeat(5_000)}`;
const POOR = 'poor';

async function scenario(options: { seed: number; newcomerId: string; reshareOnJoin: boolean }) {
  const clock = new FakeClock();
  const hub = new InMemorySignallingHub();
  const network = new FakeRtcNetwork({ seed: options.seed, timers: clock.timers });
  const deps = (peerId: string) => ({
    signalling: hub.createChannel(peerId),
    createPeerConnection: network.createPeerConnection,
    now: clock.now,
    timers: clock.timers,
    documentMessageMaxBytes: 300, // many chunks: transfers to Ben are long-running
  });
  const anna = await GroupRide.create('Anna', deps('peer-m'));
  const ben = await GroupRide.join(anna.roomCode, 'Ben', deps('peer-b'));
  await clock.advanceAsync(200);
  network.conditions = { maxDelayMs: 120, duplicateRate: 0.2, lossRate: 0.05 };

  const statusAtJoin: string[] = [];
  anna.onPeerJoined(({ peerId }) => {
    statusAtJoin.push(anna.getPeers().find((p) => p.peerId === peerId)?.status ?? 'unknown');
    if (options.reshareOnJoin) anna.shareDocument('fl-standing', POOR);
  });

  // Ben is fetching the rich version (in flight) when the newcomer arrives.
  anna.shareDocument('fl-standing', RICH);
  await clock.advanceAsync(30, 5);

  const cleo = await GroupRide.join(anna.roomCode, 'Cleo', deps(options.newcomerId));
  const seen: DocumentEvent[] = [];
  cleo.onDocument((e) => seen.push(e));
  await clock.advanceAsync(6_000);
  return { anna, ben, cleo, seen, statusAtJoin, network };
}

describe('GroupRide.onPeerJoined', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const newcomerId of ['peer-a', 'peer-z']) {
      it(`a document replaced in the listener never reaches the newcomer (seed ${seed}, ${newcomerId})`, async () => {
        const { anna, cleo, seen, statusAtJoin } = await scenario({
          seed,
          newcomerId,
          reshareOnJoin: true,
        });
        // The listener ran before the newcomer's channel existed.
        expect(statusAtJoin).toEqual(['connecting']);
        const texts = seen.flatMap((e) => (e.type === 'available' ? [e.document.text] : []));
        expect(texts).not.toContain(RICH);
        expect(cleo.getSharedDocuments().map((d) => d.text)).toEqual([POOR]);
        anna.leave();
      });
    }
  }

  it('control: without the reshare the newcomer does get the earlier document', async () => {
    const { cleo } = await scenario({ seed: 1, newcomerId: 'peer-a', reshareOnJoin: false });
    expect(cleo.getSharedDocuments().map((d) => d.text)).toEqual([RICH]);
  });

  it('fires once per peer, with the sanitised signalling name', async () => {
    const clock = new FakeClock();
    const hub = new InMemorySignallingHub();
    const network = new FakeRtcNetwork({ timers: clock.timers });
    const deps = (peerId: string) => ({
      signalling: hub.createChannel(peerId),
      createPeerConnection: network.createPeerConnection,
      now: clock.now,
      timers: clock.timers,
    });
    const anna = await GroupRide.create('Anna', deps('peer-0'));
    const joined: { peerId: string; name: string }[] = [];
    anna.onPeerJoined((p) => joined.push(p));
    await GroupRide.join(anna.roomCode, 'Ben‮', deps('peer-1'));
    await clock.advanceAsync(3_000);
    expect(joined).toEqual([{ peerId: 'peer-1', name: 'Ben' }]);
  });
});
