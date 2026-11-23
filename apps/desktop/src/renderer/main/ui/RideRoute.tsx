import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RouteTrack } from '@freilauf/routes';
import { normalizeRouteStart } from '@freilauf/routes';
import type { LiveState } from '../../../shared/contract';
import { useApp, useAppState } from './hooks';
import {
  AHEAD_BEHIND_SHARE,
  AheadProfile,
  OUTLINE_BOX,
  RouteOutline,
  RouteProfile,
  outlinePad,
} from './RouteGraphics';
import { MapPicker, ProfilePicker } from './RoutePick';
import { routeDifficultyOf, routeJumps, useRouteTrack } from './routesApi';
import {
  chooseMapCandidate,
  fitOutline,
  formatClimb,
  formatKm,
  formatRouteKm,
  mapCandidates,
  routeProgress,
  trackOutline,
  trackPointInfo,
  trackPosition,
  trackProfile,
} from './routeView';

/** How long "Jumped to km …" stays after a jump. */
export const JUMP_NOTE_MS = 5_000;
/** Metres of road the "ahead" profile shows in front of the rider. */
const AHEAD_M = 600;
/** Map hits within this many box units of the route count (the map is ~100 box units wide). */
const MAP_HIT_RADIUS = 7;

type Riders = NonNullable<LiveState['group']>['riders'];
const NO_RIDERS: Riders = [];

/** Map, profile and what is left, for the route that drives this ride. */
export function RideRoute() {
  const track = useRouteTrack();
  if (!track) return null;
  return <RouteCard track={track} />;
}

/** "Started at km 42.3" (quiet), or "Jumped to km 42.3" for a few seconds after a jump. */
function useStartNote(): { text: string; jumped: boolean } | null {
  const idle = useAppState((s) => (s.live?.ride.state ?? 'idle') === 'idle');
  const startM = useAppState((s) => s.live?.routeControl?.startM ?? 0);
  const jumps = useAppState((s) => s.live?.routeControl?.jumps ?? 0);
  const lastJumpM = useAppState((s) => s.live?.routeControl?.lastJumpM ?? null);
  const [shownJump, setShownJump] = useState<number | null>(null);
  const seen = useRef(jumps);
  useEffect(() => {
    if (jumps === seen.current) return;
    seen.current = jumps;
    if (jumps === 0 || lastJumpM === null) {
      setShownJump(null);
      return;
    }
    setShownJump(lastJumpM);
    const t = setTimeout(() => setShownJump(null), JUMP_NOTE_MS);
    return () => clearTimeout(t);
  }, [jumps, lastJumpM]);
  if (shownJump !== null) return { text: `Jumped to ${formatRouteKm(shownJump)}`, jumped: true };
  if (startM > 0) {
    return { text: `${idle ? 'Starts' : 'Started'} at ${formatRouteKm(startM)}`, jumped: false };
  }
  return null;
}

