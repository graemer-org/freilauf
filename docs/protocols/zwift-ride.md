# Zwift Ride controllers — BLE protocol notes

> **Status: unverified against hardware.** Everything below was written
> from recollection of public protocol write-ups (blog posts and community
> notes on the Play/Click/Ride controllers). No BLE capture of a real Ride
> has been made for this project yet, and no code was taken from other
> projects. Treat every value as a hypothesis until the checklist at the
> bottom is ticked. The app has a keyboard fallback for shifting so it is
> usable even if parts of this are wrong.

The protocol is proprietary and undocumented by the vendor.

## GATT

| What | UUID | Confidence |
| --- | --- | --- |
| Service (Ride) | `0000fc82-0000-1000-8000-00805f9b34fb` | medium |
| Service (older Play/Click) | `00000001-19ca-4651-86e5-fa29dcdd09d1` | high |
| Async — notify, controller → app | `00000002-19ca-4651-86e5-fa29dcdd09d1` | high |
| Sync RX — write, app → controller | `00000003-19ca-4651-86e5-fa29dcdd09d1` | high |
| Sync TX — indicate, controller → app | `00000004-19ca-4651-86e5-fa29dcdd09d1` | high |

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

| Type | Meaning | Confidence |
| --- | --- | --- |
| `0x23` | Keypad status | medium |
| `0x19` | Battery/status; field 2 (varint) = percent | low |
| `0x15` | Idle / empty | medium |

### Keypad status (`0x23`)

- Field 1, varint: button bitmap. **A cleared bit means pressed**; idle is
  all ones.
- Field 3, repeated message: analog paddle — field 1 = location
  (0 left, 1 right), field 2 = sint32 (zigzag) value, about −100…100.

| Button | Mask | | Button | Mask |
| --- | --- | --- | --- | --- |
| D-pad left | `0x00001` | | Shift up, left | `0x00200` |
| D-pad up | `0x00002` | | Shift down, left | `0x00400` |
| D-pad right | `0x00004` | | Power-up, left | `0x00800` |
| D-pad down | `0x00008` | | On/off, left | `0x01000` |
| A | `0x00010` | | Shift up, right | `0x02000` |
| B | `0x00020` | | Shift down, right | `0x04000` |
| Y | `0x00040` | | Power-up, right | `0x10000` |
| Z | `0x00100` | | On/off, right | `0x20000` |

Confidence in individual bit positions: low to medium. Which physical
lever is "shift up" vs "shift down" must be confirmed; the app therefore
makes the button → action mapping configurable.

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

Run the app with `FREILAUF_BLE_LOG=1`: every raw frame from the controller
is written as hex with a timestamp to the log file shown in
Settings → Diagnostics. Press each button once in a known order and attach
the log to an issue. Alternatively use nRF Connect on a phone and enable
notifications on the Async characteristic.
