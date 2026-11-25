# ADR 0007 — Card Race: attacks as events, signed race offset, compatibility

Status: **superseded** by [ADR 0008](0008-rumble-items.md) · 2026-11-25

> This ADR records the first version of the battle mode, built as a hand of cards ("Card
> Race") from a misheard request — the maintainer asked for a mode like go-kart racing games.
> ADR 0008 keeps its mechanics (attacks as events with ids and acks, exactly-once delivery,
> validation, protection, the signed race offset, marking old apps) and replaces the
> presentation, the items and the wire format (v2: `items`, `rumble-*`, `puddle-*`). The text
> below is kept as it was decided.

## Context

The maintainer agreed to a battle mode for group rides, built on power-ups
([ADR 0006](0006-power-ups.md)), rider guide then `card-race.md` (now [rumble.md](../rumble.md)):

- a separate mode chosen by whoever creates the ride ("Normal" or "Card Race"), visible to
  everyone in the room; the display name lives in one constant (`CARD_RACE_NAME`);
- a hand of two cards, played with the left/right side buttons (P and L on the keyboard);
- gentle attacks — **Headwind** on the rider directly ahead, **Fog** on the leader — a
  **Shield**, and the four boosts; after any hit the rider is protected for a while;
- **fairness (hard):** cards and attacks move only the race position; the recording (distance,
  speed, FIT, points, bests, challenges) and the trainer's resistance never change. The race
  offset may become negative, but only in a Card Race;
- trust-based, but incoming attacks are validated so a buggy or hostile peer cannot pin anyone
  down or crash the UI; old clients must not break.

The network constraint: the 4 Hz rider-state channel is unreliable and unordered on the
self-hosted mesh and reliable and ordered on the relay transport ([ADR 0003](0003-signalling-via-public-relays.md)).

## Decision

### 1. Mode and rules on the wire (additive)

The host's `rules` gain an optional `mode`: `{ "powerUps": true, "mode": "cardRace" }`. Only the
host sends rules; guests use the host's. A mode a client does not know is treated as absent
(normal). Old clients read only `powerUps` and ignore `mode`. In a Card Race the host's
power-up switch does not apply (the switch belongs to a normal ride).

Every Card Race-capable client sends an optional **`cards`** object in its rider state, in
every group ride — its presence is the capability marker:

```jsonc
"cards": {
  "v": 1,                                    // Card Race protocol version
  "offsetM": -14.2,                          // Card Race: the signed race offset
  "attack": { "kind": "headwind", "s": 6.5 }, // an attack acting on this rider, s left
  "shieldS": 41.0,                           // shield up, s left
  "protectedS": 21.5,                        // s until an attack can land again
  "held": 2,                                 // cards held
  "away": true                               // paused / ERG / FTP test / cards off: not a target
}
```

Outside a Card Race it is just `{ "v": 1 }`. Validation drops the packet on malformed values
(as for every optional field): `v` integer 1…1000, `offsetM` −100 km…100 km, timers 0…600 s,
`kind` `^[a-z][a-zA-Z]{0,23}$`, `held` 0…8, `away` boolean.

**Signed offset, old clients safe:** the plain `raceOffsetM` stays ≥ 0 (old validators drop a
packet with a negative one); it carries `max(0, offset)`. New clients place riders by
`cards.offsetM` when present (`raceOffsetOf`), and count their own signed offset the same way.
`RemoteRiders.getRiders` no longer clamps the local offset at 0, and a route position moved back
by a negative offset is handled by the existing `gapAlongRoute` (wrap on a loop, clamp otherwise).

### 2. Attacks are events, not state

An attack is a **message aimed at one peer** (`transport.send`), not a field of the broadcast:

```jsonc
{ "v": 1, "type": "card-attack", "id": "k3j2a9x1.4", "to": "<target peer id>",
  "kind": "headwind", "gapM": 38.5, "raceM": 4231.0, "routeId": "isar-loop" }
{ "v": 1, "type": "card-ack", "id": "k3j2a9x1.4", "result": "hit" }
```

- `id` = `<epoch>.<seq>`: a random word per `GroupRide` and a counter — idempotent.
- `gapM`: how far ahead the attacker saw the target; `raceM`: the attacker's own race position
  (route metres + offset on `routeId` when both ride that route, otherwise ridden metres +
  offset). Re-sends carry fresh values under the same id.
- `result` (the target's verdict): `hit`, `blocked` (shield), `protected`, `unavailable` (not in
  the race, or no Card Race), `refused` (any failed check). The attacker's side adds `timeout`.
- Old clients ignore both types (unknown `type`, see p2p.md's forward-compatibility rule).
  Messages ≤ 512 bytes.

**Resolution on the attacker's side.** "Directly ahead" and "the leader" are resolved where the
card is played, from the latest race positions the attacker has (`resolveTarget`): the nearest
rider more than 10 m ahead, or the one furthest ahead, among riders who run the Card Race, have
signal and are not `away`. A target that is protected makes the card wait (it is not spent).

**Delivery.** `AttackOutbox` sends the attack and, on the **self-hosted mesh** (unreliable,
unordered), re-sends it every 400 ms until the target's ack arrives; on the **relay transport**
(reliable, ordered) it is sent once. Either way it reports exactly one outcome per attack — the
first ack from the target (acks from anyone else are ignored) or `timeout` after 5 s or when the
target leaves. A card whose attack did not land (`protected`, `unavailable`, `refused`,
`timeout`) goes back into the hand.

**Exactly once on the target.** `AttackInbox` keeps, per sender, the verdict of each id it has
decided (the last 64); a duplicate or re-send gets the **same verdict** acked again without being
applied. Ids older than what is remembered are refused as replays (a per-epoch sequence floor).
So with loss, duplicates and reordering an attack is applied once (at least once by the retries,
at most once by the inbox), and the attacker learns the verdict once.

**Validation, in order** (anything failing is acked `refused`, logged, never thrown):

1. well-formed message (types, ranges, id format) — else dropped silently;
2. `to` is this rider; the sender is a rider of the room (connected and has sent its state);
3. not a replay; at most 3 new attacks per sender per 30 s and 1 s apart;
4. (the app) a known attack kind; this rider is ahead of the attacker by the attacker's own
   `raceM` (20 m tolerance), and the attacker's `gapM` roughly agrees; Headwind: nobody in the
   race is between them; Fog: nobody in the race is ahead of this rider;
5. (the engine) riding and in the race; not under an attack and not within protection
   (`protected`); a raised shield takes it (`blocked`); otherwise it acts (`hit`).

A throwing handler is answered `refused`, so a bug cannot make a peer retry forever.

**Each client applies effects to itself.** The target's engine starts the effect on its own
race position and broadcasts it in `cards` (`attack`, `shieldS`, `protectedS`, `offsetM`);
everyone else — the attacker included — renders it from there. Nobody changes another rider's
numbers.

### 3. Engine (`renderer/core/powerUps.ts`)

- `setMode('normal' | 'cardRace')` (may change mid-ride). Card Race: two fixed slots (left/right;
  a new card fills the first empty slot), the weighted `CARD_RACE_POOL` (boosts 8 of 13,
  Headwind 2, Shield 2, Fog 1), `activate(slot)` for boosts and the shield, `spendCard(slot)` /
  `returnCard(kind)` for attacks, `receiveAttack(kind, by)`. Back to normal: one slot (the first
  boost held is kept), attacks and the shield end, the loss is dropped.
- Definitions gain `role` (`boost` | `attack` | `guard`) and `target` (`self` | `ahead` |
  `leader`). Headwind: drag × 1.6 for 10 s. Fog: no modifiers, 12 s. Shield: 60 s, blocks one.
  `PROTECTION_S = 15` after an attack's end (or after a block).
- **Two shadow bikes.** The boost shadow is exactly ADR 0006's (gain ≥ 0); an attack shadow
  integrates attack modifiers only and keeps the loss ≤ 0 (it follows the real bike exactly
  until the first attack, so it never picks up start-up lag). Race offset = gain + loss in a Card
  Race, `max(0, gain)` in a normal ride — which is therefore unchanged. The split gives the
  summary's "+38 m from cards / −24 m from attacks".
- `toLive()` adds `cards` (slots, per-slot notes and targets, attack, shield, protection,
  `immuneS`, gain, loss, the latest incoming and outgoing attack) only in a Card Race.

### 4. Shield: raised by playing it

Not held passively. Every card works the same way (you choose when), the bubble tells attackers
it is up (no hidden information), and a held card never silently occupies a slot that the
buttons map to.

### 5. Compatibility: mark, do not refuse

A Card Race does **not** refuse to start when someone's app lacks it. Such riders (no `cards` in
their state) are named in the room ("Anna's app does not support Card Race: they ride along with
normal power-ups and cannot be attacked") and passed over as targets; the target-side checks do
not count them either. They read everyone's state as before (only `raceOffsetM` ≥ 0 and
`rules.powerUps`). Refusing would turn a mixed group's evening into a support session; marking
lets them ride together now and see what to update.

### 6. UI

A two-card hand along the bottom of the scene (left card bottom left, right card bottom right),
effect chips and the "+ m from cards · − m from attacks" line between them, a notice at the top;
scene effects for the local rider and on others (`cardFx.ts`, both renderers); a mode choice
when creating, the mode row in the room, Fog's "?" in the rider list, overlay pills and the mode
over the overlay's rider list. Colours are tokens (`--card-attack`, `--card-guard`); reduced
motion keeps everything still.

## Alternatives considered

- **Attacks in the rider state** (a list of "attacks I sent" in the 4 Hz broadcast). Simple, but
  state is last-writer-wins and unordered on the mesh: either repeated forever or lost; the
  target could not answer, and every rider would have to scan everyone's list. Rejected.
- **Applying the attack on the attacker's side** (the attacker lowers the target's position in
  its own view). Each viewer would show a different race. Rejected: only the target changes its
  numbers, everyone renders from the target's broadcast.
- **A shared document per attack.** Reliable and verified, but heavy (lists, chunks) for a
  60-byte event. Rejected.
- **Refusing a Card Race with an old app in the room.** See §5.

## Consequences

- The recording is untouched by construction: neither attacks nor cards reach `RideSession`,
  `stepBike` or the trainer commands. Tests run the same three-rider ride with and without an
  attack and compare the target's `RecordedRide`, `.fit` bytes, community facts and every
  trainer command for equality (`cardRace.integration.test.ts`).
- A normal ride is byte-for-byte as before on the engine side and adds only `"cards":{"v":1}` to
  the broadcast.
- Old apps in a Card Race see an attacked rider slightly further ahead than the others do.
- Tests: engine (`powerUps.cardRace.test.ts`), protocol and inbox/outbox (`cardRace.test.ts` in
  p2p), exactly-once with loss/duplicates/reordering on both transports
  (`groupCardRace.test.ts`), three riders with real controllers on both transports
  (`cardRace.integration.test.ts`), server-rendered UI (`cardRaceUi.test.ts`) and one card played
  end to end between two app instances over a local signalling server (`e2e/cardrace.spec.ts`).
