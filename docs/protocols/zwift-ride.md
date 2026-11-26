# Zwift Ride controllers — BLE protocol notes

> **Status: buttons and lever layout verified on hardware (2026-11-22 and
> 2026-11-23, Windows 11).** Written from recollection of public protocol
> write-ups, then corrected against real Ride controllers by pressing every
> button and moving both levers while reading what the app decoded. No code
> was taken from other projects.
>
> - **Confirmed:** pairing through the chooser, the handshake, keypad
>   notifications, **all sixteen button bits** (Z and the right power button
>   included, 2026-11-23), and the **lever (paddle) message layout**: four
>   paddle sub-messages per keypad frame, locations 0 … 3, signed zigzag
>   values −100 … +100 on locations 0 (left grip) and 1 (right grip).
> - **Confirmed by the tester (2026-11-23):** the default lever assignment
>   below — which direction brakes and which steers on each grip — matches
>   the real controllers when checked with the live lever display.
> - **Still not recorded:** what the bits `0x00400` / `0x04000` are
>   physically (a click at the end of the steer travel, or a separate side
>   button that also moves the lever). They are seen only with a lever at
>   the end of its travel. Riders can reassign every direction and button in
>   Devices → Controllers.

The protocol is proprietary and undocumented by the vendor.

## GATT

| What                                 | UUID                                   | Confidence |
| ------------------------------------ | -------------------------------------- | ---------- |
| Service (Ride)                       | `0000fc82-0000-1000-8000-00805f9b34fb` | medium     |
| Service (older Play/Click)           | `00000001-19ca-4651-86e5-fa29dcdd09d1` | high       |
| Async — notify, controller → app     | `00000002-19ca-4651-86e5-fa29dcdd09d1` | high       |
| Sync RX — write, app → controller    | `00000003-19ca-4651-86e5-fa29dcdd09d1` | high       |
| Sync TX — indicate, controller → app | `00000004-19ca-4651-86e5-fa29dcdd09d1` | high       |

The driver tries the Ride service first and falls back to the legacy one.

## Session start

1. Subscribe to Async and Sync TX.
2. Write ASCII `RideOn` (`52 69 64 65 4f 6e`) to Sync RX.
3. The controller answers on Sync TX with `RideOn` followed by two bytes.

The Ride is believed to run **unencrypted** (the older Play controllers
exchange keys after `RideOn` and encrypt; that is not implemented).
The driver does not require the answer: if notifications flow, it works.

## Notifications on Async

First byte = message type, rest = protobuf.

| Type   | Meaning                                    | Confidence |
| ------ | ------------------------------------------ | ---------- |
| `0x23` | Keypad status                              | medium     |
| `0x19` | Battery/status; field 2 (varint) = percent | low        |
| `0x15` | Idle / empty                               | medium     |

**Battery (`0x19`), as the app reads it (unverified):** field 2 = level in
percent (clamped to 100), field 1 (if present) = which grip, 0 = left and
1 = right like the lever locations; without field 1 the level counts for the
controllers as a whole. Each grip is shown separately; once this message has
arrived, a standard Battery Service level (if the controllers expose one) is
no longer used. The capture logs every change with its hex.

### Keypad status (`0x23`)

- Field 1, varint: button bitmap. **A cleared bit means pressed**; idle is
  all ones.
- Field 3, repeated message: analog paddle (lever) — field 1 = location,
  field 2 = sint32 (zigzag) value, **−100 … +100**. Every keypad frame carries
  four of them, locations 0, 1, 2, 3 (proto3 may omit zero fields; the parser
  treats a missing location or value as 0). See [Levers](#levers-paddles).

| Button                                 | Mask      | Status    |
| -------------------------------------- | --------- | --------- |
| D-pad left                             | `0x00001` | confirmed |
| D-pad up                               | `0x00002` | confirmed |
| D-pad right                            | `0x00004` | confirmed |
| D-pad down                             | `0x00008` | confirmed |
| A                                      | `0x00010` | confirmed |
| B                                      | `0x00020` | confirmed |
| Y                                      | `0x00040` | confirmed |
| Z                                      | `0x00080` | confirmed |
| Left grip, upper shift button          | `0x00100` | confirmed |
| Left grip, lower shift button          | `0x00200` | confirmed |
| Left grip, lever click / side button¹  | `0x00400` | confirmed |
| Left grip, power button                | `0x00800` | confirmed |
| Right grip, upper shift button         | `0x01000` | confirmed |
| Right grip, lower shift button         | `0x02000` | confirmed |
| Right grip, lever click / side button¹ | `0x04000` | confirmed |
| Right grip, power button               | `0x08000` | confirmed |

¹ The bit is confirmed, what it is physically is not: it was seen only while
that grip's lever was at the far end of its travel (right: `0x04000` at
+0.87 … +1.00; left: `0x00400` at −1.00), and other strokes reached ±1.00
without it. Either a click at the end of the lever's travel or a side button
that also moves the lever. Internally these are `powerUpLeft` /
`powerUpRight` (names kept for stored settings); the app calls them "Lever
click / side button" and assigns no action by default.

