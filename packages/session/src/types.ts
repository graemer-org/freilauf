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
}

/** Where on a route a distance is; see RideSession.setPositionSource. */
export interface RoutePositionFix {
  lat: number;
  lon: number;
  altitudeM: number;
}

export interface RecordedRide {
  id: string;
  name: string;
  /** Unix epoch milliseconds. */
  startedAt: number;
  riderMassKg: number;
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
