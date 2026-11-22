/**
 * Group rides, the rider-facing side of connecting: what kind of signalling
 * server address is configured, where a pasted invite points to, and what to
 * tell the rider when entering a room fails. Pure (unit-tested in
 * groupConnection.test.ts); the full error always goes to the diagnostic log.
 *
 * Facts this relies on (packages/p2p, apps/signalling):
 * - An invite link `freilauf://join/<CODE>?s=<url>` carries the host's server;
 *   a bare code does not and uses the server configured in this app.
 * - The server creates a room on the first join. A wrong code is therefore not
 *   an error: it opens a new, empty room.
 * - `WebSocketSignalling.join()` keeps reconnecting until its 10 s timeout and
 *   then rejects with `join-timeout`, whatever the cause. `probeSignallingServer`
 *   (signallingProbe.ts) tells the causes apart afterwards.
 */
import { formatRoomCode, MAX_PEERS_PER_ROOM, parseJoinLink } from '@freilauf/p2p';
import type { ProbeResult } from './signallingProbe';
export { LEGACY_DEFAULT_SIGNALLING_URL } from '../../shared/contract';

/**
 * What "Use a server on this computer (for testing)" sets. Deliberately not
 * `LEGACY_DEFAULT_SIGNALLING_URL`, so the settings migration that clears the
 * old default never undoes this explicit choice.
 */
export const LOCAL_TEST_SIGNALLING_URL = 'ws://127.0.0.1:8787';

/** The rider guide, linked from the Group tab. */
export const GROUP_GUIDE_URL =
  'https://github.com/graemer-org/freilauf/blob/main/docs/group-rides.md';

export type SignallingUrlKind =
  /** Nothing set up: group rides need an invite link or a server address. */
  | 'none'
  /** Not a ws:// or wss:// address. */
  | 'invalid'
  /** This computer only (localhost, 127.x, ::1). */
  | 'local'
  /** A private network address: only riders on the same network can reach it. */
  | 'lan'
  /** Anything else, presumably reachable from the internet. */
  | 'remote';