How the table was corrected: with the first guess, the left lower button
decoded as `0x00200`, the left upper as `0x00100`, the left power button as
`0x00800`, the right lower as `0x02000` and the right upper as `0x01000`;
Z and the right power button matched no bit of that guess. The 2026-11-23
capture confirmed Z (`0x00080`) and the right power button (`0x08000`) as
inferred, and showed the two remaining bits (see ¹). The app keeps the
button → action mapping configurable.

## Levers (paddles)

From the 2026-11-23 capture (the tester operated "both side buttons + brakes"):

- **Four sub-messages per keypad frame**, locations 0, 1, 2, 3. Locations 2
  and 3 were always 0. Location 0 is the left grip, 1 the right grip (matched
  what was operated).
- **The value is a signed zigzag integer, −100 … +100.** Raw varints at the
  extremes: `c8 01` = 200 → **+100**, `c7 01` = 199 → **−100**. At rest the raw
  values are 0, 1, 2 (0, −1, +1: jitter).
- **The sign is real.** Within one stroke all intermediate raw values share
  their parity: right lever `2 → 194 → 200 → 122 → 0` (all even, positive:
  +1 → +97 → +100 → +61 → 0), then `1 → 79 → 199 → 23 → 199 → 167 → 199 → 0`
  (all odd, negative: −1 → −40 → −100 → −12 → −100 → −84 → −100 → 0). So
  **each grip has one lever that moves in two directions**.

Annotated frames (hex, as in the log):

```
23                                 keypad status
08 ff ff ff ff 0f                  field 1: bitmap 0xffffffff (nothing pressed)
1a 04 08 00 10 00                  field 3: location 0 (left),  value 0
1a 05 08 01 10 c8 01               field 3: location 1 (right), raw 200 → +100
1a 04 08 02 10 00                  field 3: location 2, value 0
1a 04 08 03 10 00                  field 3: location 3, value 0
```

```
23 08 ff ff fe ff 0f               bitmap 0xffffbfff: bit 0x04000 cleared (right lever click / side button)
1a 04 08 00 10 00                  left 0
1a 05 08 01 10 ae 01               right raw 174 → +87
1a 04 08 02 10 00  1a 04 08 03 10 00
```

```
23 08 ff f7 ff ff 0f               bitmap 0xfffffbff: bit 0x00400 cleared (left lever click / side button)
1a 05 08 00 10 c7 01               left raw 199 → −100
1a 04 08 01 10 00  1a 04 08 02 10 00  1a 04 08 03 10 00
```

(The second and third are built from the capture's bitmaps and values —
`0xffffbfff` with the right lever at +0.87 … +1.00 around 11:08:04.339–.550,
`0xfffffbff` with the left lever at −1.00 around 11:08:07.279–.579.)

### Physical meaning of the lever directions (confirmed by the tester)

Each lever has a **brake** direction and a **steer** direction, mirror-
symmetric between the grips, and `0x00400` / `0x04000` are the click at the
end of the steer direction (or a side button that also moves the lever):

| Lever | + (bar moves right) | − (bar moves left) |
| ----- | ------------------- | ------------------ |
| Left  | brake               | steer left         |
| Right | steer right         | brake              |

This is the app's **default** (`Settings.shifting.levers`), not a fact. Each
direction can be set to steer left, steer right, brake or nothing, with a
dead zone (default ±5 %; the rest jitter is ±1–2 %) and a proportional output
above it. The tester could not say which way was the brake, because nothing
in the app showed it; the live lever display (Devices → Controllers) is there to find out.

## Open questions / verification checklist

- [ ] Does the Ride advertise as one device or two (left/right), and which
      one must be connected? Advertised name and manufacturer data.
