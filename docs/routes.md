# Riding real routes (GPX)

Load a GPX file — an Alpine pass, your home loop — and the road's gradient drives the trainer by
itself: it gets harder on the climbs and easier on the descents, while you shift as on a real bike.

> **Status:** tested with simulated devices only (`pnpm dev:sim`). How the gradient changes feel
> on a real trainer has not been confirmed yet — please report what you notice.

## What a GPX file is and where to get one

GPX is the common file format for tracks and routes: a list of points with latitude, longitude
and usually elevation. You can get one by

- exporting a ride you recorded with a bike computer or phone app (most offer "Export GPX"),
- planning a route in any route planner and downloading it as GPX,
- downloading one that someone shared.

Freilauf reads GPX 1.0 and 1.1 tracks (and planned routes without a track). Waypoints, times,
heart rate and other extras in the file are ignored. Files up to 20 MB / 500 000 points.

## Importing

On the start screen, click the **Route** card: the route library opens as a picker. Import the
file there (button, or drop it on the window). Freilauf shows the length, climbing and the profile.
If the file has several segments they are joined in order (you get a note). A file without any
elevation is accepted as a **flat route** — you are told so.

Four built-in routes are always there: a rolling 12 km loop, a steady 8 km climb at about 6 %, a
short punchy circuit with tight corners, and a flat 20 km out-and-back. They are made up (generated
by the app), not copies of real roads.

## What happens to noisy elevation

Elevation in GPX files is noisy: phone and GPS altitude jumps by metres from point to point, and
barometers drift. Ridden as is, that would make the trainer lurch between −10 % and +15 % on a flat
road. Freilauf therefore:

- removes stray points (GPS spikes, standing still),
- averages the elevation over about 100 m of road and removes short spikes,
- caps gradients at ±25 % and limits how quickly the gradient can change.

The climbing shown is that of the smoothed road. It is usually **lower than what the file's raw
numbers suggest** — on a noisy recording often much lower — and closer to the truth. Very short
steep bits (shorter than about 100 m) are rounded off. Details: [ADR 0004](adr/0004-routes.md).

## Riding it

Select the route and start the ride. While a route is loaded, the route sets the gradient: the
gradient buttons and keys do nothing. The trainer gets a new gradient when the road changes by a
noticeable amount, at most once per second.

- **Loops** (the end is within 50 m of the start) are ridden as laps; an out-and-back that ends
  where it started counts as a loop too.
- **Point-to-point** routes end at the finish; the ride then carries on along a flat road until
  you stop.
- **With a workout**: in ERG steps the trainer holds the target power and the route just moves
  along; in free-ride steps the route's gradient applies.

### Choosing where to start, and jumping

You do not have to ride 40 km to reach the climb. **Click the elevation profile** where you want
to be: a hairline shows the kilometre, elevation and gradient under the pointer, and a small
confirmation asks before anything happens —

