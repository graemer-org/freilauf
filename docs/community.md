# Community: points, leaderboards, challenges and friend sync

`@freilauf/community` is the pure core of Freilauf's community features. It has no accounts, no
server and no I/O: every function takes the state, the time (`Now = { ms, utcOffsetMin }`) and,
where needed, randomness as arguments, and returns new plain-JSON values. Riders exchange their
values as **shared documents** over the existing P2P sessions (see [`p2p.md`](p2p.md)).

| File             | Contents                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| `scoring.ts`     | `rideFacts()` — per-ride facts, normalised power, best efforts, points     |
| `periods.ts`     | Local day / ISO week / month keys from a timestamp + UTC offset            |
| `totals.ts`      | `aggregate()` and the incremental `Ledger` (add/remove one ride)           |
| `profile.ts`     | Profile, contacts book, `PublicStanding`, visibility (`standingFor`), wire |
| `sync.ts`        | `documentsToShare()` / `mergeIncoming()` — the gossip                      |
| `challenges.ts`  | Seven challenge templates, invitations, merge rules, `challengeProgress()` |
| `leaderboard.ts` | `leaderboard()` — ranked rows with ties, deltas, stale markers             |
| `state.ts`       | `CommunityState`, `emptyState()`, `migrate()`, caps, size estimate         |

## Concept

- Riders compare **weekly and monthly totals**: distance, ride time, elevation gain, energy (kJ),
  number of rides — and **points**, the main ranking value. Average speed is available for
  display (`averageSpeedMps(totals)`) but is never a leaderboard metric.
- **Points reward load, not kilometres**: duration × intensity relative to the rider's own FTP.
  A strong and a weak rider doing the same relative effort score the same; a hard hour scores
  more than an easy one.
- **Friends**: everybody you have shared a P2P session with becomes a contact. Per contact you
  choose what they may see of you: `none`, `totals` (points and totals) or `everything`
  (including best efforts).
- **Sync**: each rider computes their own values from their saved rides. In a session riders
  exchange them, and pass on the values they hold for mutual friends — so you see friends who
  are not online right now.
- **Challenges** are created by riders from templates and friends are invited. Invitations and
  responses travel like everything else.
- **Trust-based**: there is no anti-cheat. Remote data can never crash, bloat or corrupt local
  state: everything is validated and capped, and `mergeIncoming` never throws.

## Ride facts and points

`rideFacts({ rideId, startedAt, samples, ftpW, utcOffsetMin, groupRide })` reads the 1 Hz
samples of a recorded ride (`timestamp, elapsedS, powerW, speedMps, distanceM, gradePercent,
heartRateBpm` — a structural subset of `RideSample`) and returns frozen `RideFacts`:

