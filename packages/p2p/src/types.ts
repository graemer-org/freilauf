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
  /** Metres ahead (+) or behind (−) of the local rider. */
  gapM: number;
  /** True when no update arrived for a while. */
  stale: boolean;
}