- **before the ride**: "Start at km 42.3 · 812 m · +3.1 %" → **Start here**. The ride will start
  there. The start point is remembered for this route (next time it starts there again) and is
  marked on the profile and the map, and the start screen names it ("Rolling loop · 12.0 km ·
  starts at km 4.2"). **Reset** on the ride view's route card or **Start from the beginning** in
  the route's details in the route picker go back to the start. The larger profile in the
  picker's route details works the same way.
- **during the ride**: "Jump to km 42.3 · 812 m · +3.1 %" → **Jump**. A stray click never moves
  you: nothing happens without the second click (Cancel, Escape or a click elsewhere close it).

The zoomed "ahead" profile and the **mini map** work too. On the map, where the outbound and the
return leg of an out-and-back route lie on top of each other, Freilauf takes the next pass
**ahead of you** along the route; the confirmation shows the kilometre, so you can see which leg
was picked (the profile is never ambiguous). With the keyboard, focus the profile (Tab), move
with **← →** (about 1 % of what the profile shows; **Shift** for 10 ×), **Home/End** for the ends,
**Enter** to ask, **Escape** to clear.

On a loop the place wraps around (laps count each time you cross the start/finish line). On a
point-to-point route a start or jump at the very end lands 100 m before the finish.

What a jump changes and what it does not:

- **Only where you are on the route.** Your distance, time, energy, points and community totals
  keep counting what you actually rode; "To go" and "Climbing left" are counted from the new
  place. The ride view shows "Started at km …" quietly, and "Jumped to km …" for a few seconds
  after a jump. The road view cuts to the new place with a short fade (none with reduced motion).
- **The trainer** gets the new gradient straight away instead of waiting for the next regular
  update, but a big change is eased in: at most 3 percentage points per second (−5 % → +7 % goes
  −2, +1, +4, +7 % over 3 s). Your speed is kept; it then settles on the new gradient as on a real
  road.
- **The recording** carries the new position from the next second on. In the `.fit` file every
  jump **starts a new lap**: each lap has its own start/end position, map box and climbing, so no
  lap pretends you rode across the gap, and the ride's total climbing is the sum of what you rode
  — never the elevation difference across a jump. Distance and speed run on without a break, and
  there is no pause in the timer (you did not stop). Upload sites that draw one line through all
  records may still show a straight line between the laps on the map; the totals are right.
- **Group rides**: riders on the **same route** are placed by where they are on it, not by how
  far they have ridden, so two riders at the same place on the road ride side by side even if
  one started at km 40 or jumped. Riders on different routes (or with an app version from before
  this) are placed by ridden distance as before. A route shared in the group at a coarser
  resolution counts as the same route.

### Difficulty

**Difficulty** (0–100 %, default 100 %) sets how much of each gradient you feel on the trainer:
at 50 % a 10 % climb feels like 5 %. Your speed on screen, the distance and the recorded ride
still follow the real road — the climb takes as long as it would, you just can ride it in an
easier gear. This is how "trainer difficulty" works in most indoor-cycling apps.

## Sharing in a group ride

You can offer a route to the riders in your group; they can add it to their library with one
click. Group rides only allow small documents (each rider shares at most 32 KB in total, next to
a workout and the friends/challenges data), so longer routes are shared at a coarser resolution:

| Route length | Shared with a point every | Size    |
| ------------ | ------------------------- | ------- |
| up to ~40 km | 10 m (full resolution)    | ≤ 12 KB |
| ~100 km      | 20 m                      | ~15 KB  |
| ~150 km      | 30 m                      | ~15 KB  |
| over ~250 km | not shared                | —       |

Distance, climbing and gradients survive this practically unchanged. A route too long to share at
a usable resolution is refused with a message instead of being sent as a blurred copy; send the
GPX file instead.

## Surroundings from OpenStreetMap

A route can show what is really beside the road: houses and churches as simple shaded boxes,
woods, meadows and fields as ground colours with trees along the forest edge, rivers and lakes
as water, a town sign with the place's name where the road enters a village, and railings on
bridges. The data comes from [OpenStreetMap](https://www.openstreetmap.org/copyright)
(© OpenStreetMap contributors, licensed under the ODbL); whenever it is drawn the scene shows
that attribution in its bottom edge.

- **Off unless you ask.** When importing, tick **Load surroundings from OpenStreetMap** (it is
  off by default, every time). For a route already in the library: open its **Details** →
  **Load surroundings**. Built-in routes have none (they lie in the open ocean).
- **What the map server sees:** roughly where the route runs — the boxes along the road that
  are asked for — and the app's name ("Freilauf (open-source indoor cycling app)"; in the
  browser version the browser's own name and the page's address instead). Nothing about you,
  your rides or your devices is sent.
- **Once, then offline.** It is fetched once, in parts of a few kilometres, one request at a
  time with a pause in between; when the server is busy the app waits and tries again (the
  route's row says so; **Cancel** stops it). A 100 km route takes one to a few minutes. The
  result is kept next to the route on this computer (desktop: the `scenery` folder in the
  app's data folder; browser: the browser's storage) — about 20 KB per village, at most 2 MB
  per route. A ride only ever reads what is stored: nothing is fetched while riding.
- **What is kept:** for each house its place along the route, left or right and how far from
  the road, its size and height (from `building:levels` or `height`, otherwise a default for
  its kind); land cover and water as stretches beside the road; town names. Only a corridor of
  about 150 m either side of the road. Very dense routes keep the buildings nearest the road.
- **Details** shows what was stored ("132 buildings · woods 2.5 km · water 6.4 km · Kleinmoos
  · 60 KB") with **Remove surroundings** and **Load again**. Deleting the route removes them too.
- **Settings → Routes:** **Show surroundings** turns the drawing off (the stored data stays);
  **Map server for surroundings** sets another Overpass API server (https, or
  `http://localhost` for one on this computer). Please respect the public server's
  [usage policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).

The road view draws the houses at their real distance and side, in the scene's own flat style
(light and dark), with less detail further away; the side view shows the houses and woods on
the far side as background silhouettes. Out-and-back routes see each house twice, on the left
one way and on the right the other. Why it works this way: [ADR 0011](adr/0011-osm-scenery.md).

> **Status:** tested against recorded and made-up map data only; loading from the real public
> server has not been tried from the development environment yet.

## The weather of that day

A route can be ridden with the **wind of a real day**: the day you recorded it, or any day you
pick. Into the wind you are slower, with it faster, exactly as much as the bike physics says;
the scene shows where the wind comes from and how warm and wet it was. The data comes from the
[Open-Meteo](https://open-meteo.com/) historical weather archive (**Weather data by
Open-Meteo.com**, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); route
details show that attribution next to the stored weather.

- **Off unless you ask.** When importing, tick **Load the weather of that day** (off by
  default, every time). A GPX file with times (a recorded ride) uses its own day and times
  automatically — the import result says which: "Weather of the recorded ride: 14 June 2025,
  09:12–13:40". For a file without times (a planned route), pick a **day** (and a **start**,
  10:00 unless you change it) next to the option; the ride is then assumed to pass each place
  at a steady 25 km/h from that start. Later: the route's **Details** → **Weather of that day**
  → load the recorded ride's day, or a day of your choice. Built-in routes have none.
- **What the weather server sees:** roughly where the route runs — places every 10 km along it,
  rounded to a grid of 0.1° (about 10 km), each cell asked once — and which days (the ride's
  day ± one day). The desktop app sends the request from its own process with the generic name
  "Freilauf (open-source indoor cycling app)"; the browser version sends it from the page, with
  the browser's name and the page's address. Nothing about you, your rides or your devices is
  sent.
- **Once, then offline.** One request for most routes (ten grid cells per request; long routes
  a few, one at a time with a pause). Busy server: the app waits and tries again (the route's
  row says so; **Cancel** stops it). The archive lags a few days behind and starts in 1940;
  a day it has no data for is refused with that reason. A ride only ever reads what is stored:
  nothing is fetched while riding.
- **What is kept:** next to the route in route storage (a few hundred bytes to a few KB): for
  each place along the route (distance from the start) the wind at 10 m (speed, the direction it
  comes from, gusts), the temperature, precipitation and a weather code, at the time the ride
  passed there; plus the day and start of that ride. A GPX with times also keeps when the
  recording passed each kilometre (up to 200 numbers), so the recorded day can be loaded later.
  Deleting the route removes both.
- **Details** shows "14 June 2025, 09:12–13:40 · wind 14 km/h from the south-west, up to 22 km/h ·
  12–17 °C · Partly cloudy", whether it is the recorded ride's times or a chosen day, the
  attribution, **Remove weather** and **Load again with another date**.
- **Settings → Routes → Weather server for the weather of a day** sets another archive server
  with the same request format (https, or `http://localhost` for one on this computer).

### Riding with it

- **Start screen:** with a route that has stored weather, **Ride with that day's wind (14 June 2025)** appears, on by default and remembered per route. Off, the route is ridden as without
  weather.
- **What you feel:** the wind at 10 m is reduced to a rider's height — × 0.65 on open road,
  × 0.4 where the stored surroundings ([above](#surroundings-from-openstreetmap)) show woods,
  built-up land or houses within 40 m of the road (× 0.525 with them on one side only) — and
  only its component **along the road** counts: a headwind adds to the air resistance, a
  tailwind takes from it (a strong one pushes); a crosswind does nothing. It follows the road
  through every bend and turns into a tailwind on the way back of an out-and-back; changes
  ease in over a few seconds. At most ± 36 km/h along the road count.
- **How much:** at 200 W on the flat (83 kg, the default bike) you do 34.3 km/h without wind. A
  20 km/h wind (at 10 m, open road: 13 km/h at the rider) straight against you makes it
  26.6 km/h — **about 5 minutes more per 10 km** (1351 s instead of 1051 s, 7.6 km less per
  hour); straight behind you 42.9 km/h (3.5 minutes less per 10 km). There and back is still
  slower than calm (2190 s instead of 2101 s per 2 × 10 km): a headwind costs more than a
  tailwind gives back.
- **The trainer** feels the wind like the gradient: sent as the wind of its simulation
  parameters, scaled by **Climb difficulty**, rate-limited; in ERG the power target holds.
- **The scene** shows a chip at the top: an arrow for the way the wind blows relative to your
  direction of travel, "Headwind 14 km/h" (or tail- or crosswind, or calm) and "17 °C · Rain";
  thin rain streaks when it rained in that hour. The overlay shows a "Wind" pill while riding.
- **In a group ride** the wind is not used (the others may ride without it); the chip says so.

### Fair comparisons

- A ride with wind is **flagged** in the ride file (`route.weather`: which day's wind) and in the
  summary: "With wind of 14 June 2025".
- **Best times and ghosts compare like with like:** a ride with a day's wind is never the "best
  time" of rides without wind, nor the other way round; rides with another day's wind are
  separate again. "My best time" on the start screen and "New best time on this route" in the
  summary only look at rides in the same conditions ("… with the wind of 14 June 2025"). You can
  still race any ride as a ghost; one ridden in other conditions says so in its name ("· with
  wind of 14 June 2025", "· without wind").
- **Points and personal bests** are effort-based (normalised power against your FTP, best
  power over 5 s … 20 min): the wind does not change them. **Totals and leaderboards** rank
  points, distance, time, climbing, energy and ride counts — never speed; wind changes the
  distance of a ride much like hills do, so it is not excluded there.
- **Recording and `.fit`:** power, heart rate and cadence are what you produced; speed and
  distance follow the physics (slower into the wind). The weather itself is not written to the
  `.fit` file.

Why it works this way: [ADR 0012](adr/0012-historical-wind.md).

> **Status:** tested against made-up answers in the archive's documented format only (unit
> tests, a fake server for the desktop app, intercepted requests in the browser); loading from
> the real public archive has not been tried from the development environment yet.

## Recording and uploading with a map

A ride along a route records your position and elevation on the route. The `.fit` export carries
GPS positions and altitude, so upload sites show the map, the elevation profile and the climbing.
It is marked as a **virtual ride**. The built-in routes are placed in the open Pacific Ocean so they
never pretend to be somewhere real. The ride file on this computer also names the route it
followed, so the ride can be raced as a ghost later ([ghost.md](ghost.md)).

## Where routes are kept

Imported routes are stored in the app's local storage on this computer (desktop app) or in the
browser (browser build), like imported workouts — about 15 KB per 30 km. There is room for about
140 typical or 40 very long routes; delete routes you no longer need if the library is full.