| Fact                      | Method                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dt` per sample           | `elapsedS − previous elapsedS`, ignored if ≤ 0, capped at 5 s (gaps don't count)                                                                                                             |
| `movingS`                 | Σ dt of samples with speed > 0.3 m/s or power > 0                                                                                                                                            |
| `energyKj`                | Σ power × dt / 1000 (power clamped 0–2500 W)                                                                                                                                                 |
| `distanceM`               | Σ positive increments of the cumulative distance; jumps faster than 30 m/s are ignored                                                                                                       |
| `elevationGainM`          | Σ Δdistance × max(0, grade) / 100 over the same increments (grade clamped ±40 %). Δdistance is treated as horizontal: at 10 % the difference to the slope length is 0.5 %, below other noise |
| `normalizedPowerW`        | 4th root of the mean of (30 s rolling average)⁴; average power for rides < 30 s                                                                                                              |
| `intensityFactor`         | NP / FTP (3 decimals); `null` without a plausible FTP (30–1000 W)                                                                                                                            |
| `best`                    | Highest mean power over 5 / 60 / 300 / 1200 consecutive samples (`p5s`, `p1m`, `p5m`, `p20m`), `null` if shorter                                                                             |
| `dayKey/weekKey/monthKey` | From `startedAt` in the rider's local time (`utcOffsetMin` at the start); a ride across midnight counts for its start day                                                                    |
| `groupRide`               | Passed in (ridden in a session with at least one other rider)                                                                                                                                |
| `avgSpeedMps`             | distance / moving time — display only                                                                                                                                                        |

All quantities are rounded to integers (IF to 3 decimals, speed to 2), so sums are exact and
incremental totals equal a full recompute.

### Points formula (`SCORING_VERSION = 1`)

It is the standard training-stress score (TSS: 1 hour at FTP = 100) with caps:

```
IF        = NP / FTP
IFp       = min(IF, 1.3)                       // POINTS_IF_CAP: guards against a too-low FTP
points    = round(min(movingHours × IFp² × 100, 400))   // POINTS_PER_RIDE_CAP
per day   = min(Σ points of the rides on that local day, 500)   // POINTS_PER_DAY_CAP, in totals
```

No plausible FTP → 0 points (the app always has an FTP from the rider's settings or an FTP test).
The IF cap of 1.3 is above anything sustainable for 20 minutes or more, so honest rides are not
affected; a ride with FTP set to half the real value is capped instead of scoring 4×.

Worked examples (FTP 250 W unless noted):

| Ride                                   | IF  | Points                           |
| -------------------------------------- | --- | -------------------------------- |
| 1 h at NP 200 W                        | 0.8 | 1 × 0.64 × 100 = **64**          |
| 45 min at 250 W                        | 1.0 | 0.75 × 1 × 100 = **75**          |
| 1 h easy at 150 W                      | 0.6 | **36**                           |
| 1 h hard at 225 W                      | 0.9 | **81**                           |
| 1 h at 300 W, FTP 375 / 160 W, FTP 200 | 0.8 | both **64** (fair across levels) |
| 1 h at 400 W with FTP 100 (bogus)      | 4.0 | IF capped 1.3 → **169**          |
| 6 h at FTP                             | 1.0 | 600 → ride cap **400**           |
| Two rides on one day: 400 + 300        | —   | day cap → **500**                |

### Versioning and other sources

Facts are computed once and never recomputed: they carry `scoringVersion` and
`source: 'freilauf'`. A later formula (version 2) or another source (e.g. imported FIT files)
only affects new facts; totals simply sum the stored `points`, so existing standings never
change retroactively. Standings carry `scoringVersion` (the version the publisher computes
with) so the UI can flag mixed versions. Only `'freilauf'` is accepted today
(`RIDE_SOURCES`); adding a source means adding it there plus its own `rideFacts` adapter.

## Periods

`dayKey(ms, offsetMin)`, `weekKey(...)` (ISO 8601, weeks start Monday, `2026-W53` exists),
`monthKey(...)`. There is no time-zone database: the caller passes the UTC offset in force at
that instant (`-new Date(ms).getTimezoneOffset()`), so DST is handled by passing the offset that
applied to each ride. `periodBounds(key, offset)` gives start/end instants (one offset for
both ends: off by the DST hour for a week that contains a switch — fine for "time remaining").
Keys are zero-padded so string order is chronological.

## Totals

`aggregate(facts, periodKey)` computes `Totals` (`rides, movingS, distanceM, elevationGainM,
energyKj, points, groupRides, rideDays`) plus `best` efforts from scratch. The `Ledger` keeps the
own facts plus one accumulator per week and month (with per-day raw points for the day cap and
the distinct-day count); `ledgerAdd` / `ledgerRemove` update only the two affected periods
(best efforts, a max, are recomputed from that period's rides on removal). A seeded property
test checks incremental == full recompute.

## Data model

```ts
CommunityState = {
  schema: 1,
  profile: {
    riderId,
    name,
    createdAt,
    friendsOfFriends /* default false */,
    defaultVisibility /* 'totals' */,
  },
  ledger: { rides: { [rideId]: RideFacts }, periods: { [weekOrMonthKey]: PeriodAccumulator } },
  published: { revision, updatedAt, digest }, // own standing's last revision
  contacts: { [riderId]: { riderId, name, alias, visibility, firstSeen, lastSeen, blocked } },
  standings: { [riderId]: { standing: PublicStanding, via: null | relayerRiderId, receivedAt } },
  challenges: { [challengeId]: Challenge },
};
```

- `riderId`: 16 random URL-safe characters (`newRiderId(random)`, caller supplies randomness),
  stable for the installation. It is not secret but identifies the rider across sessions.
- `PublicStanding`: `riderId, name, revision, updatedAt, scoringVersion, level ('totals' |
'everything'), asOfWeek, asOfMonth, weeks[] (≤ 8), months[] (≤ 6), weeklyRides[] (≤ 52 ride
counts, for streaks), relay { friendsOfFriends, audience[], exclude[] }`. Periods without rides
  are omitted; a covered period that is missing had none. Best efforts appear only at
  `everything`.
- `standingFor(standing, level)`: `none` → `null` (nothing is sent), `totals` → best efforts
  removed, `everything` → unchanged. It never adds information.
- The own standing gets a new `revision` (and `updatedAt = now`) whenever its content changes
  or every 6 h while sharing (`STANDING_REFRESH_MS`); both only ever increase.
- Contacts: added on the first shared session (`meetContact`, done by `mergeIncoming`),
  `renameContact` (local alias), `setContactVisibility`, `removeContact`, `unblockContact`.
  **Removing is blocking**: the contact's cached standing (and everything that reached us only
  through them) is deleted, a tombstone keeps them from being re-added, their documents are
  ignored, we publish nothing while they are in a session, and our relay policy excludes them.

## Visibility under a broadcast transport

The transport shares **one** document per kind with the **whole** session; we cannot tailor a
document per peer. Options considered:

1. Separate kinds `standing-totals` / `standing-full` — doesn't help: every peer can fetch every
   kind, so the full one could only be published when everybody may see it anyway, and it costs
   a kind and bytes.
2. **Publish at the most restrictive level among the riders present** — chosen.

`sessionLevel(state, peers)` is the minimum over all riders present of what each may see of
me; an **unidentified** rider (no `fl-standing` received yet) and an **empty session** count as
`none`, a **removed** rider present makes us `silent` (no documents at all, not even identity).

**No-leak argument.** Everything we publish is a function of that minimum, so every rider in the
session — including the most restricted — is allowed to see all of it. The only thing an
unidentified rider ever receives is our identity (`riderId` + display name, which the P2P layer
shows anyway); it is needed so riders can recognise each other at all. A removed rider can see
our identity only until we have identified them. Data received earlier is kept by its
recipients — that is inherent to sharing.

**Trade-off.** One rider with a restrictive setting downgrades what everybody in that session
gets (e.g. no best efforts). Values received in earlier sessions stay, and friends catch up in
the next session without that rider.

**Transport race (integration requirement).** The P2P layer serves our current documents to a
newly connected peer by itself. The app must therefore re-run `documentsToShare` **synchronously
in the peer-join handler** (`GroupRide.onPeerJoined`), before the newcomer's data channel can
open — the channel needs further signalling round-trips, and requests are only answered for the
current document of a kind, so a synchronous reshare wins (see [`p2p.md`](p2p.md#peer-join-ordering)).
The newcomer is then unidentified → identity only. The app does exactly this; see
[Integration](#integration-in-the-app).

## Relaying (friends of friends)

Rider B passes on standings it holds for **its own contacts** (direct friends of the origin) —
never riders it only knows second-hand, so data travels at most one hop beyond the origin's
friends. Relayed entries are always stripped to `totals` and keep the origin's `riderId`,
`revision` and `updatedAt`. The origin decides who may receive them second-hand through the
`relay` policy inside its own standing:

- `audience`: the origin's contacts it shares at least totals with (most recently seen first, ≤ 48).
  Always on: it lets my friends see my latest totals through a mutual friend while I am offline,
  and these riders may see my totals directly anyway — nothing new is revealed to them.
- `friendsOfFriends` (setting "friends of friends may see my totals", **default off**) plus
  `exclude`: the contacts I set to `none` or removed (≤ 48). With it on, a mutual friend may pass
  my totals to anyone they ride with except the excluded riders. If the exclusion list would not
  fit, the flag is published as off (fail closed).

A relayer only relays an entry if **every** identified rider present is allowed by that policy
(and the origin itself is not present — it publishes directly); receivers check the policy again
and drop entries not meant for them.

Why default off: in a small trusted group, "friends of friends" usually means people you have
never ridden with; seeing their totals is nice for group challenges but it is their decision
to make, not their friends'. With the audience list, the main goal — seeing _your_ friends who
are not online — works without the flag. What it costs: the audience/exclusion lists reveal to
recipients which rider ids are my friends (or blocked); recipients can match ids they know.
In a friend group this is acceptable (and is what makes "mutual friends" work); it is
documented in the settings text.

## Gossip

### Wire documents

Three kinds (≤ 16 KiB each; together ≤ 24 KiB by default so a workout still fits into the
transport's 4 kinds / 32 KiB per rider):

```jsonc
// fl-standing — identity, plus the own standing when the session level allows it
{ "f": "freilauf-community", "v": 1, "t": "standing", "from": "<riderId>", "name": "Anna", "s": <standing>? }
// fl-challenges — challenges I take part in (≤ 16)
{ "f": "freilauf-community", "v": 1, "t": "challenges", "from": "<riderId>", "c": [<challenge>, …] }
// fl-relay — friends' standings, totals only (≤ 32)
{ "f": "freilauf-community", "v": 1, "t": "relay", "from": "<riderId>", "e": [<standing>, …] }
```

Standing (compact keys):

```jsonc
{ "id": "<riderId>", "n": "Anna", "r": 12, "u": 1763463600000, "sv": 1, "l": "t" /* or "e" */,
  "aw": "2026-W47", "am": "2026-11",
  "w": [["2026-W47", rides, movingS, distanceM, elevationGainM, energyKj, points, groupRides, rideDays /*, p5s, p1m, p5m, p20m when "e" */]],
  "m": [["2026-11", …same columns…]],
  "h": [2, 3, 0, 4],            // rides per week, index 0 = "aw"
  "ff": 0, "au": ["<riderId>", …], "ex": [] }
