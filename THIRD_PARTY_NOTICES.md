# Third-party notices

Freilauf is MIT-licensed ([LICENSE](LICENSE)). The desktop app and the web version bundle the
following third-party runtime libraries; the optional signalling server (`apps/signalling`)
uses `ws`. Development tools (TypeScript, Vite, Electron, Vitest, Playwright, …) are not listed:
they are not part of what is shipped, except Electron itself, which carries its own notices
(`LICENSES.chromium.html` in every Electron build).

Versions and licences as recorded in each package's `package.json` in `node_modules`
(lockfile `pnpm-lock.yaml`). All are MIT; nothing here requires more than keeping the copyright
and licence notice, which each package's `LICENSE` file provides.

| Package               | Version | Licence | Used by                                  | Copyright                                                          |
| --------------------- | ------- | ------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `react`               | 19.3.1  | MIT     | desktop, web                             | Meta Platforms, Inc.                                               |
| `react-dom`           | 19.3.1  | MIT     | desktop, web                             | Meta Platforms, Inc.                                               |
| `scheduler`           | 0.28.0  | MIT     | desktop, web (via `react-dom`)           | Meta Platforms, Inc.                                               |
| `zustand`             | 5.1.0   | MIT     | desktop, web                             | Paul Henschel                                                      |
| `trystero`            | 0.27.0  | MIT     | desktop, web (group rides)               | Dan Motzenbecker                                                   |
| `@trystero-p2p/nostr` | 0.27.0  | MIT     | desktop, web (via `trystero`)            | Dan Motzenbecker                                                   |
| `@trystero-p2p/core`  | 0.27.0  | MIT     | desktop, web (via `trystero`)            | Dan Motzenbecker                                                   |
| `@noble/secp256k1`    | 3.2.0   | MIT     | desktop, web (via `@trystero-p2p/nostr`) | Paul Miller                                                        |
| `ws`                  | 8.23.0  | MIT     | `apps/signalling`, the Docker image      | Einar Otto Stangvik, Arnout Kazemier, Luigi Pinca and contributors |

`trystero` 0.27.0 pulls in exactly `@trystero-p2p/nostr` → `@trystero-p2p/core` and
`@noble/secp256k1` at runtime; none of them has further dependencies. No package listed here
has a licence other than MIT.

## The watch-relay helper (Windows)

The Windows build also ships `freilauf-sensor-relay.exe` (`resources/sensor-relay/`), built from
`apps/desktop/native/sensor-relay` (MIT, part of Freilauf) with Rust; see
[ADR 0005](docs/adr/0005-sensor-relay.md). It statically links these crates (versions from its
`Cargo.lock`, licences from `cargo metadata`):

| Crate                                                                                                                                                            | Version                                | Licence           | Copyright                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------- | ----------------------------- |
| `serde`, `serde_core`                                                                                                                                            | 1.0.229                                | MIT OR Apache-2.0 | Erick Tryzelaar, David Tolnay |
| `serde_json`                                                                                                                                                     | 1.0.154                                | MIT OR Apache-2.0 | Erick Tryzelaar, David Tolnay |
| `itoa`                                                                                                                                                           | 1.0.19                                 | MIT OR Apache-2.0 | David Tolnay                  |
| `zmij`                                                                                                                                                           | 1.0.23                                 | MIT               | David Tolnay                  |
| `memchr`                                                                                                                                                         | 2.8.3                                  | Unlicense OR MIT  | Andrew Gallant, bluss         |
| `windows`, `windows-core`, `windows-collections`, `windows-future`, `windows-link`, `windows-numerics`, `windows-result`, `windows-strings`, `windows-threading` | 0.62.2 / 0.3.x / 0.2.x / 0.4.1 / 0.5.1 | MIT OR Apache-2.0 | Microsoft Corporation         |
| Rust standard library                                                                                                                                            | 1.97.0                                 | MIT OR Apache-2.0 | The Rust Project Developers   |

Freilauf uses each dual-licensed crate under its MIT option. Build-time-only crates
(`serde_derive`, `syn`, `quote`, `proc-macro2`, `unicode-ident`, `windows-implement`,
`windows-interface`) generate code but are not themselves in the binary; `unicode-ident` is
`(MIT OR Apache-2.0) AND Unicode-3.0` (Unicode data terms, permissive). The cross-compiler
links small parts of the mingw-w64 runtime (mingw-w64 runtime licence: ZPL-2.1 / public domain
parts) and libgcc (GPL with the GCC Runtime Library Exception, which allows this). Nothing in
the helper is copyleft for the resulting program. The macOS and Linux builds do not contain it.

Group rides also use network services run by others — public Nostr relay servers and public
STUN servers (Google, Cloudflare); see [docs/group-rides.md](docs/group-rides.md). They are
services, not bundled software.
