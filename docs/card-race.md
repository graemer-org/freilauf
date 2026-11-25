# Card Race

A playful mode for group rides. Everyone holds up to **two cards** and plays them with the two
side buttons: speed yourself up, slow down the rider directly ahead with a headwind, fog the
leader's view of the gaps, or raise a shield. Attacks are gentle and short, and after every hit
a rider is protected for a while, so nobody gets pinned down.

As with [power-ups](power-ups.md), cards only move your **race position**. What you ride is what
is recorded: distance, speed, the `.fit` file, points, personal bests and challenges come from
your own legs, and **no card ever changes the trainer's resistance** — a rider who is hit loses
race position, not watts.

How it is built: [ADR 0007](adr/0007-card-race.md).

## Starting a Card Race

Whoever creates the group ride chooses how it plays. On the start screen, under **With whom →
Group ride**, pick **Card Race** above **Create group ride** (the other choice, **Normal**, is a
group ride with power-ups as usual). Then send the invite as always
([Ride with friends](group-rides.md)).

Everyone in the room sees which mode applies: on the start screen's group card and in the ride
view's **Group** panel ("This ride · Card Race · Chosen by the host"), and in the overlay above
the rider list. The host can switch between Normal and Card Race in the same place at any time,
also during the ride; guests cannot.

## Getting cards

Exactly as power-ups: ride through the softly lit **gates** on the road (every 2–4 km; on a
route everyone meets the same gates with the same card at each), or meet an **effort challenge**
when it is offered. In a Card Race a gate can give any card; boosts are the most common.

You hold **two cards**: the first one you get goes to the **left** slot, the next to the
**right**. Playing a card empties its slot; the next card fills the first empty slot. With both
slots full a gate gives nothing ("Hand full · play a card first").

## Playing cards

| Card on the left                       | Card on the right                       |
| -------------------------------------- | --------------------------------------- |
| **Left side button** of the controller | **Right side button** of the controller |
| **P** on the keyboard                  | **L** on the keyboard                   |
| or click the card                      | or click the card                       |

The hand sits along the bottom of the ride scene, left card on the left, right card on the
right. Each card shows its icon, its name and, for an attack, whom it would hit now
("→ Ben · Left button or P"). When a card cannot be played right now, the card says why instead
(for example "Nobody ahead of you", "Ben is protected · 12 s", "After your boost") and stays in
your hand — pressing the button then does nothing.

The controller's side buttons do this when they are set to **Use power-up** (the default): the
right grip's side button plays the right card, any other button set to it plays the left one.

## The cards

| Card                  | What it does                                                                                    | How long                              |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Tailwind**          | You: 40 % less air resistance.                                                                  | 15 s                                  |
| **Slipstream**        | You: 25 % less air resistance.                                                                  | 30 s                                  |
| **Light load**        | You: 12 % less mass on climbs.                                                                  | 25 s                                  |
| **Downhill momentum** | You: on the next descent, 30 % less air resistance and half the rolling resistance.             | 20 s, waits up to 3 min for a descent |
| **Headwind**          | The rider **directly ahead** of you: 60 % more air resistance. About 15 m at 200 W on the flat. | 10 s                                  |
| **Fog**               | The **leader** (the rider furthest ahead) cannot see the gaps: their list shows "?".            | 12 s                                  |
| **Shield**            | You: raised when played; it **blocks the next attack** aimed at you, then it is gone.           | up to 60 s                            |

The four boosts are the [power-ups](power-ups.md) — one boost at a time. Headwind costs the
target less than a Tailwind gains (on a climb, where air matters little, it costs almost
nothing): a nudge, not a different race. Fog changes nothing but what the leader's own screen
shows.

**Why the shield is raised by playing it** (and not held passively): every card in your hand
works the same way — you decide when; the bubble around you tells everyone it is up, so an
attacker can choose to wait; and a shield never quietly takes a card slot away from you.

### Directly ahead, the leader

Headwind goes to the nearest rider ahead of you in the race, Fog to the rider furthest ahead.
Riders level with you (within 10 m), riders without a signal, riders who are paused or in an
ERG step, and riders whose app has no Card Race are passed over. If you lead, Fog has no target
("You are leading"); with nobody ahead, Headwind has none.

### Protection

After any hit — and after an attack their shield blocked — a rider is **protected**: no attack
lands on them while an attack acts on them and for **15 s** after it. A faint ring with a
countdown around them shows it, and your attack card waits ("Ben is protected · 12 s") instead
of being wasted. If an attack still reaches a protected rider (two riders playing at the same
moment), it does nothing and the card goes back into the attacker's hand.

## What you see

- **Your hand** at the bottom of the scene, and between the two cards what acts on you now: your
  boost, the shield, protection or an attack ("Headwind · from Anna · 7 s"). Below them, how
  much your race position moved: "+12 m from cards · −8 m from attacks".
- **A notice at the top** when something happens: "Anna played Headwind on you", "Your shield
  blocked Anna's Headwind", "Headwind hit Ben", "Ben's shield blocked your Headwind", or "Ben is
  protected · the card is back".
- **In the scene, on you:** Headwind — gust lines arriving from ahead and curling off you; Fog —
  a soft haze over your view; Shield — a calm bubble; protection — a faint ring.
- **On other riders**, where they are drawn: the same gusts, bubble and ring, and a small cloud
  over a fogged leader. The **Group** panel names what acts on each rider (Headwind, Fog,
  Shield, Protected).
- **Fog on you:** your rider list, overlay and the name labels in the scene show "?" instead of
  gaps until it lifts. Everyone else still sees theirs.
- **The overlay** shows the attack on you ("Headwind from Anna · 7 s"), your hand ("L Headwind ·
  R Shield" with **P / L** when a card can be played), your boost, shield or protection, and
  "Card Race" above the rider list. Its text stays fully opaque with an outline; only the
  backdrops fade.

With reduced motion (your system's accessibility setting) gusts and notices do not move; the
scene shows the effects still.

## The fairness rule

Cards move only your **race position** — where you are placed among the others, on the road and
in the rider list. In a Card Race it can be **behind** your ridden position after attacks; in a
normal ride it never is.

Your **recorded** ride — speed, distance, time, the `.fit` file, points, personal bests,
community challenges — is the real physics of your power, with or without cards and attacks,
and the trainer's resistance is never changed by any card. After the ride the summary shows the
race-position difference on its own line, e.g. "**+38 m from cards** and **−24 m from attacks**
in your race position".

## Where cards do not apply

- **ERG workout steps** and **FTP tests**: no cards are collected or played, attacks pass you by
  (you are out of the race until the step ends); held cards stay.
- **Paused**: attacks pass you by.
- **Settings → Power-ups off**: no cards, and you cannot be attacked.

## Compatibility with older apps

A Card Race needs the Card Race on every rider's app. A rider whose app does not have it can
still join and ride along, but the room says so: "**Anna's app does not support Card Race**:
they ride along with normal power-ups and cannot be attacked." Their app shows the others at
their race positions without the losses from attacks (an attacked rider looks a few metres
further ahead there). Update every app to race together.

## Trust

Like group rides in general, the Card Race is trust-based: there is no anti-cheat. But an app
only accepts an attack that is meant for it, comes from a rider in the room, is a known card,
has not been seen before, is not one of too many from the same rider, and is plausible (the
attacker is behind, and — for Headwind — nobody is in between; for Fog, nobody is ahead). So a
buggy or hostile app cannot pin anyone down or crash anyone's screen.

The name "Card Race" is a working title; it is defined in one place in the app
(`CARD_RACE_NAME`).
