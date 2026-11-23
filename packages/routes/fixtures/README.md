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
