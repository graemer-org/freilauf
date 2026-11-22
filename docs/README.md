# Freilauf docs

## Architecture decisions (`adr/`)

| ADR                                  | Topic                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| [0001](adr/0001-architecture.md)     | Package boundaries, device/transport layers, the BLE adapter in Electron |
| [0002](adr/0002-virtual-shifting.md) | Software virtual shifting via FTMS simulation parameters                 |

New decisions get the next number; an accepted ADR is superseded by a new
one rather than rewritten.

## Protocols (`protocols/`)

Notes on device protocols, with sources and a confidence level per fact.
Anything not yet confirmed on real hardware is marked unverified.

- [zwift-ride.md](protocols/zwift-ride.md) — handlebar controllers of the
  Zwift Ride smart frame (proprietary, **partly verified**), including how to
  make a controller capture

## Group rides

- [p2p.md](p2p.md) — peer-to-peer group rides: room codes, the signalling
  server, the WebRTC mesh and its message protocol

## Diagnostics

- [diagnostics.md](diagnostics.md) — the always-on diagnostic log: where it
  is, how to export it, what it contains and what it leaves out