- [ ] Service UUID actually exposed by the Ride (FC82 vs legacy).
- [ ] Handshake answer bytes; is anything else needed before
      notifications start? Is a keep-alive required?
- [x] Every row of the button table, by pressing each button once.
- [x] Paddle message layout and value range (four locations, −100 … +100).
- [ ] Which lever direction is the brake and which steers, on each grip.
- [ ] What `0x00400` / `0x04000` are physically: a click at the end of the
      lever's travel, or a separate side button?
- [ ] Battery message layout.

## How to capture

Capture is **always on**: Freilauf writes every _change_ of the keypad frame
to its diagnostic log (see [../diagnostics.md](../diagnostics.md) for where
the log is and how to export it). Nothing has to be enabled.

To produce a capture that answers the open questions:

1. Start Freilauf, connect the controllers (**Devices**: click the device line
   on the start screen) and wait until they show as connected. Further down
   the same screen, **Controllers → Controller buttons**:
   it lists all sixteen buttons by grip (left grip: lower and upper shift
   button, D-pad up/right/down/left, lever click / side button, power
   button; right grip: lower and upper shift button, A, B, Y, Z, lever click
   / side button, power button). Each press lights up the row of the button
   the app decoded and shows "Last button: …" above the list — a press that
   lights nothing up was not decoded. Below it, **Brake and steering levers**
   shows each lever as a bar from −100 to +100 that follows it live, and what
   the app makes of it.
2. Press **each button once, in this order**, holding it for about a second
   and leaving about two seconds between buttons (so each press is a separate,
   easy-to-find group of lines):
   1. left grip: lower shift button, then upper shift button;
   2. left grip: D-pad up, right, down, left;
   3. left grip: the lever click / side button;
   4. right grip: lower shift button, then upper shift button;
   5. right grip: A, B, Y, Z;
   6. right grip: the lever click / side button;
   7. each lever, left then right: **pull the brake** slowly all the way and
      release; then **push the lever sideways** (the steering movement) all
      the way and release. Write down which way the bar moved each time
      (left/−, right/+), and whether the lever click / side button row lit up.

   Do not press the on/off buttons (they switch the controller off). If you
   deviate from the order, write down what you did.

3. Export the log (**Settings → Diagnostics → Export log…**, or **Open log
   folder** and copy `freilauf.log`) and attach it to an issue together with
   the order you used and what the "Last button" line showed for each press.

Reading it: each press shows up as two `controller` lines, the press and the
release:

```
… INFO  controller keypad 23 08 ff bf ff ff 0f → pressed shiftUpRight {"hex":"23 08 ff bf ff ff 0f","bitmap":"0xffffdfff","pressed":["shiftUpRight"],"down":["shiftUpRight"]}
… INFO  controller keypad 23 08 ff ff ff ff 0f → pressed none {"hex":"23 08 ff ff ff ff 0f","bitmap":"0xffffffff","pressed":[],"up":["shiftUpRight"]}
```

- `bitmap` is field 1 of the keypad message (low 32 bits); a cleared bit is a
  pressed button.
- `unknownBits` lists cleared bits that are **not** in the table above — a
  button we cannot map yet (`→ pressed unmapped bit(s)`).
- `paddles` shows the lever values of field 3 (`left:-0.40`, `right:1.00`);
  `otherPaddles` appears only if location 2 or 3 is ever non-zero.
- `levers → steering S, braking B` (source `ride`, debug) is what the app made
  of the levers with the current assignment, logged when a lever moves by a
  visible step.
- `previous frame repeated N×` collapses identical frames (the controller
  repeats its state).
- `unknown message type 0x.. (first occurrence)` gives the first frame of a
  message type the parser does not know, in full; later ones are counted
  (`unknown message types seen`).
- The handshake answer appears as `handshake answer (RideOn…) on sync TX`
  with hex and ASCII; the service used as `using Ride service FC82` or the
  legacy fallback.
- `button <name> pressed: no action assigned` (source `ride`) means the
  button was decoded but has no action in Devices → Controllers → Controller
  buttons ("Nothing").

`FREILAUF_BLE_LOG=1` additionally logs **every** raw frame, uncollapsed, as
`raw async …` / `raw syncTx …` debug lines — useful if the collapsing hides
something. Alternatively use nRF Connect on a phone and enable notifications
on the Async characteristic.
