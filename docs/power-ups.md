# Power-ups

A little play in a ride: now and then you collect a power-up on the road, or earn one with a
short effort, and use it when it suits you. Power-ups never touch what is recorded — your
ride, its `.fit` file, points, personal bests and challenges always come from your own power.

## Getting one

**On the road.** Every 2–4 km a softly lit gate stands across your lane. Ride through it and
you hold a power-up. On a route the gates stand at fixed places on that route, so everyone
riding it — in a group too — meets them at the same spots; in a free ride they are spread along
your ride. In the road view you see the gate coming from a few hundred metres away; in the side
view a small tag at the right edge says how far the next one is.

You hold **one** at a time. Riding through a gate while you hold one does nothing except a
quiet "Already holding a power-up".

**By effort — an offer, never a nag.** When your power has clearly dropped for a few minutes,
the app sometimes offers a short challenge, for example _Hold 250 W for 30 s_. The card shows
the target, your power against it and a countdown. Reach the target and hold it, and you get a
power-up. Miss it, ignore it or wave it away (×) and nothing happens.

Exactly when it is offered:

- your 3-minute average power is at least 12 % below the 5 minutes before it (so the earliest
  offer comes 8 minutes into the ride, and never in the first 5);
- you are riding (not paused), not in an ERG workout step, not in an FTP test, and not
  descending (the road at −2 % or steeper, or the last 3 minutes downhill on average);
- you are not holding a power-up and none is running;
- at most once every 10 minutes.

The target is about 115 % of your last 3 minutes, never more than 105 % of your FTP, rounded to
5 W. You have 20 s to reach it; the 30 s hold starts when you do (a dip of up to 3 s is
forgiven).

## Using one

Press **the side button** of a controller — "Lever click / side button" on either grip, the
default for both — or **P** on the keyboard, or click the card in the bottom-right corner of
the ride scene. The card turns into a ring that runs down while the effect lasts.

| Power-up              | What it does                                                                                                                           | How long                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Tailwind**          | 40 % less air resistance: a strong, short push. Light streaks flow past.                                                               | 15 s                                         |
| **Slipstream**        | 25 % less air resistance, as if you were sitting in someone's wheel. A faint rider rides just ahead of you.                            | 30 s                                         |
| **Light load**        | 12 % less mass, so climbs go faster (it does nothing on the flat or downhill). A soft glow around you.                                 | 25 s                                         |
| **Downhill momentum** | Waits for the next descent (−2 % or steeper), then 30 % less air resistance and half the rolling resistance. Chevrons run on the road. | 20 s, armed for up to 3 min; unused, it ends |

One effect at a time: while one runs, a held power-up waits. A typical effect gains you
20–60 m — noticeable in a close finish, never a different race.

## The fairness rule

Power-ups move only your **race position**: where you are placed among other riders, on the
road and in the group list. Your **recorded** ride — speed, distance, time, the `.fit` file,
points, personal bests, community challenges — is the real physics of your power, with or
without power-ups. The summary after the ride shows the difference on its own line, e.g.
"+38 m from power-ups in your race position".

Power-ups never change the trainer's resistance either.

## Where they do not apply

- **ERG workout steps** (the trainer holds the power) and **FTP tests**: no gates are shown and
  none can be used; one you hold stays with you, and one running ends.
- **Group rides**: allowed by default. The host can switch them off for everyone under
  **Group → Power-ups in this ride**; guests then see "The host has switched power-ups off".

## In Freilauf Rumble

A group ride can be a [Freilauf Rumble](rumble.md): the gates become **feed bags** at the
roadside (same spacing, same spots for everyone on a route), each gives a random **item**, and
you hold two (left and right side button, or P and L). Next to the four boosts there are a water
bottle for the rider directly ahead, a mud puddle to drop behind you, hornets for the leader and
a rain cape. The fairness rule stays: only race positions move — there, after hits, also
backwards ("−24 m from hits").

## Settings

**Settings → Power-ups**: _Power-ups_ (on/off) and _Effort challenges_ (on/off). Both are on by
default. The controller mapping is under **Devices → Controllers → Controller buttons**; if you
had given the side buttons another action before power-ups existed, that action stays.

The overlay shows what you hold, what is running and a challenge, compactly in its top row.

With reduced motion (your system's accessibility setting) the streaks and moving chevrons are
left out; the scene shows the effects still, and the card says what is running.

How it is built: [ADR 0006](adr/0006-power-ups.md).
