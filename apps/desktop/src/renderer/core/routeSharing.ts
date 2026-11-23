/**
 * Routes in a group ride: a shared document of kind `route` holding `encodeRoute(track)` at a
 * resolution that fits what is left of the rider's 32 KiB document budget. See
 * docs/adr/0004-routes.md ("Sharing").
 */
import { COMMUNITY_KINDS, KIND_STANDING } from '@freilauf/community';
import type { RouteTrack, ShareRouteResult } from '@freilauf/routes';
import {
  ROUTE_SHARE_BUDGET_BYTES,
  decodeRoute,
  simplifyForSharing,
  utf8ByteLength,
} from '@freilauf/routes';

export const ROUTE_KIND = 'route';
/** The transport's per-rider budget for all documents (docs/p2p.md). */
const TRANSPORT_TOTAL_BYTES = 32_768;
/** Kept for the community standing (identity + totals) even when a route is shared. */
export const STANDING_RESERVE_BYTES = 1_024;
const MARGIN_BYTES = 256;

/**
 * Bytes a shared route may take next to the rider's other documents: everything that is not
 * community (a workout) counts in full, the community standing at least STANDING_RESERVE_BYTES;
 * challenges and relays make room (CommunityService.makeRoom).
 */
export function routeShareBudget(
  localDocuments: readonly { kind: string; text: string }[],
): number {
  let other = 0;
  let standing = 0;
  for (const d of localDocuments) {
    if (d.kind === ROUTE_KIND) continue;
    if (d.kind === KIND_STANDING) standing = utf8ByteLength(d.text);
    else if (!COMMUNITY_KINDS.includes(d.kind)) other += utf8ByteLength(d.text);
  }
  const left =
    TRANSPORT_TOTAL_BYTES - other - Math.max(STANDING_RESERVE_BYTES, standing) - MARGIN_BYTES;
  return Math.max(0, Math.min(ROUTE_SHARE_BUDGET_BYTES, left));
}

/** The route as it would be shared now, or why it cannot be. */
export function prepareRouteShare(
  track: RouteTrack,
  localDocuments: readonly { kind: string; text: string }[],
): ShareRouteResult {
  const budget = routeShareBudget(localDocuments);
  if (budget < 1024)
    return { ok: false, reason: 'there is no room left next to the shared workout' };
  return simplifyForSharing(track, budget);
}

export interface SharedRouteTrack {
  peerId: string;
  peerName: string;
  track: RouteTrack;
}

/** Only routes that decode (and thereby validate) are offered. */
export function decodeSharedRoutes(
  docs: readonly { peerId: string; peerName: string; text: string }[],
): SharedRouteTrack[] {
  const out: SharedRouteTrack[] = [];
  for (const d of docs) {
    const decoded = decodeRoute(d.text);
    if (decoded.ok) out.push({ peerId: d.peerId, peerName: d.peerName, track: decoded.track });
  }
  return out;
}

/** What sharing a route needs from the group (JoinedGroup) and from the community sync. */
export interface RouteShareGroup {
  shareRoute?(text: string): string | null;
  stopSharingRoute?(): void;
  getLocalDocuments(): { kind: string; text: string }[];
}
export interface RouteShareCommunity {
  makeRoom(reserveBytes: number, reserveSlots?: number): void;
  resync(): void;
}

/**
 * Shares a route: withdraws the previous one, fits the route into what is left of the budget,
 * lets the community extras make room (one document slot and the bytes), shares, and lets the
 * community re-publish. On failure nothing of ours is shared.
 */
export function shareRouteInGroup(
  group: RouteShareGroup,
  community: RouteShareCommunity,
  track: RouteTrack,
): ShareRouteResult {
  if (!group.shareRoute) return { ok: false, reason: 'this group connection cannot share routes' };
  group.stopSharingRoute?.();
  const prepared = prepareRouteShare(track, group.getLocalDocuments());
  if (!prepared.ok) {
    community.resync();
    return prepared;
  }
  community.makeRoom(prepared.bytes, 1);
  const refused = group.shareRoute(prepared.text);
  community.resync();
  return refused ? { ok: false, reason: `the group refused it (${refused})` } : prepared;
}
