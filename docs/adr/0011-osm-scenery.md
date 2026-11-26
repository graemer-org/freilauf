# ADR 0011 — Scenery from OpenStreetMap: fetched once on request, route-relative, offline

Status: accepted · 2026-11-26

## Context

Imported routes ride through a generic landscape (random trees, hills on the horizon). Riders
asked for the real surroundings: the village they ride through, the forest, the river beside
the road (rider guide: [routes.md](../routes.md#surroundings-from-openstreetmap)). Constraints:

- Freilauf is local-first. Until now the app made **no HTTP request at all** (group rides use
  WebSockets/WebRTC; the renderer's CSP allows only `ws:`/`wss:`). Any new request must be the
  rider's explicit choice and must not reveal more than needed.
- Rides must stay smooth (60 fps road view next to Bluetooth and the recording) and must work
  offline; the recording, `.fit` file and trainer control must not depend on scenery.
- The desktop app and the browser build (Docker) share the renderer; the Docker server must not
  need anything new.

## Decision

### 1. Source: OpenStreetMap through the Overpass API, only when asked

OpenStreetMap is the only open dataset with buildings, land use, water and place names
worldwide. The [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) answers
bounding-box queries for exactly those tags with geometry (`out geom`) in JSON; the public main
instance (`https://overpass-api.de/api/interpreter`) is the default, any other (e.g. an own
instance) can be set in Settings (https, or http on localhost).

Loading is **opt-in per route**: an import option ("Load surroundings from OpenStreetMap",
**off by default**, not remembered) and "Load surroundings" in a stored route's details.
Built-in routes (in the open ocean) never load anything.

### 2. Privacy: the corridor and a generic name, nothing else

The query contains only bounding boxes along the route (corridor ± 150 m plus 50 m margin;
place names ± 1.5 km). The server therefore learns roughly where the route runs — said in one
line next to every load control. The desktop app sends the request **from the main process**
(Electron `net.fetch`, i.e. the system proxy and certificates) with the User-Agent
`Freilauf (open-source indoor cycling app)` and no other identifying header; the renderer's CSP
stays closed and the main process only POSTs to the configured endpoint. The browser build
uses `fetch` (Overpass sends CORS headers; a form POST needs no preflight); a page cannot set
the User-Agent, so the server sees the browser's and the page's origin. Its CSP gains
`connect-src https:` because the endpoint is configurable.

### 3. Fair use: one request at a time, chunks, backoff, cancel

The route is cut into chunks of ≤ 4 km of road and ≤ 4 km² of box; stretches an earlier part
of the route already covers (the way back of an out-and-back, the end of a loop) are not asked
for again. Requests are **sequential** with a 1 s pause, a server-side `[timeout:90]` and a
client timeout of 150 s. 429/502/503/504, network errors and Overpass "runtime error" remarks
are retried up to 4 times with exponential backoff (5, 10, 20, 40 s, at most 120 s;
`Retry-After` wins); 400 and other errors stop at once with the reason. Only one route loads at
a time (a queue). Everything is cancellable and shows progress ("part 3 of 7", "busy; trying
again in 12 s").

### 4. A route-relative model, built once

The answer is not kept. It is turned into what the scenes need, in the route's own frame
(packages/routes `sceneryBuild.ts`):

- **Buildings**: footprint centre projected onto the route; one placement **per pass** (an
  out-and-back sees a house twice, on opposite sides); length/depth measured in the road's
  frame there; height from `height` or `building:levels` × 3 m, otherwise by building type;
  kind (house, apartments, farm, shed, industrial, church). Houses mapped onto the road edge
  are moved back to the verge; footprints over 250 m are skipped.
- **Land cover and water**: probe lines across the route every 20 m; even-odd crossings with
  polygons (holes of multipolygons work) or river centre lines (as bands of their width) give
  the nearest cover per side; runs of equal probes become stretches (≤ 2 km each).
- **Town signs**: where the road enters the built-up area around a `place` node.
- **Bridges/tunnels**: highway ways tagged so that run along the route.

Everything beyond the corridor is dropped. Bounds: ≤ 30 000 buildings, ≤ 20 000 stretches,
≤ 400 places and **≤ 2 MB** encoded (compact JSON tuples in decimetres; the buildings farthest
from the road go first; the model says when it was cut). A 2000-house town is ~70 KB.

### 5. Stored next to the route, never fetched at ride time

The model is stored per route id: desktop `userData/scenery/<routeId>.json` (atomic writes,
validated on save and load); browser IndexedDB (`scenery` store, database version 2). Route
storage itself (localStorage, ~5 MB per origin shared with workouts) was not an option for up
to 2 MB per route. The ride only reads the stored model; selecting a route decodes it once
(a few are cached). It is only used when built for a route of the same length.

### 6. Drawing within a frame budget

The road view places features with the same projection as the road (`RoadStrip.pointAt`
with distance along and lateral offset), so houses bend and climb with the road and hide behind
crests. Per frame: buildings in the 520 m ahead, culled when off screen or under 1.5 px,
painted far to near, **≤ 700 per frame** (nearest kept), detail by depth (windows < 80 m,
faces and roof < 240 m, one silhouette beyond), land cover batched per colour and fog level.
Measured: a 2000-building town costs ~2.6 ms of script per frame on the stub canvas
(vs. 0.8 ms without scenery) and ~1.1–1.4 ms per frame (smoothed) in Electron in the e2e test.
The side view draws the far side's houses and woods as background silhouettes with parallax.
Colours are mixes of the theme tokens (light and dark).

### 7. Licence and attribution

OSM data is © OpenStreetMap contributors under the ODbL. The scene shows
"© OpenStreetMap contributors" whenever scenery is drawn; route details and the docs say it
too. The stored model is a derived database kept on the rider's device and not distributed by
the project. The repository contains **no OSM data**: the test fixture
`packages/routes/fixtures/osm/` is synthetic (generated by `test/osmFixture.ts`).

## Consequences

- The app now makes HTTP requests, but only on explicit request, only to the configured map
  server, and never during a ride. Without them everything works as before.
- The recording, `.fit` export, trainer gradient and group rides are independent of scenery
  (a test rides the same route with and without it and compares).
- The live public endpoint could not be reached from the development environment: the client
  was built against the documented JSON format and tested with synthetic answers and a fake
  local server. Real-world data (huge forest relations, odd tags) may need tuning.
- Scenery is not shared in group rides (too large for the shared documents).

## Alternatives considered

- **Fetching while riding (tiles around the rider)**: needs a connection during every ride,
  leaks the rider's live position, and hits the public server repeatedly — rejected.
- **Vector tiles / a tile server**: would need an API key or our own server, and tiles carry far
  more than needed — rejected.
- **Overpass `around` with the route polyline**: an exact corridor, but long queries are slow
  on the server and the box approach is the server's cheapest query — kept as a possible
  refinement.