```

Challenge:

```jsonc
{ "id": "…", "creator": "<riderId>", "title": "500 km together this week", "type": "group-goal",
  "metric": "distanceM", "target": 500000, "week": "2026-W48", "status": "active", "defRev": 3,
  "createdAt": …, "updatedAt": …, "participants": [["<riderId>", "Anna", "accepted", 1, <ms>], …] }
```

Typical sizes: a standing is 0.5–1.2 kB, ~2 kB with a full 48-entry audience; a challenge
0.3–1 kB. A relay document therefore carries 8–32 friends.

### `documentsToShare(state, peersInSession, now, options?)`

Returns `{ state, documents, level, relayed, challenges }`: share exactly `documents`, unshare
the other `COMMUNITY_KINDS`. `peersInSession` is `{ riderId | null }[]` (null until that peer's
`fl-standing` arrived). Priority within the budget (`maxTotalBytes` default 24 KiB,
`maxDocumentBytes` ≤ 16 KiB): own standing (always), then challenges (those with a participant
present first, then most recently updated; only current ones — week not over by more than 14
days), then relays newest `updatedAt` first. Parts are added only while they fit; the caps are
never exceeded.

### `mergeIncoming(state, fromPeer, documents, now)`

Pass all documents a peer currently shares, whenever one becomes available (repeat calls are
idempotent). Returns `{ state, riderId, changes }` (`riderId` = the sender, to map p2p peer →
rider; `changes` for the UI: `contact-added`, `standing-updated`, `challenge-added/updated`,
`rejected`, `ignored`). Rules:

- Without a valid `fl-standing` nothing is merged. Documents from myself and from removed riders
  are ignored. The sender becomes a contact / its `lastSeen` is updated.
- **Newest revision per rider wins**; older and duplicate copies are ignored. At equal revision a
  direct copy beats a relayed one and `everything` beats `totals` (redactions of one revision).
  Relays therefore never override a direct copy with a higher revision.
- Relayed entries about myself, about the sender, about removed riders, or not allowed for me by
  the origin's relay policy are ignored. Unknown riders are stored as **friends of friends**: not
  contacts, not on the friends leaderboard, visible only in a challenge that links us.
- **Validation** (a failing document is rejected as a whole and changes nothing): ≤ 16 KiB UTF-8
  before parsing; exact envelope; ids `^[A-Za-z0-9_-]{8,32}$`; names ≤ 200 chars raw, sanitised
  to 32 code points (control, bidi and zero-width characters removed); integers only; per period
  `movingS ≤ rideDays × 24 h`, `points ≤ rideDays × 500`, `rideDays ≤ min(7|31, rides)`,
  `groupRides ≤ rides`, ≤ 2000 km / 100 km climbing / 60 000 kJ / 100 rides per week (×4.5 per
  month), best efforts ≤ 2500 W; periods inside the covered range, no duplicates; history
  consistent with the week rows; `asOfWeek/Month` consistent with `updatedAt` in some real
  offset (±14 h); `updatedAt` ≥ 2020 and ≤ now + 10 min; ≤ 8 weeks, 6 months, 52 history
  entries, 48 audience/exclude ids, 32 relay entries, 16 challenges, 16 participants.
- Never throws (an internal error returns the input state unchanged).

## Challenges

| Template         | Metric                                    | Target                  | Progress                                                                                                                                    |
| ---------------- | ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `personal-goal`  | distance / elevation / ride time / points | per rider               | each participant vs. the target                                                                                                             |
| `group-goal`     | same                                      | shared (≤ 16× week cap) | sum of accepted participants (`combined`, `partial`)                                                                                        |
| `duel`           | points                                    | —                       | 2 riders; `leader`, at the end `result` winner/draw                                                                                         |
| `streak`         | rides per week                            | N (1–14)                | consecutive weeks with ≥ N rides from `week` on; the current (or latest known) week never breaks it; open-ended; 52-week history (`capped`) |
| `consistency`    | ride days                                 | N (1–7)                 | distinct local days with a ride in the week                                                                                                 |
| `beat-your-best` | p5m / p20m                                | —                       | best of the challenge week > best of the 4 weeks before (needs `everything`; otherwise unknown)                                             |
| `ride-together`  | group rides                               | N (1–20)                | rides flagged as group rides in the week                                                                                                    |

All week-based challenges use one ISO week; each rider's week is their own local week.
`challengeProgress(challenge, standingsByRider, now)` returns status (`upcoming`, `running`,
`finished`, `cancelled`), start/end/remaining time (viewer's offset), per-participant value,
fraction, completion and `final` (the rider's standing was produced after the week ended), the
group sum, the leader (null on a tie) and, for duels after the week, `{ winner | draw,
provisional }` (`provisional` until both standings are final). Progress is always derived from
standings (`allStandings(state, now)` includes the own one); nothing progress-like is read from
the wire.

Lifecycle: `createChallenge` (creator accepted, `defRev 1`), `inviteToChallenge` (creator only,
`defRev + 1`, duel max one opponent, otherwise 16), `respondToChallenge` (`invited|declined →
accepted`, `invited → declined`), `leaveChallenge` (`accepted → left`, may re-accept),
`cancelChallenge` (creator, final). Every own response bumps the participant's `rev`.

**Conflict rules** (`mergeChallenge(local, incoming, me, from)`):

1. Unknown challenges are accepted only if they list me — and the sender — as participants
   (others are not stored: bloat guard).
2. `id`, `creator`, `type`, `createdAt` never change; a copy that disagrees is ignored.
3. Definition (title, metric, target, week, status): higher `defRev` wins; equal `defRev` with
   different content: the copy received directly from the creator wins, otherwise local stays.
   Cancellation is sticky.
4. Participants: union by rider id within the template cap; per participant the higher `rev`
   wins (equal → local). My own entry is never changed from outside.

Challenges are published to the session at level ≥ `totals` only; their title, type and
participant names/ids are visible to everybody present at that level.

## Leaderboards

`leaderboard(state, { period, metric, scope: 'friends' | challengeId }, now)` → rows `{ rank,
riderId, name, value, deltaToYou, stale, you, relation }`, sorted by value (ties: same rank,
competition ranking 1, 1, 3; then by name). `friends` = me + non-removed contacts with a standing;
a challenge id = its accepted participants (friends of friends included). Riders without a
standing covering the period are **absent, not zero**. `stale` = the standing is older than 36 h
and was produced before the period ended. Metrics: `TOTALS_METRICS` (points, distance, ride
time, elevation, energy, rides, group rides, ride days) — never average speed.

## Limits

| What                            | Limit                                            |
| ------------------------------- | ------------------------------------------------ |
| Community documents             | 3 kinds, ≤ 16 KiB each, ≤ 24 KiB total (default) |
| Relayed standings per document  | 32                                               |
| Challenges per document         | 16                                               |
| Participants per challenge      | 16 (duel: 2)                                     |
| Standing                        | 8 weeks, 6 months, 52 weeks of ride counts       |
| Relay audience / exclusion list | 48 ids each                                      |
| Contacts / removed (tombstones) | 500 / 500 (least recently seen evicted)          |
| Cached standings                | 300 (friends of friends first, then oldest)      |
| Stored challenges               | 64 (least recently updated evicted)              |
| Own rides kept                  | 5000 (oldest evicted)                            |
| Names / titles                  | 32 / 60 code points                              |
| Clock skew accepted             | 10 min in the future                             |

`estimateStateBytes(state)` reports the persisted size; a busy rider with 200 rides and 50
friends stays well below 1 MB.

## An optional always-on relay peer (not implemented)

A self-hosted container could run a headless Freilauf peer with its own `riderId` that joins a
standing room. Friends add it as a contact (visibility `totals`), and it would simply run the
same `documentsToShare` / `mergeIncoming` loop: it **stores its friends' standings** and passes
them on to whoever joins later, like any friend would (subject to the same relay policies; the
peer's own audience entry in each friend's standing is what allows it). Nothing depends on it:
without it, values travel whenever friends meet. It is **not implemented here**; it would need
a Node wrapper around `@freilauf/p2p` with a WebRTC implementation, persistence of the state
JSON, and a way to keep a room open.

## Deliberately out of scope

- **Anti-cheat.** Data is trust-based; validation only keeps values plausible and bounded.
  There are no signatures: a peer could forge another rider's standing or challenge response
  (bounded by the caps and the "newest revision" rule).
- **Other sources** (FIT imports, other apps): prepared via `source` and `scoringVersion`, not
  implemented.
- Automatic challenges, uninviting participants, editing a challenge's target after creation.
- Deletion requests to other riders: once shared, data stays with the recipient until it is
  replaced or evicted.

## Integration in the app

Implemented in `apps/desktop/src/renderer/core/communityService.ts` (`CommunityService`, no
DOM/Electron; clock, UTC offset, randomness, timers and storage are injected) and wired into the
app store (`apps/desktop/src/renderer/main/appStore.ts`); the browser build uses the same code.

- **Storage**: one `CommunityState` JSON in `localStorage` under `freilauf.community.v1`
  (period accumulators are stripped — `migrate` rebuilds them from the facts), plus a small
  `freilauf.community.v1.meta` (backfill marker, selected leaderboard). Loaded with `migrate`;
  unreadable data is copied once to `freilauf.community.v1.corrupt` and replaced by a fresh
  state; blocked storage works in memory. Saves are debounced (2 s) and flushed on close.
  A failing `setItem` (quota) keeps the data in memory, shows one notice and retries on the
  next change (`state.community.storage.saveFailed`).
- **Size**: realistic use (a few hundred rides, dozens of friends) is ~0.1–0.5 MB. At every cap
  at once (5000 rides, 500 contacts + 500 tombstones, 300 cached standings, 64 full challenges)
  the persisted JSON is ≈ 4 MB (≈ 485 B per ride, ≈ 4 KB per cached standing) — close to the
  ~5 M characters Chromium allows per origin, which the workout library shares. That is why
  save failures are handled; moving the state to IndexedDB/the main process would be the next
  step if it ever matters.
- **Rides**: `finishRide` → `recordRide(ride, { ftpW: settings FTP during the ride, groupRide:
another rider was in the group at some point of the ride })`; idempotent per ride id.
  Deleting a ride from the history → `removeRide`.
- **Backfill**: once per installation (marker in the meta key) the service lists the saved rides
  (`FreilaufApi.rides.list`) and loads the finished ones that are not in the ledger yet with the
  additive `FreilaufApi.rides.load(id)` (desktop: IPC `rides:load` → `RideStore.loadRide`;
  browser: IndexedDB), oldest first, four per step with a yield in between. The FTP is the
  **current** one, an approximation for older rides, flagged with `backfilled: true` in the
  facts; `groupRide` is unknown and stored as false. Rides deleted meanwhile are skipped. A
  failed run (e.g. the list could not be read) is retried on the next start.
- **Profile**: the display name follows `settings.rider.name`.
- **Document kinds** in a session: `fl-standing`, `fl-challenges`, `fl-relay`, next to `workout`
  — 4 kinds, the transport's maximum. The community budget is `min(24 KiB, 32 KiB − bytes of the
other local documents)`; before the rider shares a workout the app re-publishes with the
  workout's size reserved (`makeRoom`), so the workout always fits and challenges/relays shrink.
  A community document the transport refuses is withdrawn (fail closed), never left at an older
  version.
- **Sync** (`attach(group)` on entering a group, `detach()` before leaving): a map p2p peer id →
  rider id (null until that peer's `fl-standing` arrived; the rider id comes from
  `mergeIncoming`). Re-published synchronously on peer join (`onPeerJoined`, before the
  newcomer can be served), on membership changes, after every merge that changed state or
  identified a peer, after own rides and every user action (visibility, removal, challenges),
  and every 5 minutes (standing refresh, contacts' last-seen). Documents of a peer are merged
  whenever its set of community document ids changes, only while it is in the room.
- **No-leak test**: `communitySync.integration.test.ts` runs riders over the real `GroupRide`,
  the fake WebRTC network (delays, duplicates, loss, reordering) and the in-process signalling
  hub: A publishes at `everything` with B present, then C joins (unknown, or a contact set to
  `none`) — C never receives A's richer standing (`"l":"e"`, resp. any standing). Disabling
  the "unidentified counts as `none`" rule makes these tests fail.
- **Time**: views are computed with "now" rounded down to the minute and refreshed by the app's
  tick only when the minute changes (period rollover, remaining time, staleness).
- **Log** (source `community`): load/save problems, rides added/removed (counts only),
  publishing level changes (counts), merge summaries (change counts, rejection reasons),
  challenge actions (type only), backfill result.

### What the UI gets (`state.community`, `CommunityView`)

`profile` (riderId, name, defaultVisibility, friendsOfFriends) · `week` / `month` (key, bounds,
`PeriodTotals` with points and best efforts) · `leaderboard` (the selected period/metric/scope,
`periodKey`, rows) · `challenges` (each with `progress` from `challengeProgress`, `myState`,
`isCreator`, `canInvite`) · `invitations` · `contacts` (display name, visibility, present,
latest standing's age/staleness/relayer) · `blocked` · `session` (peers, identified, level) ·
`backfill` · `storage`. Every part keeps its object identity while its content is unchanged.
Actions on `App`: `setLeaderboardView`, `communityLeaderboard`, `setContactVisibility`,
`renameContact`, `removeContact`, `unblockContact`, `setDefaultVisibility`,
`setFriendsOfFriends`, `createChallenge`, `inviteToChallenge`, `respondToChallenge`,
`leaveChallenge`, `cancelChallenge` (results `{ ok: true } | { ok: false, error }` with a
message for the rider). `CHALLENGE_TEMPLATES` describes the seven templates (metrics, target
ranges) for the creation form.

### The Community tab

`apps/desktop/src/renderer/main/ui/CommunityTab.tsx` (with `CommunityChallenges.tsx`,
`CommunityFriends.tsx` and the pure helpers in `communityView.ts`), after the Group tab, in the
desktop app and the browser build alike:

- **Your week**: points large, distance, ride time, elevation, energy and rides of the current
  week, the month so far, a one-line explanation of points and a "How points work" disclosure
  (1 h at FTP = 100, intensity squared, IF cap 1.3, 400 per ride / 500 per day, scored once with
  the FTP of the time). While the FTP is still the default, or rides this week scored 0, a note
  points to the FTP tests.
- **Leaderboard**: this week / last week / this month / last month × points, distance, time,
  elevation, energy, rides (`setLeaderboardView`); rows with rank (ties share it), value, the
  difference to you, your own row highlighted, stale standings dimmed with their age
  ("updated 5 d ago") and relayed ones marked "via <friend>". Riders who share nothing are
  absent, which a footnote says. Without friends an empty state explains that friends appear
  after the first group ride and that standings travel only between riders in a session.
- **Challenges**: invitations first (accept / decline), then running, upcoming and finished
  ones. Each card shows the type in plain words, the week, the time left and a visual per
  type — bars for personal goals, one stacked bar of everyone's contributions for a group
  goal, two opposing bars with the leader (or the result, marked provisional) for a duel, week
  dots for a streak, day dots for consistency, "before" vs "this week" for beat-your-best,
  ride dots for ride-together — plus the participants with their invitation state and the
  actions (invite a contact, leave, join again, cancel for the creator). "New challenge" picks
  one of the seven templates, then measure, target (in km / h / m / points, range from
  `CHALLENGE_TEMPLATES`), week, optional title and friends to invite; errors from
  `createChallenge` are shown as returned.
- **Friends & privacy**: the session rule in plain words (everyone present receives the same
  data, so only what the most restricted rider present may see is published) and, in a group,
  the current level ("Sharing totals with this session" / "Sharing nothing: someone here is set
  to Nothing or is not yet identified"); each contact with last seen, "here now", the age and
  relayer of their standing, "They see: Nothing / Totals & points / Everything (incl. best
  efforts)", rename, and remove with an inline confirmation that explains the blocking; the
  removed riders with unblock; the default for new friends and the "friends of friends may see
  my totals" switch with what it reveals.
- Status lines for a running backfill ("Adding 12 earlier rides… 4 of 12 done") and a failed
  save.

## Integration checklist (app)

1. **State storage**: keep one `CommunityState` JSON per installation (e.g. in the app's user
   data next to the ride library). Load with `migrate(raw, random, Date.now())` — it repairs or
   replaces corrupt data; persist after every change (debounced). On first start
   `emptyState(newRiderId(random), name, now)` (`random` backed by `crypto.getRandomValues`).
2. **Facts**: when a ride is saved, call `rideFacts({ rideId, startedAt, samples, ftpW,
utcOffsetMin: -new Date(startedAt).getTimezoneOffset(), groupRide })` with the FTP in force at
   that time and `groupRide = at least one other rider was in the session`; then `addRide`.
   On delete: `removeRide`. For existing rides, backfill once (facts are never recomputed later).
3. **Now**: pass `{ ms: Date.now(), utcOffsetMin: -new Date().getTimezoneOffset() }` everywhere.
4. **P2P**: use kinds `fl-standing`, `fl-challenges`, `fl-relay` (`COMMUNITY_KINDS`); with a
   workout shared as well that is 4 kinds. Keep the default 24 KiB budget, or pass
   `maxTotalBytes = 32768 − bytes of other shared documents`.
   - Keep a map p2p `peerId → riderId | null`.
   - On every membership change (synchronously in the handler, see the race note above), after
     every merge that identified a peer, after rides or settings changed, and every few minutes:
     `documentsToShare(state, peers, now)` → `shareDocument(kind, text)` for each returned
     document and `unshareDocument(kind)` for the other community kinds; store the new state.
   - On `onDocument` `available`: collect that peer's community documents from
     `getSharedDocuments()` and call `mergeIncoming(state, { peerId, peerName }, docs, now)`;
     update the map with `riderId`, store the state, show `changes`.
5. **UI**: done in this app — see [The Community tab](#the-community-tab).
