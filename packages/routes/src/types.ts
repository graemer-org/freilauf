/**
 * A route prepared for riding and drawing: the original track resampled at a
 * fixed distance step, with smoothed elevation. Everything is plain arrays
 * indexed by sample, sample i lying at distance i × stepM from the start.
 *
 * This is the contract between the route engine, the ride controller and
 * the renderers; it is also what gets stored and shared.
 */
export interface RouteTrack {
  id: string;
  name: string;
  description?: string;
  /** Distance between samples in metres (e.g. 10). */
  stepM: number;
  /** Number of samples; totalDistanceM = (count − 1) × stepM. */
  count: number;
  totalDistanceM: number;
  /** Smoothed elevation above sea level in metres. */
  elevationM: number[];
  /** Position in a local flat projection, metres east / north of the first sample. */
  x: number[];
  y: number[];
  /** Direction of travel in radians, 0 = north, clockwise, unwrapped (continuous). */
  headingRad: number[];
  /** Geographic position of each sample, for the recording. Degrees. */
  lat: number[];
  lon: number[];
  /** Total climbing and descending in metres (from the smoothed elevation). */
  ascentM: number;
  descentM: number;
  /** True if the end is close enough to the start to ride it as laps. */
  loop: boolean;
}

/** Where the rider is on the route right now, as shown in the UI and overlay. */
export interface RoutePosition {
  routeId: string;
  name: string;
  totalDistanceM: number;
  /** Distance along the route, 0 … totalDistanceM (wraps on a loop). */
  distanceM: number;
  /** 1-based lap on a loop route; always 1 otherwise. */
  lap: number;
  /**
   * Gradient of the road under the rider in percent. The trainer is told this × the difficulty
   * setting (LiveState.routeControl.trainerGradePercent); 0 past the finish.
   */
  gradePercent: number;
  elevationM: number;
  remainingM: number;
  ascentRemainingM: number;
  /** True once a non-loop route has been ridden to its end. */
  finished: boolean;
}
