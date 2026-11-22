import { describe, expect, it } from 'vitest';
import type { DocumentEvent } from './documents';
import { createTestNetwork, FakeClock, TEST_TRANSPORTS, type TestTransportKind } from './testing';

/**
 * Peer-join ordering: an app that replaces a document inside `onPeerJoined` must never have the
 * previous version served to the newcomer — whichever side offers, with delays, duplicates and
 * reordering on the data channels, and while other peers are still fetching the old version.
 * Run on both transports; on the relay transport also with the newcomer's messages arriving
 * before the host's `onPeerJoin` (join skew).
 */

const RICH = `rich:${'x'.repeat(5_000)}`;
const POOR = 'poor';

async function scenario(options: {
  kind: TestTransportKind;
  seed: number;
  newcomerId: string;
  reshareOnJoin: boolean;
  joinSkewMs?: number;
}) {
  const clock = new FakeClock();
  const net = createTestNetwork(options.kind, { clock, seed: options.seed });
  const extra = { documentMessageMaxBytes: 300 }; // many chunks: transfers to Ben are long-running
  const anna = await net.create('Anna', 'peer-m', extra);
  const ben = await net.join(anna, 'Ben', 'peer-b', extra);
  await clock.advanceAsync(200);
  net.setConditions({ maxDelayMs: 120, duplicateRate: 0.2, lossRate: 0.05 });
  if (net.relays && options.joinSkewMs) net.relays.conditions.joinSkewMs = options.joinSkewMs;

  const statusAtJoin: string[] = [];
  anna.onPeerJoined(({ peerId }) => {
    statusAtJoin.push(anna.getPeers().find((p) => p.peerId === peerId)?.status ?? 'unknown');
    if (options.reshareOnJoin) anna.shareDocument('fl-standing', POOR);
  });

  // Ben is fetching the rich version (in flight) when the newcomer arrives.
  anna.shareDocument('fl-standing', RICH);
  await clock.advanceAsync(30, 5);

  const cleo = await net.join(anna, 'Cleo', options.newcomerId, extra);
  const seen: DocumentEvent[] = [];
  cleo.onDocument((e) => seen.push(e));
  await clock.advanceAsync(6_000);
  return { anna, ben, cleo, seen, statusAtJoin, net };
}

describe.each(TEST_TRANSPORTS)('GroupRide.onPeerJoined (%s)', (kind) => {
  const skews = kind === 'relays' ? [0, 150] : [0];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const newcomerId of ['peer-a', 'peer-z']) {
      for (const joinSkewMs of skews) {
        it(`a document replaced in the listener never reaches the newcomer (seed ${seed}, ${newcomerId}${joinSkewMs ? `, skew ${joinSkewMs} ms` : ''})`, async () => {
          const { anna, cleo, seen, statusAtJoin } = await scenario({
            kind,
            seed,
            newcomerId,
            reshareOnJoin: true,
            joinSkewMs,
          });
          // The listener ran before anything could be exchanged with the newcomer: self-hosted,
          // before its channel existed; relays, before the transport let a message through.
          expect(statusAtJoin).toEqual(['connecting']);
          const texts = seen.flatMap((e) => (e.type === 'available' ? [e.document.text] : []));
          expect(texts).not.toContain(RICH);
          expect(cleo.getSharedDocuments().map((d) => d.text)).toEqual([POOR]);
          anna.leave();
        });
      }
    }
  }

  it('control: without the reshare the newcomer does get the earlier document', async () => {
    const { cleo } = await scenario({ kind, seed: 1, newcomerId: 'peer-a', reshareOnJoin: false });
    expect(cleo.getSharedDocuments().map((d) => d.text)).toEqual([RICH]);
  });

  it('fires once per peer; the sanitised name is there at once (self-hosted) or follows (relays)', async () => {
    const clock = new FakeClock();
    const net = createTestNetwork(kind, { clock });
    const anna = await net.create('Anna', 'peer-0');
    const joined: { peerId: string; name: string }[] = [];
    anna.onPeerJoined((p) => joined.push(p));
    await net.join(anna, 'Ben\u202e', 'peer-1');
    await clock.advanceAsync(3_000);
    // Relays: no signalling join to carry the name; it arrives in the peer's hello message.
    expect(joined).toEqual([{ peerId: 'peer-1', name: kind === 'relays' ? 'Rider' : 'Ben' }]);
    expect(anna.getPeers().map((p) => p.name)).toEqual(['Ben']);
  });
});
