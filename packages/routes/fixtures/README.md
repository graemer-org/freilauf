# GPX fixtures

Real GPX files used as a check of the whole pipeline (parse → prepare → codec → sharing).
`test/fixtures.test.ts` picks up **every `.gpx` file in this folder** and asserts that it
parses, builds a route with plausible gradients (never beyond ±25 %), round-trips the codec
and either fits the group-sharing budget or is a very long route.

## Adding a file

1. Copy the `.gpx` into this folder. Only add files you may publish: a recorded ride contains
   where someone lives and rides. Remove personal metadata (author, links, device names) first;
   timestamps and extensions are ignored by the parser and can stay or go.
2. Run `pnpm vitest run packages/routes`.
3. If it fails on gradients, the smoothing needs tuning (`DEFAULT_SMOOTHING` in
   `src/build.ts`, rationale in `docs/adr/0004-routes.md`) — that is what these files are for.

Files that must not be committed go into `local/` (git-ignored); the same test picks them up
when the folder exists and skips it otherwise.

## Files

| File                | What it is                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `isar-ursprung.gpx` | GPX 1.1 planner export, ~98 km out-and-back along a river valley; 2 waypoints, `<type>`, 2410 points 1–470 m apart (median 30 m), ele and time |

## Map data (`osm/`)

Scenery tests (`test/scenery.test.ts`, the desktop e2e `e2e/scenery.spec.ts`) use an Overpass
API answer (JSON, `out geom`) along `isar-ursprung.gpx`. **It is synthetic, not OpenStreetMap
data**: `test/osmFixture.ts` makes it up in the route's own frame (a village "Kleinmoos" with
houses, a church and farms, meadow, farmland, a forest with a clearing, a river with a
riverbank, a bridge, the hamlet "Auhof", and a few things that must be dropped). The names are
invented. Regenerate with `UPDATE_OSM_FIXTURE=1 pnpm vitest run packages/routes/test/scenery.test.ts`.

| File                              | What it is                                                     |
| --------------------------------- | -------------------------------------------------------------- |
| `osm/isar-ursprung.overpass.json` | Synthetic Overpass JSON along the first 6.5 km of the GPX file |

Do not add real OpenStreetMap extracts unless they are small and their attribution
("© OpenStreetMap contributors, ODbL", source and date) is noted here next to the file.
