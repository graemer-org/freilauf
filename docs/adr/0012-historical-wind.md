# ADR 0012 — Historical wind: loaded once on request, route-relative, like with like

Status: accepted · 2026-11-28

## Context

Riders who import a GPX of a ride they did asked to ride it "with the weather of that day" —
above all the wind, which decides how hard a road was (rider guide:
[routes.md](../routes.md#the-weather-of-that-day)). They wanted no weather picker: import the
historical data, done. Constraints, as for the surroundings ([ADR 0011](0011-osm-scenery.md)):

- Local-first: a request only on the rider's explicit choice, revealing as little as possible,
  never during a ride; everything must work offline afterwards.
- The desktop app and the browser build share the renderer; the Docker server must not change.
- Riding with wind changes speed and distance. Best times and ghosts must stay fair, and the
  recording must stay honest (power is what the rider produced).

## Decision

### 1. Source: the Open-Meteo historical archive, only when asked

The [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
(`https://archive-api.open-meteo.com/v1/archive`) is free, needs no key, covers the world
hourly from 1940 (reanalysis; a few days' delay) and sends CORS headers. Hourly
`wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m`, `temperature_2m`, `precipitation`,
`weather_code`, with `wind_speed_unit=ms`, `timezone=auto` (the location's offset comes back as
`utc_offset_seconds`) and `timeformat=unixtime`. Several places go into one request as
comma-separated lists; the answer is then a JSON list in the same order. The endpoint can be
changed in Settings → Routes (https, or http on this computer), like the map server.

Loading is **opt-in per route**: an import option ("Load the weather of that day", **off by
default**, not remembered) and "Weather of that day" in a stored route's details (load, remove,
load again with another date). Built-in routes never load anything.

### 2. When: the recorded ride's times, else a chosen day at 25 km/h

The GPX reader now keeps `<time>` (ISO 8601; no zone = UTC; offsets with or without a colon).
When at least half of the points have one, `prepareRoute` derives the passage time along the
route (times forced to run forward, mapped by distance) and the library keeps a compact copy
(`RouteTimes`: one entry per ≥ 500 m, ≤ 200, ~1 k characters) under its own key, so the
recorded day can also be loaded later from the details. Without times the rider picks a day and
a start (default 10:00, local time at the route) and the ride is assumed to pass each place at a
constant 25 km/h. The weather of every place is taken at the time the ride passed it,
interpolated between the hours (wind as a vector, so 350° and 10° average to north).

### 3. Privacy: grid cells and days, nothing else

Places are sampled along the route every 10 km (start and finish included; at most 40, so long
routes get a wider spacing), **snapped to a 0.1° grid** (~11 km) and deduplicated — an
out-and-back or loop asks for each cell once. The server learns those cells and the days asked
for (the ride's days ± 1, to cover any time zone; clamped to today), said in one line next to
every load control. The desktop app sends the GET **from the main process** (`net.fetch`) with
the User-Agent `Freilauf (open-source indoor cycling app)` and nothing else; the main process
only accepts a query of the archive's own parameters for the configured endpoint. The browser
build uses `fetch` without custom headers (no preflight); its CSP already allows `https:`.

### 4. Fair use: sequential, timeout, retries, cancel

The same plumbing as the surroundings (`sceneryFetch.ts`: cancel signal, cancellable sleep,
retryable statuses): ten locations per request, requests one after another with a 1 s pause,
a client timeout of 60 s, 429/408/502/503/504 and network errors retried up to 4 times with
exponential backoff (5, 10, 20, 40 s, at most 120 s; `Retry-After` wins), 400 (the archive's
`{"error":true,"reason":…}`) stops at once with the reason. One route loads at a time (a
queue); everything is cancellable with progress. Most routes need one request.

### 5. A route-relative wind profile, stored next to the route

The answer is not kept. It becomes a **wind profile**: per sampled place its distance along
the route and the 10 m wind (speed, the direction it comes from), gusts, temperature,
precipitation and the WMO weather code at the passage time, plus the ride's start and end and
the local offset. Encoded as compact JSON tuples (0.1 m/s, 1°, 0.1 °C, 0.1 mm): a few hundred
bytes to a few KB, at most 16 KB, validated on load. Because it is that small it lives **in
route storage next to the route** (`freilauf.routeWeather.v1.<routeId>`, localStorage in both
builds) — no new file store or IndexedDB version. Deleting the route deletes it. The ride only
reads the stored profile, and only when it was built for a route of the same length. Missing
values (`null`) are bridged from the neighbouring hour or place; when the archive has no wind
for the day at all, the load fails with that reason.

### 6. Physics: rider height, along the road, smoothed, capped

At ride time (`riderWind`):

- **Height.** The 10 m wind is reduced to rider height (~1.2 m) with the logarithmic wind
  profile ln(1.2/z0)/ln(10/z0): open terrain (z0 ≈ 0.03 m) 0.63 → **× 0.65**; where the stored
  OSM surroundings show woods or built-up land within 40 m of the road, or a house that close
  within 50 m along it (z0 ≈ 0.5 m → 0.3), **× 0.4** for both sides sheltered, × 0.525 for one.
  It is cheap: one lookup in the stretches and buildings already in memory. Without
  surroundings the open-road factor applies everywhere.
- **Direction.** The wind is projected onto the route heading at the rider's place:
  head (+) / tail (−) = speed · cos(from − heading); the cross component is shown but ignored by
  the physics (yaw effects on drag are small and model-dependent). Bends and the way back of an
  out-and-back change the sign as they should. Between places the profile is interpolated.
- **Air resistance.** `stepBike`/`resistingForce` take the head wind as an optional last
  argument: aero = ½ρC<sub>d</sub>A · (v + w)·|v + w| while moving (a tailwind faster than the
  bike pushes; at a standstill nothing moves the bike). Drive power stays P / v (ground speed).
- **Smoothing and caps.** The controller eases the wind with a time constant of 4 s; the head/
  tail component counts at most **± 10 m/s** (36 km/h), in the weather model and again in the
  physics. Past the finish of a point-to-point route the wind is 0.
- **Trainer.** Like the gradient: the felt wind (× Climb difficulty) is sent as the FTMS wind
  speed, rate-limited (a change ≥ 0.5 m/s at most once per second, smaller ones after 5 s).
  With virtual gearing ratio r the trainer gets w / r, because
  r · ½ρC<sub>d</sub>A · (r·v<sub>t</sub> + w)² = r³ · ½ρC<sub>d</sub>A · (v<sub>t</sub> + w/r)².
  In ERG the power target holds, as with the gradient.
- **Effect.** At 200 W on the flat (83 kg, C<sub>d</sub>A 0.32 m²): calm 34.3 km/h; a 20 km/h
  wind at 10 m (3.6 m/s at the rider) straight against: 26.6 km/h (+300 s per 10 km, −7.6 km
  per hour); straight behind: 42.9 km/h (−212 s per 10 km). An out-and-back is slower than calm
  (+89 s per 20 km).
- **Group rides** do not use the wind (riders could differ); the chip says so.
- Temperature changes nothing (air density stays the default); it is shown only.

### 7. Fairness: flagged, and like with like

A ride ridden with wind records it in its route info: `route.weather = { key, label }`, the key
being the local start of the weather's ride ("2025-06-14T09:12", which changes with "Load
again with another date") and the label its day ("14 June 2025"). The ride list carries it on;
a malformed one counts as no wind; rides from before have none.

- **Best time** (`bestGhost`, the ghost's default "My best time", the summary's "New best time
  on this route") only compares rides of the **same conditions**: without wind with without
  wind, with a day's wind with the same day's wind. A windy ride never becomes the best time of
  calm rides and vice versa.
- **Ghosts**: "My last ride" and any earlier ride may still be raced whatever its conditions;
  one with other conditions is labelled ("· with wind of 14 June 2025", "· without wind").
- **Summary**: "With wind of 14 June 2025".
- **Points, personal bests, community totals and leaderboards** were checked: points are
  NP/FTP-based, bests are power, leaderboards rank points, distance, moving time, climbing,
  energy, rides and ride days — never speed (deliberately). Effort-based values are unaffected.
  Distance is affected like it is by hills (a route's profile already changes distance per
  effort); windy rides are therefore not excluded from distance totals. Documented, no change.
- **Recording/`.fit`**: power, heart rate, cadence unchanged in meaning; speed and distance
  follow the physics. The weather is not written into the `.fit` (its record temperature field
  would need a new record definition; skipped).

### 8. Licence and attribution

Open-Meteo data is licensed CC BY 4.0 and asks for "Weather data by Open-Meteo.com". The route
details show "Weather data by Open-Meteo.com (CC BY 4.0)" next to the stored weather, Settings
next to the server field, and the docs say it too. The stored profile is a derived, much reduced
dataset kept on the rider's device and not distributed by the project. The repository contains
**no weather data**: all test answers are synthetic.

## Consequences

- One more request type, only on explicit request, only to the configured weather server,
  never during a ride. Without it everything works as before (no wind field, no trainer wind,
  identical recordings — tests compare).
- Riders get a "With wind of …" flag and separate best times per wind; the start screen has a
  per-route switch "Ride with that day's wind" (on by default, remembered).
- The live public endpoint could not be reached from the development environment: the client
  was built against the documented JSON format and tested with synthetic answers, a fake local
  server (desktop e2e) and intercepted requests (browser e2e). Real data (missing hours,
  reanalysis grid effects in valleys) may need tuning.
- Not shared in group rides, and not used there.

## Alternatives considered

- **A weather picker (hour by hour, presets, "today's forecast")**: asked against; more UI,
  more requests, little gain over "that day".
- **Live weather while riding**: needs a connection and leaks the live position — rejected
  (as for the surroundings).
- **Asking at the exact route points**: a finer position than any reanalysis grid resolves,
  and more revealing — rejected for 0.1° cells.
- **Modelling crosswind drag (yaw angle)**: depends on wheels and position; the head/tail
  component carries nearly all of the effect for a rider — kept as a possible refinement.
- **A file store like the scenery's**: unnecessary for a few KB; route storage keeps it next to
  the route in both builds without new IPC or a database version.
