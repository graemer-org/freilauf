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

Group rides also use network services run by others — public Nostr relay servers and public
STUN servers (Google, Cloudflare); see [docs/group-rides.md](docs/group-rides.md). They are
services, not bundled software.
