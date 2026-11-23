/** What every rider broadcasts to the group a few times per second. */
export interface RiderState {
  name: string;
  /** Sender's clock, Unix epoch ms. Only compared against the same sender's earlier values. */
  sentAt: number;
  distanceM: number;
  speedMps: number;
  powerW: number;
  cadenceRpm: number;
  heartRateBpm: number | null;
  gear: number;
  /**
   * Optional (added later; older clients neither send nor read it): the route the rider rides
   * and where on it they are. Riders on the same route (same `id`) are placed by this instead
   * of by ridden distance, so riders at the same place on the road are side by side even when
   * one of them started further along or jumped (docs/routes.md, "Choosing where to start, and jumping").
   */
  route?: RiderRoute;
}

/** A rider's place on a route, as broadcast. */
export interface RiderRoute {
  /** Route id without the resolution suffix of a coarser shared copy (routeBaseId). */
  id: string;
  /** Distance along the route in metres (0 … length; wraps on a loop). */
  m: number;
}

/** A remote rider as shown in the UI, extrapolated to "now". */
export interface GroupRider {
  peerId: string;
  name: string;
  distanceM: number;
  speedMps: number;
  powerW: number;
  cadenceRpm: number;
  heartRateBpm: number | null;
  gear: number;
  /**
   * Metres ahead (+) or behind (−) of the local rider: along the route when both ride the same
   * route (`sameRoute`), otherwise by ridden distance.
   */
  gapM: number;
  /** True when `gapM` is measured along the route both riders share. */
  sameRoute?: boolean;
  /** True when no update arrived for a while. */
  stale: boolean;
}
