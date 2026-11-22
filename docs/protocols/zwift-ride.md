# Zwift Ride controllers — BLE protocol notes

> **Status: buttons largely verified on hardware (2026-11-22, Windows 11).**
> Written from recollection of public protocol write-ups, then corrected
> against a real Ride by pressing every button and reading what the app
> decoded. No code was taken from other projects.
>
> - **Confirmed:** pairing through the chooser, the handshake, keypad
>   notifications, the d-pad, A, B, Y, both shift buttons on each grip and
>   the left power button.
> - **Inferred, not yet seen in a capture:** Z (`0x00080`) and the right
>   power button (`0x08000`). Both were _not recognised_ with the first
>   table; the values here follow from the pattern of the confirmed bits.
> - **Not working:** the analog brake/steering paddles produce nothing. The
>   paddle message layout below is still a guess; an exported log with the
>   paddles pulled is needed to decode it.

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

### Keypad status (`0x23`)

- Field 1, varint: button bitmap. **A cleared bit means pressed**; idle is
  all ones.
- Field 3, repeated message: analog paddle — field 1 = location
  (0 left, 1 right), field 2 = sint32 (zigzag) value, about −100…100.

| Button                         | Mask      | Status    |
| ------------------------------ | --------- | --------- |
| D-pad left                     | `0x00001` | confirmed |
| D-pad up                       | `0x00002` | confirmed |
| D-pad right                    | `0x00004` | confirmed |
| D-pad down                     | `0x00008` | confirmed |
| A                              | `0x00010` | confirmed |
| B                              | `0x00020` | confirmed |
| Y                              | `0x00040` | confirmed |
| Z                              | `0x00080` | inferred  |
| Left grip, upper shift button  | `0x00100` | confirmed |
| Left grip, lower shift button  | `0x00200` | confirmed |
| (unobserved)                   | `0x00400` | unknown   |
| Left grip, power button        | `0x00800` | confirmed |
| Right grip, upper shift button | `0x01000` | confirmed |
| Right grip, lower shift button | `0x02000` | confirmed |
| (unobserved)                   | `0x04000` | unknown   |
| Right grip, power button       | `0x08000` | inferred  |

How the table was corrected: with the first guess, the left lower button
decoded as `0x00200`, the left upper as `0x00100`, the left power button as
`0x00800`, the right lower as `0x02000` and the right upper as `0x01000`;
Z and the right power button matched no bit of that guess. The app keeps the
button → action mapping configurable.

## Open questions / verification checklist

- [ ] Does the Ride advertise as one device or two (left/right), and which
      one must be connected? Advertised name and manufacturer data.
- [ ] Service UUID actually exposed by the Ride (FC82 vs legacy).
- [ ] Handshake answer bytes; is anything else needed before
      notifications start? Is a keep-alive required?
- [ ] Every row of the button table, by pressing each button once.
- [ ] Paddle message layout and value range.
- [ ] Battery message layout.

## How to capture

Capture is **always on**: Freilauf writes every _change_ of the keypad frame
to its diagnostic log (see [../diagnostics.md](../diagnostics.md) for where
the log is and how to export it). Nothing has to be enabled.

To produce a capture that answers the open questions:

1. Start Freilauf, connect the controllers (Devices tab) and wait until they
   show as connected. Then open **Settings → Shifting → Controller buttons**:
   it lists all sixteen buttons by grip (left grip: lower and upper shift
   button, D-pad up/right/down/left, power-up button, on/off button; right
   grip: lower and upper shift button, A, B, Y, Z, power-up button, on/off
   button). Each press lights up the row of the button the app decoded and
   shows "Last button: …" above the list — a press that lights nothing up was
   not decoded. The names follow the bit table above, so "upper"/"lower" is
   itself still a guess until a capture confirms it.
2. Press **each button once, in this order**, holding it for about a second
   and leaving about two seconds between buttons (so each press is a separate,
   easy-to-find group of lines):
   1. left grip: lower shift button, then upper shift button;
   2. left grip: D-pad up, right, down, left;
   3. left grip: the power-up button;
   4. right grip: lower shift button, then upper shift button;
   5. right grip: A, B, Y, Z;
   6. right grip: the power-up button;
   7. each brake paddle (if present): squeeze slowly all the way and release,
      left then right.

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
- `paddles` shows the analog values of field 3, if any.
- `previous frame repeated N×` collapses identical frames (the controller
  repeats its state).
- `unknown message type 0x.. (first occurrence)` gives the first frame of a
  message type the parser does not know, in full; later ones are counted
  (`unknown message types seen`).
- The handshake answer appears as `handshake answer (RideOn…) on sync TX`
  with hex and ASCII; the service used as `using Ride service FC82` or the
  legacy fallback.
- `button <name> pressed: no action assigned` (source `ride`) means the
  button was decoded but has no action in Settings → Shifting → Controller
  buttons ("Nothing").

`FREILAUF_BLE_LOG=1` additionally logs **every** raw frame, uncollapsed, as
`raw async …` / `raw syncTx …` debug lines — useful if the collapsing hides
something. Alternatively use nRF Connect on a phone and enable notifications
on the Async characteristic.
