# ADR 0009 — Freilauf Rumble: road items, Rumble protocol v3

Status: accepted · 2026-11-26 · extends [ADR 0008](0008-rumble-items.md) (its mechanics, the
claim protocol and the messages stay as they are)

## Context

Riders asked for more items with a road-cycling feel, each with an effect you can see. Six were
chosen ([rumble.md](../rumble.md)):

- **Energy bar** (on yourself): fresh legs for a short while.
- **Tacks** (dropped behind you, like the mud puddle): the next rider over them has a **flat
  tyre** until it is fixed or runs out.
- **Mini tool** (on yourself, when you choose): fixes a flat tyre or a dropped chain; without one
  it does nothing and stays in its slot.
- **Dropped chain** (aimed): the rider directly **behind** you pedals into nothing for a moment.
- **Team car** (on yourself): fills your slots with new items.
- **Rough section** (laid behind you): 150 m of rough road for 60 s that slows **every** other
  rider on it — not one hit, but road.

The rules of ADR 0008 hold: every effect lives only in the race-offset shadow bikes; the
recorded ride, the `.fit` file, points, bests and every trainer command stay byte-identical. And
apps of protocol v2 (ADR 0008) are already released to testers: they must not crash on anything
a new app sends and must never apply an item they do not know.

## Decision

### 1. Items and magnitudes (engine, `renderer/core/powerUps.ts`)

