/** One recorded data point (1 Hz). */
export interface RideSample {
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** Seconds of moving/recorded time since the start of the ride. */
  elapsedS: number;
  powerW: number;
  cadenceRpm: number;
  heartRateBpm: number | null;
  speedMps: number;
  distanceM: number;
  gradePercent: number;
  /** 1-based virtual gear. */
  gear: number;
  /** Position on a route (degrees, WGS 84), when the ride followed one. */
  lat?: number;
  lon?: number;
  /** Elevation of the route at this point (m), when the ride followed one. */
  altitudeM?: number;
  /**
   * Route segment: 0 (or absent) from the start of the ride, +1 at every jump along the route
   * (docs/routes.md, "Choosing where to start, and jumping"). Positions within a segment are continuous; between segments
   * they are not, so the FIT file starts a new lap at each change and position-derived totals
   * (ascent, descent) never span two segments. Ridden distance stays continuous.
   */
  segment?: number;
}

/** Where on a route a distance is; see RideSession.setPositionSource. */
export interface RoutePositionFix {
  lat: number;
  lon: number;
  altitudeM: number;
  /** See RideSample.segment; omitted or 0 before the first jump. */
  segment?: number;
}

/**
 * The route a ride followed (docs/ghost.md): which one, and where on it each route segment
 * (RideSample.segment) started, so every sample's place along the route is known exactly:
 * `offsetsM[segment] + sample.distanceM`, counted from the route's start and continuing across
 * laps (lap 2 starts at `lengthM`). Nothing here is new information about the rider: the samples
 * already carry the positions; this only names the route they lie on.
 */
export interface RideRoute {
  /** routeBaseId of the route (shared copies of one route have the same base id). */
  id: string;
  lengthM: number;
  loop: boolean;
  /** Route position (m) at ridden distance 0 for each segment: [start point, after jump 1, …]. */
  offsetsM: number[];
}

export interface RecordedRide {
  id: string;
  name: string;
  /** Unix epoch milliseconds. */
  startedAt: number;
  riderMassKg: number;
  /**
   * The rider's FTP (W) when the ride was recorded, for the fat/carbohydrate estimate
   * (energy.ts). Absent in rides recorded before it was stored.
   */
  ftpW?: number;
  /** The route the ride followed; absent for free rides and rides recorded before it existed. */
  route?: RideRoute;
  samples: RideSample[];
}

/** Live values shown in the main window and overlay. */
export interface RideSnapshot {
  state: 'idle' | 'riding' | 'paused';
  elapsedS: number;
  distanceM: number;
  speedMps: number;
  powerW: number;
  power3sW: number;
  wattsPerKg: number;
  cadenceRpm: number;
  heartRateBpm: number | null;
  gear: number;
  gearCount: number;
  gradePercent: number;
}
