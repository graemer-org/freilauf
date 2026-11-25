# Freilauf Rumble

A playful battle mode for group rides. Ride past the **feed bags** at the roadside to pick up
items, hold up to **two** of them and use them with the two side buttons: speed yourself up,
throw a **water bottle** at the rider directly ahead, drop a **mud puddle** behind you, send a
swarm of **hornets** after the leader, or pull on a **rain cape**. Hits are short and gentle,
and after every hit a rider is protected for a while, so nobody gets pinned down.

As with [power-ups](power-ups.md), items only move your **race position**. What you ride is
what is recorded: distance, speed, the `.fit` file, points, personal bests and challenges come
from your own legs, and **no item ever changes the trainer's resistance** — a rider who is hit
loses race position, not watts.

How it is built: [ADR 0008](adr/0008-rumble-items.md).

- [Starting a Rumble](#starting-a-rumble)
- [Getting items](#getting-items)
- [Using items](#using-items)
- [The items](#the-items)
- [The mud puddle](#the-mud-puddle)
- [Protection](#protection)
- [What you see](#what-you-see)
- [The fairness rule](#the-fairness-rule)
- [Where items do not apply](#where-items-do-not-apply)
- [Compatibility with other apps](#compatibility-with-other-apps)
- [Trust](#trust)

## Starting a Rumble

Whoever creates the group ride chooses how it plays. On the start screen, under **With whom →
Group ride**, pick **Freilauf Rumble** above **Create group ride** (the other choice, **Normal**,
is a group ride with power-ups as usual). Then send the invite as always
([Ride with friends](group-rides.md)).

Everyone in the room sees which mode applies: on the start screen's group card and in the ride
view's **Group** panel ("This ride · Freilauf Rumble · Chosen by the host"), and in the overlay
above the rider list. The host can switch between Normal and Freilauf Rumble in the same place
at any time, also during the ride; guests cannot.

## Getting items

- **Feed bags.** Every 2–4 km a feed bag (a cyclist's musette) is held out over your lane from
  a stand at the roadside. Ride past it and you take a **random item**. On a route everyone
  meets the same feed bags at the same places, with the same item in each (the spots and items
  are drawn from the route, exactly like the [power-up](power-ups.md) pick-up spots); in a free
  ride they follow your ridden distance.
- **Effort challenges** give an item too, when one is offered and you meet it.

You hold **two items**: the first one goes to the **left** slot, the next to the **right**.
Using an item empties its slot; the next one fills the first empty slot. With both slots full a
feed bag gives nothing ("Both slots full · use an item first").

What a feed bag gives, by chance:

| Item                                                | Chance                         |
| --------------------------------------------------- | ------------------------------ |
| Tailwind, Slipstream, Light load, Downhill momentum | 2 in 15 each (8 in 15 a boost) |
| Water bottle                                        | 2 in 15                        |
| Mud puddle                                          | 2 in 15                        |
| Rain cape                                           | 2 in 15                        |
| Hornets                                             | 1 in 15                        |

## Using items

| Item in the left slot                  | Item in the right slot                  |
| -------------------------------------- | --------------------------------------- |
| **Left side button** of the controller | **Right side button** of the controller |
| **P** on the keyboard                  | **L** on the keyboard                   |
| or click it                            | or click it                             |

The two slots sit along the bottom of the ride scene, left slot on the left, right slot on the
right. Each shows the item, its name and, for a bottle or the hornets, whom it would hit now
("→ Ben · Left button or P"). When an item cannot be used right now, the slot says why instead
(for example "Nobody ahead of you", "Ben is protected · 12 s", "After your boost", "Cape is
up") and the item stays — pressing the button then does nothing.

The controller's side buttons do this when they are set to **Use power-up** (the default): the
right grip's side button uses the right item, any other button set to it the left one.

## The items

| Item                  | How it is used                                                                                                    | What it does                                                                                        | How long                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Tailwind**          | on yourself                                                                                                       | 40 % less air resistance.                                                                           | 15 s                                  |
| **Slipstream**        | on yourself                                                                                                       | 25 % less air resistance.                                                                           | 30 s                                  |
| **Light load**        | on yourself                                                                                                       | 12 % less mass on climbs.                                                                           | 25 s                                  |
| **Downhill momentum** | on yourself                                                                                                       | On the next descent, 30 % less air resistance and half the rolling resistance.                      | 20 s, waits up to 3 min for a descent |
| **Water bottle**      | thrown in an arc at the rider **directly ahead**; it homes in, so it only misses a protected rider or a rain cape | The rider hit is **slowed**: twice the air resistance.                                              | 10 s                                  |
| **Mud puddle**        | dropped on the road **behind you**                                                                                | The next rider through it is **slowed**: three times the air resistance.                            | 5 s; the puddle dries up after 60 s   |
| **Hornets**           | a swarm that chases the **leader**, however far ahead                                                             | The leader is **slowed** (2.2 times the air resistance) and their own screen shows the gaps as "?". | 8 s                                   |
| **Rain cape**         | on yourself, when you choose                                                                                      | Keeps off the next hit — bottle, puddle or hornets — then it is used up.                            | up to 60 s                            |

The four boosts are the [power-ups](power-ups.md) — one boost at a time. A hit costs about as
much as a boost gains: at 200 W on the flat a Tailwind gains about 19 m and a Slipstream about
24 m; a bottle, a puddle or the hornets each cost about 24 m. On a climb, where air matters
little, a hit costs much less. A nudge, not a different race.

**Why the rain cape is pulled on when you use it** (and not worn passively): every item works
the same way — you decide when; the cape around you tells everyone it is on, so a thrower can
choose to wait; and a cape never quietly takes a slot away from you.

### Directly ahead, the leader

The bottle goes to the nearest rider ahead of you in the race, the hornets to the rider furthest
ahead. Riders level with you (within 10 m), riders without a signal, riders who are paused or
in an ERG step, and riders whose app has no Freilauf Rumble are passed over. If you lead, the
hornets have no target ("You are leading"); with nobody ahead, the bottle has none.

## The mud puddle

A puddle is not aimed at anyone: it lies on the road, 2 m behind where you were when you
dropped it, and stays there.

- **Everyone sees the same puddle at the same place** — riders behind you see it ahead of them
  ("Ben's mud puddle ahead · 40 m"), you and riders ahead see it behind.
- **It hits one rider at most**: the next one to ride through it. Then it is gone for everyone.
- **It never hits you.** Your own puddles are never yours to ride into.
- **It dries up after 60 s** if nobody rides through it.
- You can have **two puddles** on the road at once ("2 puddles already down").
- A **rain cape** keeps a puddle off like any other hit — the puddle is used up by it.
- A rider who is **protected** (just hit), paused, in an ERG step or with items off rolls
  through without touching it; the puddle stays for the next rider.

Who rode through first is decided by the rider who dropped the puddle, so it is fair even
when two riders reach it at the same moment: exactly one of them is hit. Details:
[ADR 0008](adr/0008-rumble-items.md).

## Protection

After any hit — and after a hit a rain cape kept off — a rider is **protected**: nothing lands
on them while a hit slows them and for **15 s** after it. A faint ring with a countdown around
them shows it, and your bottle or hornets wait ("Ben is protected · 12 s") instead of being
wasted. If an item still reaches a protected rider (two riders using one at the same moment),
it does nothing and the item comes back to your slot.

## What you see

- **Your two slots** at the bottom of the scene, and between them what acts on you now: your
  boost, the rain cape, protection or a hit ("Water bottle · slowed · from Anna · 7 s"), a
  puddle just ahead, and how much your race position moved: "+12 m from items · −8 m from hits".
- **A notice at the top** when something happens: "Ben got you with a water bottle", "You rode
  through Ben's mud puddle", "Ben sent hornets after you", "Your rain cape kept off Ben's water
  bottle", "Your water bottle got Ben", "Cleo rode through your mud puddle", "Mud puddle dropped
  behind you", or "Ben is protected · the item is back".
- **In the scene:** the feed bags at the roadside; the water bottle flying in an arc from the
  thrower to the target (on the thrower's screen; when the target is further than the view, it
  flies out of the frame ahead); on the target's screen it comes in from behind, with a marker
  at the edge ("← Water bottle from Anna"); the swarm of hornets flying up the road to the
  leader; the mud puddle lying on the road; a short splash of water or mud when a hit lands; the
  rain cape around a rider; the protection ring.
- **On other riders**, where they are drawn: water dripping, mud spattered, hornets round the
  head, the cape and the ring. The **Group** panel names what acts on each rider.
- **Hornets on you:** your rider list, overlay and the name labels in the scene show "?"
  instead of gaps until they are gone. Everyone else still sees theirs.
- **The overlay** shows a hit on you ("Water bottle from Anna · 7 s"), your two slots
  ("L Water bottle · R Rain cape" with **P / L** when an item can be used), your boost, a puddle
  just ahead, the cape or protection, and "Freilauf Rumble" above the rider list. Its text stays
  fully opaque with an outline; only the backdrops fade.

With reduced motion (your system's accessibility setting) nothing flies, swirls or drips: the
scene shows every item and effect still.

## The fairness rule

Items move only your **race position** — where you are placed among the others, on the road and
in the rider list. In a Rumble it can be **behind** your ridden position after hits; in a normal
ride it never is.

Your **recorded** ride — speed, distance, time, the `.fit` file, points, personal bests,
community challenges — is the real physics of your power, with or without items and hits, and
the trainer's resistance is never changed by any item. After the ride the summary shows the
race-position difference on its own line, e.g. "**+38 m from items** and **−24 m from hits** in
your race position".

## Where items do not apply

- **ERG workout steps** and **FTP tests**: no items are picked up or used, nothing hits you (you
  are out of the race until the step ends); held items stay.
- **Paused**: nothing hits you.
- **Settings → Power-ups off**: no items, and nothing can hit you.

## Compatibility with other apps

Freilauf Rumble needs it on every rider's app. A rider whose app does not have it — an older
app, including the early test builds with the card-based version of this mode — can still join
and ride along, but the room says so: "**Anna's app does not support Freilauf Rumble**: they
ride along with normal power-ups and nothing can hit them." They are never aimed at and never
hit by a puddle. Their app shows the others at their race positions without the losses from
hits (a rider who was hit looks a few metres further ahead there). Update every app to rumble
together.

## Trust

Like group rides in general, the Rumble is trust-based: there is no anti-cheat. But an app only
accepts a hit that is meant for it, comes from a rider in the room, is a known item, has not
been seen before, is not one of too many from the same rider, and is plausible (the thrower is
behind, and — for the bottle — nobody is in between; for the hornets, nobody is ahead). A rider
who drops a puddle only gives its one hit to a rider of the race who plausibly rode through
it. So a buggy or hostile app cannot pin anyone down or crash anyone's screen.

The name "Freilauf Rumble" is defined in one place in the app (`RUMBLE_NAME`).