const WS_URL = /^wss?:\/\/[^\s/?#]+[^\s]*$/i;

function hostnameOf(url: string): string | null {
  if (!WS_URL.test(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

function isPrivate(host: string): boolean {
  if (/^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true;
  return host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa');
}

export function signallingUrlKind(url: string): SignallingUrlKind {
  const t = url.trim();
  if (t === '') return 'none';
  const host = hostnameOf(t);
  if (host === null || host === '') return 'invalid';
  if (isLoopback(host)) return 'local';
  if (isPrivate(host)) return 'lan';
  return 'remote';
}

/** `wss://host:port` for messages and logs (no path, no credentials). */
export function serverLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
}

/**
 * Checks what a host typed as their server address. Returns null when it is
 * usable, otherwise a sentence saying how to fix it.
 */
export function signallingUrlProblem(text: string): string | null {
  const t = text.trim();
  if (t === '') return 'Enter the address of your server, e.g. wss://example.org/signal.';
  if (t.length > 500) return 'That address is too long.';
  if (/\s/.test(t)) return 'The address must not contain spaces.';
  const https = /^(https?):\/\/(.*)$/i.exec(t);
  if (https) {
    const scheme = https[1]!.toLowerCase() === 'https' ? 'wss' : 'ws';
    return `Use ${scheme}:// instead of ${https[1]!.toLowerCase()}:// — e.g. ${scheme}://${https[2]}`;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    return `Start the address with wss:// — e.g. wss://${t}`;
  }
  if (!/^wss?:\/\//i.test(t)) return 'The address must start with wss:// (or ws://).';
  if (hostnameOf(t) === null) return 'That is not a valid address.';
  return null;
}

// ─────────────────────────── join targets ───────────────────────────

export type GroupFailureKind =
  /** A bare code, and no server is configured in this app. */
  | 'no-server'
  /** Neither an invite link nor a room code. */
  | 'invalid-invite'
  /** The configured address is not a ws(s):// URL. */
  | 'invalid-server'
  /** navigator.onLine is false. */
  | 'offline'
  /** Nothing answered at the address. */
  | 'unreachable'
  /** Something answered, but not a Freilauf signalling server. */
  | 'not-signalling'
  /** The room already has the maximum number of riders. */
  | 'room-full'
  | 'unknown';

/** Thrown before any connection is attempted (bad input, nothing configured). */
export class GroupSetupError extends Error {
  readonly kind: GroupFailureKind;
  constructor(kind: GroupFailureKind, message: string) {
    super(message);
    this.name = 'GroupSetupError';
    this.kind = kind;
  }
}

export interface JoinTarget {
  roomCode: string;
  /** The server the room lives on. */
  signallingUrl: string;
  /** True when the server came from the invite link rather than this app's settings. */
  fromLink: boolean;
  /** What to hand to the connector: the bare link, without any surrounding text. */
  input: string;
}

/**
 * Where a pasted invite points to. Accepts the link on its own or inside a
 * longer message ("Ride with me: freilauf://join/…"), or a bare room code.
 * Throws a `GroupSetupError` when it cannot work.
 */
export function resolveJoinTarget(input: string, configuredUrl: string): JoinTarget {
  const text = input.trim();
  const embedded = /freilauf:\/\/join\/[^\s<>"']+/i.exec(text)?.[0];
  const candidate = embedded ?? text;
  const link = parseJoinLink(candidate);
  if (!link) {
    throw new GroupSetupError(
      'invalid-invite',
      'Neither an invite link nor a room code was found in the input.',
    );
  }
  if (link.signallingUrl) {
    return {
      roomCode: link.roomCode,
      signallingUrl: link.signallingUrl,
      fromLink: true,
      input: candidate,
    };
  }
  const kind = signallingUrlKind(configuredUrl);
  if (kind === 'none') {
    throw new GroupSetupError('no-server', 'A bare room code, and no server is configured.');
  }
  if (kind === 'invalid') {
    throw new GroupSetupError('invalid-server', 'The configured server address is not valid.');
  }
  return {
    roomCode: link.roomCode,
    signallingUrl: configuredUrl.trim(),
    fromLink: false,
    input: candidate,
  };
}

/** The server a new ride is created on; throws a `GroupSetupError` when there is none. */
export function resolveHostServer(configuredUrl: string): string {
  const kind = signallingUrlKind(configuredUrl);
  if (kind === 'none') throw new GroupSetupError('no-server', 'No server is configured.');
  if (kind === 'invalid') {
    throw new GroupSetupError('invalid-server', 'The configured server address is not valid.');
  }
  return configuredUrl.trim();
}

// ─────────────────────────── failures ───────────────────────────

export interface GroupFailure {
  kind: GroupFailureKind;
  /** Short headline. */
  title: string;
  /** What happened, in plain words. */
  message: string;
  /** What to do next. */
  next: string;
  /** A better server address to try, when the probe found one. */
  suggestion?: string;
}

export interface FailureContext {
  /** navigator.onLine; undefined when unknown. */
  online?: boolean;
  /** Result of probing the server after a timeout, if one was run. */
  probe?: ProbeResult | null;
  /** The server that was used. */
  signallingUrl?: string;
  /** Creating a ride (host) or joining one (guest). */
  action?: 'create' | 'join';
}

function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Which failure the rider gets told about. Pure. */
export function classifyGroupError(err: unknown, ctx: FailureContext = {}): GroupFailureKind {
  if (err instanceof GroupSetupError) return err.kind;
  const code = errorCode(err);
  if (code === 'room-full') return 'room-full';
  if (code === 'invalid-room') return 'invalid-invite';
  if (ctx.online === false) return 'offline';
  if (code === 'join-timeout' || code === 'connect-failed') {
    switch (ctx.probe?.kind) {
      case 'offline':
        return 'offline';
      case 'not-signalling':
      case 'wrong-path':
        return 'not-signalling';
      case 'invalid':
        return 'invalid-server';
      case 'ok':
        return 'unknown';
      default:
        return 'unreachable';
    }
  }
  return 'unknown';
}

const LOG_HINT = 'The details are in the diagnostic log (Settings → Diagnostics).';

/** The rider-facing text for a failure kind. */
export function describeGroupFailure(
  kind: GroupFailureKind,
  ctx: FailureContext = {},
): GroupFailure {
  const server = ctx.signallingUrl ? serverLabel(ctx.signallingUrl) : 'the server';
  const asHost = ctx.action === 'create';
  switch (kind) {
    case 'no-server':
      return {
        kind,
        title: 'A code alone is not enough here',
        message:
          'A room code does not say which server the ride is on, and no server is set up in this app.',
        next: 'Ask your friend for the whole invite link (it starts with freilauf://join/) and paste that. If you host rides yourself, enter your server address first.',
      };
    case 'invalid-invite':
      return {
        kind,
        title: 'That is not an invite',
        message: 'No invite link or room code was found in what you entered.',
        next: 'Paste the invite link your friend sent (it starts with freilauf://join/), or a six-character room code such as ABC-DEF.',
      };
    case 'invalid-server':
      return {
        kind,
        title: 'The server address is not valid',
        message: 'A server address starts with wss:// (or ws://), e.g. wss://example.org/signal.',
        next: 'Correct it in Settings → Group, or ask the host for a new invite link.',
      };
    case 'offline':
      return {
        kind,
        title: 'You appear to be offline',
        message: 'This computer has no network connection right now.',
        next: 'Check your Wi-Fi or cable, then try again.',
      };
    case 'unreachable':
      return {
        kind,
        title: 'Server not reachable',
        message: `Nothing answered at ${server}. The server may be switched off, the address may be mistyped, or it may not be reachable from this network.`,
        next: asHost
          ? 'Check that your server is running and that the address is right — “Test connection” in the Group tab checks it. A server on a home network needs a reverse proxy to be reachable from outside.'
          : 'Ask the person who sent the invite to check their server, then try the link again.',
      };
    case 'not-signalling': {
      const suggestion = ctx.probe?.kind === 'wrong-path' ? ctx.probe.suggestion : undefined;
      return {
        kind,
        title: 'That address is not a group-ride server',
        message: `Something answered at ${server}, but it is not a Freilauf signalling server.`,
        next: suggestion
          ? `The server answers at ${suggestion} — use that address instead.`
          : 'Check the path: with the Docker or web version the address ends in /signal. Behind a reverse proxy, WebSocket forwarding must be switched on.',
        ...(suggestion ? { suggestion } : {}),
      };
    }
    case 'room-full':
      return {
        kind,
        title: 'This ride is full',
        message: `The room already has ${MAX_PEERS_PER_ROOM} riders, the most a group ride supports.`,
        next: 'Ask the host to start a second ride for the rest of the group.',
      };
    case 'unknown':
      return {
        kind,
        title: asHost ? 'Could not start the ride' : 'Could not join the ride',
        message:
          ctx.probe?.kind === 'ok'
            ? `${server} answers, but the room could not be entered in time.`
            : 'Something unexpected went wrong.',
        next: `Try again. ${LOG_HINT}`,
      };
  }
}

// ─────────────────────────── in the room ───────────────────────────

export type PeerLinkState = 'connecting' | 'connected' | 'trouble';

export interface PeerView {
  peerId: string;
  name: string;
  state: PeerLinkState;
}

export interface PeerSample {
  peerId: string;
  name: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'failed';
  attempts: number;
}

/** A peer still not connected after this long is shown as having trouble. */
export const PEER_TROUBLE_AFTER_MS = 25_000;

/**
 * Per-rider connection state for the Group tab. `firstSeen` remembers when
 * each not-yet-connected peer appeared (mutated: entries are added and
 * removed), so "connecting for too long" can be told apart from "just joined".
 */
export function peerViews(
  peers: readonly PeerSample[],
  firstSeen: Map<string, number>,
  now: number,
): PeerView[] {
  const present = new Set(peers.map((p) => p.peerId));
  for (const id of [...firstSeen.keys()]) if (!present.has(id)) firstSeen.delete(id);
  return peers.map((p) => {
    if (p.status === 'connected') {
      firstSeen.delete(p.peerId);
      return { peerId: p.peerId, name: p.name || 'Rider', state: 'connected' };
    }
    if (!firstSeen.has(p.peerId)) firstSeen.set(p.peerId, now);
    const waited = now - (firstSeen.get(p.peerId) ?? now);
    const trouble = p.status === 'failed' || p.attempts >= 2 || waited >= PEER_TROUBLE_AFTER_MS;
    return { peerId: p.peerId, name: p.name || 'Rider', state: trouble ? 'trouble' : 'connecting' };
  });
}

/** Explains an empty room. */
export function emptyRoomHint(
  role: 'host' | 'guest',
  roomCode: string,
): {
  title: string;
  message: string;
} {
  if (role === 'host') {
    return {
      title: 'Waiting for friends',
      message: 'Send them the invite link. They paste it into their Group tab — nothing to set up.',
    };
  }
  return {
    title: 'Nobody else is here yet',
    message: `If your friend should already be riding, check the code (${formatRoomCode(roomCode)}): a wrong code simply opens a new, empty room. With a code alone you also need the same server as the host — the invite link takes care of both.`,
  };
}

/** Explains a rider who is in the room but cannot be reached directly. */
export const PEER_TROUBLE_HINT =
  'You are both in the room, but your computers cannot connect to each other directly. This usually means a restrictive network (some mobile, company or university networks). Freilauf keeps trying; switching one of you to another network, e.g. home Wi-Fi instead of a phone hotspot, usually helps.';

// ─────────────────────────── "Test connection" ───────────────────────────

export interface ProbeMessage {
  tone: 'ok' | 'error';
  text: string;
  /** An address that does work (wrong path); offered as a one-click fix. */
  suggestion?: string;
}

/** What "Test connection" tells the host. */
export function describeProbe(result: ProbeResult, url: string): ProbeMessage {
  const server = serverLabel(url);
  switch (result.kind) {
    case 'ok':
      return {
        tone: 'ok',
        text: `Reachable: ${server} is a Freilauf signalling server (answered in ${result.ms} ms).`,
      };
    case 'offline':
      return {
        tone: 'error',
        text: 'You appear to be offline. Check your network, then test again.',
      };
    case 'invalid':
      return {
        tone: 'error',
        text: 'This address cannot be used. On a page opened over https, only wss:// addresses work.',
      };
    case 'unreachable':
      return {
        tone: 'error',
        text: `Not reachable: nothing answered at ${server}. Check that the server is running and the address is right. For friends elsewhere it must also be reachable from the internet.`,
      };
    case 'not-signalling':
      return {
        tone: 'error',
        text: `Not a signalling server: something answers at ${server}, but not Freilauf. Check the path (the Docker version uses /signal) and that your reverse proxy forwards WebSockets.`,
      };
    case 'wrong-path':
      return {
        tone: 'error',
        text: `Nothing at this path, but ${server} answers at ${result.suggestion}.`,
        suggestion: result.suggestion,
      };
  }
}
