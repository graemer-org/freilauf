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
   * Optional (Freilauf Rumble, docs/adr/0008-rumble-items.md): sent by every client that
   * supports Freilauf Rumble, in every group ride — its presence (with `v` ≥ 2) is how others
   * tell a compatible app from an old one. In a Rumble it also carries the signed race offset,
   * what acts on this rider (applied by the rider to itself; everyone renders it from here)
   * and the mud puddles this rider dropped on the road.
   *
   * Apps of the superseded format (ADR 0007) sent `cards: { v: 1, … }` instead; that field
   * is not read any more, so such an app counts as one without Freilauf Rumble.
   */
  items?: RiderItems;
}

/** How a group ride plays (`GroupRules.mode`). */
export type GroupModeWire = 'normal' | 'rumble';

/** Group-level switches set by the host. */
export interface GroupRules {
  /** Power-ups allowed in this group ride (default true). */
  powerUps: boolean;
  /**
   * Optional: 'normal' (power-ups, absent = normal) or 'rumble' (Freilauf Rumble). A mode a
   * client does not know (e.g. ADR 0007's old one) counts as normal.
   */
  mode?: GroupModeWire;
}

/**
 * A mud puddle on the road, as its dropper broadcasts it. It lies at a race position: on the
 * route `routeId` (route metres + the dropper's race offset when dropped), or — without
 * `routeId` — at a ridden-distance race position (ridden metres + offset).
 */
export interface WirePuddle {
  /** `<epoch>.<seq>`, unique per dropper. */
  id: string;
  m: number;
  routeId?: string;
  /** Seconds until it dries up. */
  s: number;
  /** It hit someone (or a rain cape took it): gone from the road. */
  used?: true;
}

/** A rider's Freilauf Rumble state as broadcast (see `RiderState.items`). */
export interface RiderItems {
  /** Rumble protocol version the client speaks (2; 1 was ADR 0007's superseded format). */
  v: number;
  /**
   * Rumble only: the signed race offset (m), negative after hits. Placed by this instead of
   * `raceOffsetM`, which stays ≥ 0 for old clients.
   */
  offsetM?: number;
  /** A hit slowing the rider now: the item and seconds left. */
  hit?: { kind: string; s: number };
  /** Seconds the rider's rain cape stays up. */
  capeS?: number;
  /** Seconds of protection left after a hit. */
  protectedS?: number;
  /** Items held (0 … 8). */
  held?: number;
  /** Not in the race right now (paused, ERG step, FTP test, items off): nothing hits them. */
  away?: boolean;
  /** Mud puddles this rider dropped that are still on the road (or just used), at most 4. */
  puddles?: WirePuddle[];
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
   * Metres of `gapM` that come from that rider's power-ups / items (race position − ridden), if
   * any. Negative in a Rumble for a rider who lost ground to hits.
   */
  raceOffsetM?: number;
  /** That rider's Rumble state (absent: their app does not support Freilauf Rumble). */
  items?: RiderItems;
  /** True when no update arrived for a while. */
  stale: boolean;
}
