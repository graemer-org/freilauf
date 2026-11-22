import { memo, useId, useMemo } from 'react';
import type { Workout } from '@freilauf/workouts';
import { CHART_HEIGHT, CHART_WIDTH, chartGeometry } from './workoutView';

export interface WorkoutChartProps {
  workout: Workout;
  /** Text alternative (the chart is an image to assistive tech). */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  /** Crop open-ended workouts to the useful part. */
  horizonS?: number | undefined;
  /** 0…1: draws a position marker and dims what is done. */
  progress?: number | undefined;
  testId?: string;
}

/**
 * Power profile: one block per segment, coloured by power zone (the colours
 * also step in lightness, and height carries the same information). Free ride
 * is a neutral hatched block. Drawn in a fixed coordinate space and stretched.
 */
export const WorkoutChart = memo(function WorkoutChart({
  workout,
  label,
  size = 'sm',
  horizonS,
  progress,
  testId,
}: WorkoutChartProps) {
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const geometry = useMemo(
    () => chartGeometry(workout, horizonS !== undefined ? { horizonS } : {}),
    [workout, horizonS],
  );
  const markerX = progress === undefined ? null : Math.max(0, Math.min(1, progress)) * CHART_WIDTH;
  return (
    <svg
      className={`wo-chart wo-chart-${size}`}
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-testid={testId}
    >
      <defs>
        <pattern
          id={hatchId}
          width="10"
          height="10"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="10" height="10" className="wo-free-fill" />
          <line x1="0" y1="0" x2="0" y2="10" className="wo-free-line" />
        </pattern>
      </defs>
      <line
        className="wo-ftp-line"
        x1="0"
        x2={CHART_WIDTH}
        y1={geometry.ftpY}
        y2={geometry.ftpY}
        vectorEffect="non-scaling-stroke"
      />
      {geometry.shapes.map((s, i) =>
        s.zone === null ? (
          <polygon key={i} points={s.points} fill={`url(#${hatchId})`} className="wo-free" />
        ) : (
          <polygon key={i} points={s.points} className={`wo-z wo-z${s.zone}`} />
        ),
      )}
      {markerX !== null && (
        <>
          <rect className="wo-done" x="0" y="0" width={markerX} height={CHART_HEIGHT} />
          <line
            className="wo-marker"
            x1={markerX}
            x2={markerX}
            y1="0"
            y2={CHART_HEIGHT}
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
});
