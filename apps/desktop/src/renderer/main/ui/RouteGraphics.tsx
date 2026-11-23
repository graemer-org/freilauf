import { memo, useId, useMemo } from 'react';
import type { RouteTrack } from '@freilauf/routes';
import {
  aheadGeometry,
  fitOutline,
  formatGradient,
  GRADE_BANDS,
  profileGeometry,
} from './routeView';

export const PROFILE_W = 600;
export const PROFILE_H = 120;

export interface RouteProfileProps {
  /** Elevations at evenly spaced points from start to finish. */
  profile: readonly number[];
  label: string;
  size?: 'sm' | 'md' | 'lg';
  /** 0…1: position marker; what is done is emphasised. */
  progress?: number | undefined;
  /** Other riders, as 0…1 along the route. */
  riders?: readonly { id: string; at: number; stale: boolean }[];
  /** 0…1: where the ride starts (a chosen start point); not drawn at 0. */
  startAt?: number | undefined;
  testId?: string;
}

/**
 * Elevation profile of a whole route, stretched to its box. With a
 * `progress` it marks the position and fills the part already ridden.
 */
export const RouteProfile = memo(function RouteProfile({
  profile,
  label,
  size = 'sm',
  progress,
  riders,
  startAt,
  testId,
}: RouteProfileProps) {
  const clipId = `rp-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const g = useMemo(
    () =>
      profileGeometry(profile, { width: PROFILE_W, height: PROFILE_H, padTop: 6, minSpanM: 40 }),
    [profile],
  );
  const at = progress === undefined ? null : Math.max(0, Math.min(1, progress));
  const x = at === null ? 0 : at * PROFILE_W;
  const elevAt = (t: number): number => {
    if (profile.length < 2) return PROFILE_H;
    const f = t * (profile.length - 1);
    const i = Math.min(profile.length - 2, Math.floor(f));
    return g.y(profile[i]! + (profile[i + 1]! - profile[i]!) * (f - i));
  };
  return (
    <svg
      className={`rt-profile rt-profile-${size}`}
      viewBox={`0 0 ${PROFILE_W} ${PROFILE_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-testid={testId}
      data-position={at === null ? undefined : at.toFixed(4)}
    >
      <path className="rt-profile-area" d={g.area} />
      {at !== null && (
        <>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={x} height={PROFILE_H} />
          </clipPath>
          <path className="rt-profile-done" d={g.area} clipPath={`url(#${clipId})`} />
        </>
      )}
      <path className="rt-profile-line" d={g.line} vectorEffect="non-scaling-stroke" />
      {riders?.map((r) => (
        <line
          key={r.id}
          className={`rt-profile-rider${r.stale ? ' is-stale' : ''}`}
          x1={r.at * PROFILE_W}
          x2={r.at * PROFILE_W}
          y1={elevAt(r.at) - 14}
          y2={PROFILE_H}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {startAt !== undefined && startAt > 0 && (
        <g data-testid="route-start-marker" data-at={startAt.toFixed(4)}>
          <line
            className="rt-profile-start"
            x1={startAt * PROFILE_W}
            x2={startAt * PROFILE_W}
            y1={elevAt(startAt) - 22}
            y2={PROFILE_H}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
      {at !== null && (
        <line
          className="rt-profile-marker"
          x1={x}
          x2={x}
          y1="0"
          y2={PROFILE_H}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
});

export const OUTLINE_BOX = 100;
/** Padding of the outline in its box, by size (the map picker fits the track the same way). */
export const outlinePad = (size: 'sm' | 'md' | 'lg'): number => (size === 'sm' ? 6 : 9);

export interface RouteOutlineProps {
  outline: readonly (readonly [number, number])[];
  label: string;
  size?: 'sm' | 'md' | 'lg';
  /** Position on the route as an outline point and heading (radians, 0 = north). */
  position?: { x: number; y: number; headingRad: number } | undefined;
  /** 0…1 of the outline done (emphasised). */
  progress?: number | undefined;
  /** Other riders as outline points. */
  riders?: readonly { id: string; x: number; y: number; stale: boolean; name: string }[];
  /** Mark the start (and finish of a point-to-point route). */
  loop?: boolean;
  /** A chosen start point (outline coordinates), marked with a ring. */
  startPoint?: { x: number; y: number } | undefined;
  testId?: string;
}

/** The route's shape, north up, with the position as an arrow when riding. */
export const RouteOutline = memo(function RouteOutline({
  outline,
  label,
  size = 'sm',
  position,
  progress,
  riders,
  loop,
  startPoint,
  testId,
}: RouteOutlineProps) {
  const fit = useMemo(
    () => fitOutline(outline, { width: OUTLINE_BOX, height: OUTLINE_BOX, pad: outlinePad(size) }),
    [outline, size],
  );
  const start = outline[0];
  const end = outline[outline.length - 1];
  const s = start ? fit.map(start[0], start[1]) : null;
  const e = end && !loop ? fit.map(end[0], end[1]) : null;
  const pos = position ? fit.map(position.x, position.y) : null;
  const done = progress === undefined ? null : Math.max(0, Math.min(1, progress));
  return (
    <svg
      className={`rt-map rt-map-${size}`}
      viewBox={`0 0 ${OUTLINE_BOX} ${OUTLINE_BOX}`}
      role="img"
      aria-label={label}
      data-testid={testId}
      data-heading={position ? ((position.headingRad * 180) / Math.PI).toFixed(1) : undefined}
    >
      <path className="rt-map-line" d={fit.path} />
      {done !== null && (
        <path
          className="rt-map-done"
          d={fit.path}
          pathLength={1000}
          strokeDasharray={`${(done * 1000).toFixed(1)} 1000`}
        />
      )}
      {s && <circle className="rt-map-start" cx={s[0]} cy={s[1]} r={size === 'sm' ? 3.2 : 2.6} />}
      {startPoint &&
        (() => {
          const [x, y] = fit.map(startPoint.x, startPoint.y);
          return (
            <circle
              className="rt-map-startpoint"
              data-testid="route-map-start-marker"
              cx={x}
              cy={y}
              r={size === 'sm' ? 3.4 : 3}
            />
          );
        })()}
      {e && <rect className="rt-map-end" x={e[0] - 2.4} y={e[1] - 2.4} width="4.8" height="4.8" />}
      {riders?.map((r) => {
        const [x, y] = fit.map(r.x, r.y);
        return (
          <circle
            key={r.id}
            className={`rt-map-rider${r.stale ? ' is-stale' : ''}`}
            cx={x}
            cy={y}
            r="2.6"
          >
            <title>{r.name}</title>
          </circle>
        );
      })}
      {pos && position && (
        <g
          className="rt-map-you"
          transform={`translate(${pos[0].toFixed(2)} ${pos[1].toFixed(2)}) rotate(${((position.headingRad * 180) / Math.PI).toFixed(1)})`}
        >
          <circle r="5.2" className="rt-map-you-halo" />
          <path d="M0 -4.6 L3.4 3.4 L0 1.6 L-3.4 3.4 Z" />
        </g>
      )}
    </svg>
  );
});

export const AHEAD_W = 600;
/** The "ahead" profile also shows this share of its length behind the rider. */
export const AHEAD_BEHIND_SHARE = 0.1;
export const AHEAD_H = 100;

/**
 * The next few hundred metres, zoomed: coloured by steepness (hue and
 * lightness step together; the slope shows the same), with the rider's
 * position and the steepest part labelled.
 */
export function AheadProfile({
  track,
  distanceM,
  aheadM = 600,
}: {
  track: RouteTrack;
  distanceM: number;
  aheadM?: number;
}) {
  const g = useMemo(
    () =>
      aheadGeometry(
        track,
        distanceM,
        { width: AHEAD_W, height: AHEAD_H },
        { aheadM, behindM: aheadM * AHEAD_BEHIND_SHARE },
      ),
    [track, distanceM, aheadM],
  );
  const label = g.steepest
    ? `Next ${aheadM} m: steepest part ${formatGradient(g.steepest.grade)}.`
    : `Next ${aheadM} m: no climbing to speak of.`;
  return (
    <div className="rt-ahead" data-testid="route-ahead">
      <svg
        viewBox={`0 0 ${AHEAD_W} ${AHEAD_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {g.chunks.map((c, i) => (
          <polygon
            key={i}
            className={`rt-grade rt-grade-${c.band}`}
            points={`${c.x0},${AHEAD_H} ${c.x0},${c.y0} ${c.x1 + 0.6},${c.y1} ${c.x1 + 0.6},${AHEAD_H}`}
          />
        ))}
        <path className="rt-ahead-line" d={g.line} vectorEffect="non-scaling-stroke" />
        <line
          className="rt-profile-marker"
          x1={g.riderX}
          x2={g.riderX}
          y1="0"
          y2={AHEAD_H}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {g.steepest && (
        <span
          className="rt-ahead-label"
          style={{
            left: `${Math.min(90, Math.max(10, ((g.steepest.x0 + g.steepest.x1) / 2 / AHEAD_W) * 100)).toFixed(1)}%`,
          }}
          aria-hidden="true"
        >
          {formatGradient(g.steepest.grade)}
        </span>
      )}
    </div>
  );
}

/** Colour key of the gradient bands, with words (colour is never the only signal). */
export function GradeLegend() {
  return (
    <ul className="rt-legend" aria-label="Gradient colours">
      {GRADE_BANDS.map((b) => (
        <li key={b.id}>
          <span className={`rt-swatch rt-grade-${b.id}`} aria-hidden="true" />
          {b.label}
        </li>
      ))}
    </ul>
  );
}
