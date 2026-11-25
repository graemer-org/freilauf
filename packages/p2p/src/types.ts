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
  /**
   * Optional (power-ups, docs/power-ups.md): metres the rider's race position is ahead of the
   * ridden distance because of power-ups. Riders are placed by distance + raceOffsetM (and on a
   * route by route position + raceOffsetM); the recorded ride never includes it.
   */
  raceOffsetM?: number;
  /**
   * Optional: rules of this group ride, sent by the rider who created it (the host). Unknown
   * fields are dropped, so a later mode (e.g. battles) adds its own fields here.
   */
  rules?: GroupRules;
  /**
   * Optional (Card Race, docs/adr/0007-card-race.md): sent by every client that supports the
   * Card Race, in every group ride — its presence is how others tell a compatible app from an
   * old one. In a Card Race it also carries the signed race offset and the effects acting on
   * this rider, which the rider applied to itself and everyone renders from here.
   */
  cards?: RiderCards;
}

/** How a group ride plays (`GroupRules.mode`). */
export type GroupModeWire = 'normal' | 'cardRace';

/** Group-level switches set by the host. */
export interface GroupRules {
  /** Power-ups allowed in this group ride (default true). */
  powerUps: boolean;
  /**
   * Optional (added with the Card Race): 'normal' (power-ups, absent = normal) or 'cardRace'.
   * Old clients ignore it and ride with normal power-ups.
   */
  mode?: GroupModeWire;
}

/** A rider's Card Race state as broadcast (see `RiderState.cards`). */
export interface RiderCards {
  /** Card Race protocol version the client speaks (1). */
  v: number;
  /**
   * Card Race only: the signed race offset (m), negative after attacks. Placed by this instead
   * of `raceOffsetM`, which stays ≥ 0 for old clients.
   */
  offsetM?: number;
  /** An attack acting on the rider now: kind and seconds left. */
  attack?: { kind: string; s: number };
  /** Seconds the rider's shield stays up. */
  shieldS?: number;
  /** Seconds of protection left after a hit. */
  protectedS?: number;
  /** Cards held (0 … 8). */
  held?: number;
  /** Not in the race right now (paused, ERG step, FTP test, cards off): attacks pass by. */
  away?: boolean;
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
  /**
   * Metres of `gapM` that come from that rider's power-ups / cards (race position − ridden), if
   * any. Negative in a Card Race for a rider who lost ground to attacks.
   */
  raceOffsetM?: number;
  /** That rider's Card Race state (absent: their app does not support the Card Race). */
  cards?: RiderCards;
  /** True when no update arrived for a while. */
  stale: boolean;
}