The shadow bike gets one more factor, `powerFactor` (× the rider's power as the shadow bike sees
it; never the trainer's). Sized like ADR 0008 — a hit costs about what a boost gains, at 200 W
on the flat (Tailwind ≈ 19 m, Slipstream ≈ 24 m):

| Item          | Use                                  | Effect                                                       | ≈ at 200 W, flat                         |
| ------------- | ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------- |
| Energy bar    | on yourself, a boost                 | power × 1.45 for 15 s                                        | +22 m                                    |
| Tacks         | dropped 2 m behind (puddle protocol) | flat tyre: rolling resistance × 3.5 for 20 s                 | −27 m; fixed after 2 s: −6.5 m           |
| Mini tool     | on yourself, only with a flat/chain  | the flat ends 3 s later, the chain 1 s later                 | —                                        |
| Dropped chain | aimed: the nearest rider behind      | power × 0 for 6 s (coasting with the usual drag)             | −22 m; fixed after 1 s: −6.4 m           |
| Team car      | on yourself                          | refills its own slot, and the other if empty, from the pool  | —                                        |
| Rough section | laid 2 m behind, 150 m back, 60 s    | rolling resistance × 2.5 while inside, for every other rider | −13.7 m riding all of it (≈ 17 s inside) |

- **The dropped chain lasts 6 s, not 4.** At no power a rider at 200 W coasts and loses only
  ≈ 14 m in 4 s; 6 s gives the ≈ 22 m every other hit costs. The tool shortens it to 1 s.
- **Flat and chain are hits** (role `attack`): the rain cape keeps them off, they start the
  15 s protection, nothing else lands meanwhile. After a repair the protection runs 15 s from
  the moment it is fixed.
- **The mini tool** (role `repair`) is usable only while a flat tyre or dropped chain slows the
  rider (`playNote`: "Only with a flat or chain off"; "Repairing" while one works).
  Pressing it otherwise does nothing; it stays.
- **The team car** (role `supply`) draws its items with the same seeded generator as feed bags
  (`kindFor(seed, visit, pool without the team car, 'teamCar')`), so the same ride gives the same
  items; it never hands up a team car.
- **The rough section** (role `terrain`) is road, not a hit: no cape keeps it off, it does not
  start or need protection, it is not used up, it acts on a protected rider too, and it does not
  act while the rider is out of the race (paused, ERG, FTP test, items off). Its loss counts as
  "− m from hits" (the loss shadow).
- **The energy bar** is a Rumble boost (one boost at a time); a normal ride's power-ups are
  unchanged and do not include it.

Pool (`RUMBLE_POOL`, 27 entries, plain weights): Tailwind, Slipstream, Light load, Downhill
momentum, Energy bar × 2 each (10 of 27 ≈ 37 % boosts); water bottle, mud puddle, tacks, dropped
chain, rough section × 2, hornets × 1 (11 attacks); rain cape × 2, mini tool × 3, team car × 1.

**Why the tool is not biased** (more often when you hold none): the item at a feed bag must stay
the same for every rider on a route (it is drawn from the route and the bag's index). A bias by
what a rider holds would break that, and with it the shared feed bags. A plain weight of 3 in 27
(the most common single non-boost item) makes a flat now and then fixable; the team car is a
second way to a tool.

### 2. Rumble protocol v3: bump the state's `items.v`, keep the messages

`items.v` is now **3** (`RUMBLE_PROTOCOL_VERSION`). New optional fields, validated like ADR
0008's (a malformed one drops the packet):

```jsonc
"items": {
  "v": 3,
  "hit": { "kind": "tacks", "s": 2.4 },      // a flat tyre ("chain": a dropped chain)
  "repairS": 2.4,                           // the mini tool at work: s until fixed (0 … 600)
  "tacks": [ { "id": "t4k3x9aa.1", "routeId": "isar-loop", "m": 4213.5, "s": 41.2 } ],
  // ≤ 4, distinct ids, exactly like "puddles" (a used one: "s": 0, "used": true, for 3 s)
  "rough": [ { "id": "r0q2m8zz.1", "routeId": "isar-loop", "m": 5120.0, "len": 150,
               "s": 52.0, "variant": "cobbles" } ]
  // ≤ 2, distinct ids; len 1 … 300 m back from m; variant ^[a-z]{1,16}$
}
```

The messages are **unchanged** (`v: 2`, ≤ 512 bytes): the dropped chain is one more `kind` of
`rumble-attack`; tacks are claimed with `puddle-claim` (the id names the tacks in the dropper's
`items.tacks`; the dropper keeps a second `PuddleLedger` and routes each claim to the ledger that
knows the id); rough sections need no message at all.

**Why bump `v` rather than only rely on v2 ignoring unknown kinds:** both are true, and both
are needed.

- A v2 app _does_ ignore everything new, safely (tested against a frozen copy of the v2 decoder,
  `packages/p2p/src/testing/riderStateV2.ts`): its validator accepts `v` 2 … 1000, keeps the
  fields it knows and drops `tacks`, `rough` and `repairS`; a hit of kind `tacks` or `chain` is
  a valid word, which its app draws as nothing and treats as "protected" (it does not throw
  then). A v2 app refuses a `rumble-attack` of kind `chain` (`unknown-kind` → `refused`, the item
  goes back to the thrower's slot). It never sees tacks, so it never claims them — so it is never
  _mis_-applied anything.
- But a v3 app must know whom it can aim a dropped chain at, and that is what `v` says. A v3
  app passes over v2 riders for the chain (`speaksV3`), so the item waits instead of being
  refused. For tacks and rough sections nothing is needed: a v2 rider rides over them without
  effect (it does not see them); the tacks stay for the next rider.

Not chosen:

- **New message types / message version 3**: nothing in the messages needs to change, and a
  `v: 3` attack would be silently dropped by v2 apps (no ack, a 5 s timeout) instead of being
  refused at once.
- **Tacks as a `kind` field on `puddles` entries**: a v2 app keeps the puddle and drops the
  unknown field — it would draw tacks as mud and, worse, claim them and apply a mud hit.
  Hence a separate list.
- **The flat as a separate `flatS` field next to `hit`**: a flat is a hit in every rule
  (protection, cape, one at a time); `hit.kind` already carries the kind, and v2 treats an
  unknown kind as protection, which is right.

### 3. Rough sections: every rider decides for itself

A rough section is not single-hit, so there is nothing to judge and no claim: the dropper's
`RoughLedger` lays it at its race position minus 2 m (the puddle's coordinates: route metres +
offset on its route, else ridden metres + offset) and broadcasts it, with the seconds left, until
it is gone (at most two at once). Every other rider measures it with `roughSpan` — from its far
end (`m − len`) to `m`, along the route — and is on it while `fromM ≤ 0 ≤ toM`; the ride
controller then sets the engine's terrain (`setTerrain`). The dropper's own sections are not in
the list it measures (they are not remote riders), so it is never slowed by them.

Its look is chosen when laid, from who lays it and how many it laid
(`roughVariantFor(peerId, index)`, a hash): cobbles, a gravel farm track, a forest path with
roots, or branches and leaves. The look travels as `variant`; the effect is the same for all.
An unknown look (a later app's) is ignored entirely, so an app never applies a road it cannot
show.

### 4. Presentation

Item icons for all six; slots show the mini tool as of no use ("Only for a flat tyre or a
dropped chain", quieter). Scenes: the energy bar unwrapped above the hands, then a glow with
sparkles; tacks glinting on the road; a flat rear tyre (the bike sags and wobbles, the tyre
bulges at the road) with a "pssst" puff when it happens; the mini tool's wrench at the rear
wheel with a progress ring; the chain hanging loose and flapping while the legs spin freely; the
team car pulling up alongside and handing items up; the rough section on the road in its look,
in both views. HUD: "Flat tyre!", "Chain off!", the repair ring ("Fixing the flat · Mini tool ·
2 s"), the rough road under you ("Cobbles · Rough road · Ben's section"), "Ben's tacks ahead ·
25 m", "Cobbles ahead · 80 m". The overlay shows the same in its pills. With reduced motion
everything is drawn still.

## Consequences

- The recording stays untouched by construction (only the shadow bikes see `powerFactor`,
  `rollingFactor` and the terrain). `rumble.integration.test.ts` rides the same three-rider ride
  on both transports with and without: tacks (a flat, with and without the mini tool), an energy
  bar, a dropped chain (with and without the tool) and a rough section, and compares the affected
  rider's `RecordedRide`, `.fit` bytes, community facts and every trainer command.
- The fullest v3 state still fits in one 2 kB state message (tested).
- Tests: engine (`powerUps.rumble.test.ts`: each item's effect and duration with an
  independent trace, the tool's rules, the team car, terrain vs. cape and protection, the
  pool), protocol (`rumble.test.ts` in p2p: v3 fields, the v2 decoder on v3 states,
  `RoughLedger`, `roughSpan`, tacks watched in their own list), claims for tacks on both
  transports with loss (`groupRumble.test.ts`: ties, lost acks, a dropper who leaves), the rules
  (`renderer/core/rumble.test.ts`: the chain's target and plausibility, `roughLive`), scene
  bookkeeping, server-rendered UI and overlay, and two app instances
  (`e2e/rumble.spec.ts`: energy bar, tacks → flat → mini tool, dropped chain, rough section, team
  car).