function RouteCard({ track }: { track: RouteTrack }) {
  const app = useApp();
  const jumps = useMemo(() => routeJumps(app), [app]);
  const idle = useAppState((s) => (s.live?.ride.state ?? 'idle') === 'idle');
  const startM = useAppState((s) => s.live?.routeControl?.startM ?? 0);
  const note = useStartNote();
  const pos = useAppState((s) => s.live?.route ?? null);
  const riders = useAppState((s) => s.live?.group?.riders ?? NO_RIDERS);
  const total = Math.max(0, (track.count - 1) * track.stepM);
  const mine = pos && pos.routeId === track.id ? pos : null;
  const d = mine ? mine.distanceM : 0;
  const lap = mine?.lap ?? 1;
  const finished = mine?.finished === true;
  const remaining = mine ? mine.remainingM : total;
  const climbLeft = mine ? mine.ascentRemainingM : track.ascentM;
  const difficulty = useAppState(routeDifficultyOf);

  const profile = useMemo(() => trackProfile(track, 240), [track]);
  const outline = useMemo(() => trackOutline(track, 400), [track]);
  const progress = finished ? 1 : routeProgress(total, d, track.loop);
  const position = trackPosition(track, d);

  // Other riders at their gaps along the route (behind ones too: the scene cannot show them).
  const others = useMemo(() => {
    const out: { id: string; name: string; stale: boolean; at: number; x: number; y: number }[] =
      [];
    for (const r of riders) {
      if (!Number.isFinite(r.gapM)) continue;
      let at = d + r.gapM;
      if (track.loop && total > 0) at = ((at % total) + total) % total;
      else if (at < 0 || at > total) continue;
      const p = trackPosition(track, at);
      out.push({
        id: r.peerId,
        name: r.name,
        stale: r.stale,
        at: total > 0 ? at / total : 0,
        x: p.x,
        y: p.y,
      });
    }
    return out;
  }, [riders, d, track, total]);

  const km = formatKm(total);
  const pct = Math.round(progress * 100);

  // ── choosing a point: the start before the ride, a jump during it ──
  const mode = idle ? 'start' : 'jump';
  const onPick = useCallback((m: number) => jumps?.jumpTo(m), [jumps]);
  // What the confirmation shows is where the rider will really be (kept off the finish).
  const info = useCallback(
    (m: number) => trackPointInfo(track, normalizeRouteStart(track, m)),
    [track],
  );
  const fit = useMemo(
    () => fitOutline(outline, { width: OUTLINE_BOX, height: OUTLINE_BOX, pad: outlinePad('md') }),
    [outline],
  );
  const aheadFrom = d - AHEAD_M * AHEAD_BEHIND_SHARE;
  const aheadSpan = AHEAD_M * (1 + AHEAD_BEHIND_SHARE);
  const startAt = startM > 0 && total > 0 ? startM / total : undefined;
  const startPoint = startM > 0 ? trackPosition(track, startM) : undefined;
  const pickWord = mode === 'start' ? 'Click or use the arrow keys to choose where to start.' : '';

  const fullProfile = (
    <RouteProfile
      profile={profile}
      size="md"
      progress={progress}
      riders={others}
      startAt={startAt}
      testId="route-profile"
      label={`Elevation profile of ${track.name}, ${km}: ${pct} % done.`}
    />
  );
  const ahead = !finished && <AheadProfile track={track} distanceM={d} aheadM={AHEAD_M} />;
  const map = (
    <RouteOutline
      outline={outline}
      size="md"
      loop={track.loop}
      position={position}
      progress={progress}
      riders={others}
      startPoint={startPoint}
      testId="route-map"
      label={`Map of ${track.name}, north up. You are ${pct} % along${others.length > 0 ? `; ${others.length} other ${others.length === 1 ? 'rider' : 'riders'} shown as dots` : ''}.`}
    />
  );
  return (
    <section
      className={`route-card card${finished ? ' is-complete' : ''}`}
      data-testid="ride-route"
      data-route-id={track.id}
      data-finished={finished || undefined}
      aria-labelledby="ride-route-name"
    >
      <div className="rc-inner">
        <div className="rc-head">
          <h2 className="rc-name" id="ride-route-name">
            {track.name}
          </h2>
          <span className="rc-kind">
            {/* The start/jump note takes the place of the kind (the lap is in the stats). */}
            {note ? '' : track.loop ? `Loop · Lap ${lap}` : 'Point to point'}
            {difficulty !== null && difficulty < 100 && (
              <span data-testid="route-difficulty-note">{`${note ? '' : ' · '}climbs felt at ${Math.round(difficulty)} %`}</span>
            )}
          </span>
          <span
            className={`rc-start${note?.jumped ? ' is-jump' : ''}`}
            data-testid="route-start-note"
            data-jumped={note?.jumped || undefined}
            role="status"
          >
            {note?.text ?? ''}
          </span>
          {jumps && idle && startM > 0 && (
            <button
              type="button"
              className="btn btn-small btn-quiet rc-start-reset"
              data-testid="route-start-reset"
              aria-label="Start from the beginning"
              title="Start from the beginning"
              onClick={() => jumps.jumpTo(0)}
            >
              Reset
            </button>
          )}
        </div>
        {finished ? (
          <p className="rc-complete" data-testid="route-complete" role="status">
            <span aria-hidden="true">✓</span> Route complete — finish the ride to save it.
          </p>
        ) : (
          <dl className="rc-stats">
            <div data-testid="route-remaining">
              <dt>To go</dt>
              <dd>{formatKm(remaining)}</dd>
            </div>
            <div data-testid="route-climb-left">
              <dt>Climbing left</dt>
              <dd>{formatClimb(climbLeft)}</dd>
            </div>
            {track.loop && (
              <div data-testid="route-lap">
                <dt>Lap</dt>
                <dd>{lap}</dd>
              </div>
            )}
          </dl>
        )}
        <div className="rc-graphs">
          {jumps ? (
            <>
              <div className="rc-profiles">
                <ProfilePicker
                  mode={mode}
                  testId="route-profile-pick"
                  label={`Elevation profile of ${track.name}, ${km}. ${pickWord}`.trim()}
                  distanceAt={(f) => f * total}
                  fractionOf={(m) => (total > 0 ? Math.max(0, Math.min(1, m / total)) : null)}
                  spanM={total}
                  info={info}
                  currentM={d}
                  onPick={onPick}
                >
                  {fullProfile}
                </ProfilePicker>
                {ahead && (
                  <ProfilePicker
                    mode={mode}
                    testId="route-ahead-pick"
                    label={`The next ${AHEAD_M} m of ${track.name}.`}
                    distanceAt={(f) => aheadFrom + f * aheadSpan}
                    fractionOf={(m) => {
                      const f = (m - aheadFrom) / aheadSpan;
                      return f >= 0 && f <= 1 ? f : null;
                    }}
                    spanM={aheadSpan}
                    info={info}
                    currentM={d}
                    onPick={onPick}
                  >
                    {ahead}
                  </ProfilePicker>
                )}
              </div>
              <MapPicker
                mode={mode}
                testId="route-map-pick"
                box={OUTLINE_BOX}
                pick={(x, y) =>
                  chooseMapCandidate(
                    mapCandidates(track, fit, x, y, MAP_HIT_RADIUS),
                    d,
                    total,
                    track.loop,
                  )?.distanceM ?? null
                }
                boxOf={(m) => {
                  const p = trackPosition(track, m);
                  return fit.map(p.x, p.y);
                }}
                info={info}
                onPick={onPick}
              >
                {map}
              </MapPicker>
            </>
          ) : (
            <>
              <div className="rc-profiles">
                {fullProfile}
                {ahead}
              </div>
              {map}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
