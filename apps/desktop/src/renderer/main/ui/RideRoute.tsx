import { useMemo } from 'react';
import type { RouteTrack } from '@freilauf/routes';
import type { LiveState } from '../../../shared/contract';
import { useAppState } from './hooks';
import { AheadProfile, RouteOutline, RouteProfile } from './RouteGraphics';
import { routeDifficultyOf, useRouteTrack } from './routesApi';
import {
  formatClimb,
  formatKm,
  routeProgress,
  trackOutline,
  trackPosition,
  trackProfile,
} from './routeView';

type Riders = NonNullable<LiveState['group']>['riders'];
const NO_RIDERS: Riders = [];

/** Map, profile and what is left, for the route that drives this ride. */
export function RideRoute() {
  const track = useRouteTrack();
  if (!track) return null;
  return <RouteCard track={track} />;
}

function RouteCard({ track }: { track: RouteTrack }) {
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
            {track.loop ? `Loop · Lap ${lap}` : 'Point to point'}
            {difficulty !== null && difficulty < 100 && (
              <span data-testid="route-difficulty-note">{` · climbs felt at ${Math.round(difficulty)} %`}</span>
            )}
          </span>
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
          <div className="rc-profiles">
            <RouteProfile
              profile={profile}
              size="md"
              progress={progress}
              riders={others}
              testId="route-profile"
              label={`Elevation profile of ${track.name}, ${km}: ${pct} % done.`}
            />
            {!finished && <AheadProfile track={track} distanceM={d} />}
          </div>
          <RouteOutline
            outline={outline}
            size="md"
            loop={track.loop}
            position={position}
            progress={progress}
            riders={others}
            testId="route-map"
            label={`Map of ${track.name}, north up. You are ${pct} % along${others.length > 0 ? `; ${others.length} other ${others.length === 1 ? 'rider' : 'riders'} shown as dots` : ''}.`}
          />
        </div>
      </div>
    </section>
  );
}
