/**
 * Group rides, the rider-facing side of connecting: where a pasted invite
 * points to, how a new ride is opened, and what to tell the rider when it
 * fails. Pure (unit-tested in groupConnection.test.ts); the full error always
 * goes to the diagnostic log.
 *
 * Two ways to find each other (docs/group-rides.md, ADR 0003):
 * - **Public relays (default, no setup).** An invite is
 *   `freilauf://join/<CODE>#<SECRET>` or the full code `ABC-DEF-GHJK-MNPQ-RSTU`;
 *   the secret encrypts the handshake on the relays. A bare six-character code
 *   lacks the secret and cannot open a relay ride.
 * - **Own signalling server (advanced).** Old-style links
 *   `freilauf://join/<CODE>?s=<url>` carry the server; with "Use my own
 *   signalling server" on, rides are created there and bare codes join there.
 *   The server creates a room on the first join, so a wrong code is not an
 *   error: it opens a new, empty room. `WebSocketSignalling.join()` rejects with
 *   `join-timeout` whatever the cause; `probeSignallingServer`
 *   (signallingProbe.ts) tells the causes apart afterwards.
 */
import { formatRoomCode, MAX_RIDERS_PER_GROUP, parseInvite } from '@freilauf/p2p';
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
  /** Own server switched on, but no address entered. */
  | 'no-server'
  /** Neither an invite link nor a room code. */
  | 'invalid-invite'
  /** Looks like an invite, but the check symbol does not match: a typo. */
  | 'invite-typo'
  /** A bare room code where the invite's secret is needed (relay rides). */
  | 'secret-missing'
  /** The configured own-server address is not a ws(s):// URL. */
  | 'invalid-server'
  /** navigator.onLine is false. */
  | 'offline'
  /** None of the public relay servers could be reached. */
  | 'no-relay'
  /** Own server: nothing answered at the address. */
  | 'unreachable'
  /** Own server: something answered, but not a Freilauf signalling server. */
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

/** The group-ride part of the settings (Settings → Group). */
export interface GroupSettings {
  useOwnServer: boolean;
  signallingUrl: string;
  relayUrls: readonly string[];
}

/** Where a new ride is opened. */
export type HostTarget =
  | { transport: 'relays'; relayUrls: readonly string[] }
  | { transport: 'self-hosted'; signallingUrl: string };

/** Where a pasted invite points to. `input` is the bare link, without surrounding text. */
export type JoinTarget =
  | {
      transport: 'relays';
      roomCode: string;
      secret: string;
      relayUrls: readonly string[];
      input: string;
    }
  | {
      transport: 'self-hosted';
      roomCode: string;
      /** The server the room lives on. */
      signallingUrl: string;
      /** True when the server came from the invite link rather than this app's settings. */
      fromLink: boolean;
      input: string;
    };

function ownServer(settings: GroupSettings): string {
  const kind = signallingUrlKind(settings.signallingUrl);
  if (kind === 'none') throw new GroupSetupError('no-server', 'No own server address is set.');
  if (kind === 'invalid') {
    throw new GroupSetupError('invalid-server', 'The configured server address is not valid.');
  }
  return settings.signallingUrl.trim();
}

/** The default: public relays. Own server when switched on in Settings → Group. */
export function resolveHostTarget(settings: GroupSettings): HostTarget {
  if (settings.useOwnServer)
    return { transport: 'self-hosted', signallingUrl: ownServer(settings) };
  return { transport: 'relays', relayUrls: settings.relayUrls };
}

/**
 * Where a pasted invite points to. Accepts the link on its own or inside a
 * longer message ("Ride with me: freilauf://join/…"), the full invite code, or
 * a bare room code. Throws a `GroupSetupError` when it cannot work.
 */
export function resolveJoinTarget(input: string, settings: GroupSettings): JoinTarget {
  const text = input.trim();
  const embedded = /freilauf:\/\/join\/[^\s<>"']+/i.exec(text)?.[0];
  const candidate = embedded ?? text;
  const parsed = parseInvite(candidate);
  if (!parsed.ok) {
    if (parsed.reason === 'typo') {
      throw new GroupSetupError('invite-typo', 'The invite failed its check symbol.');
    }
    throw new GroupSetupError(
      'invalid-invite',
      'Neither an invite link nor a room code was found in the input.',
    );
  }
  const { roomCode, secret, signallingUrl } = parsed.invite;
  // An old-style link names the server its ride lives on.
  if (signallingUrl) {
    return { transport: 'self-hosted', roomCode, signallingUrl, fromLink: true, input: candidate };
  }
  if (secret) {
    return {
      transport: 'relays',
      roomCode,
      secret,
      relayUrls: settings.relayUrls,
      input: candidate,
    };
  }
  if (settings.useOwnServer) {
    return {
      transport: 'self-hosted',
      roomCode,
      signallingUrl: ownServer(settings),
      fromLink: false,
      input: candidate,
    };
  }
  throw new GroupSetupError('secret-missing', 'A bare room code has no secret.');
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
  if (code === 'invalid-secret') return 'invite-typo';
  if (ctx.online === false) return 'offline';
  if (code === 'no-relay') return 'no-relay';
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
        title: 'No server address entered',
        message:
          '“Use my own signalling server” is switched on in Settings → Group, but no address is set.',
        next: 'Enter your server address there, or switch the option off to ride without any setup.',
      };
    case 'secret-missing':
      return {
        kind,
        title: 'This code is missing its secret part',
        message:
          'A six-character room code alone cannot open a ride: the invite also carries a secret that keeps the connection handshake private.',
        next: 'Ask your friend for the whole invite link (it starts with freilauf://join/) or the full invite code, such as ABC-DEF-GHJK-MNPQ-RSTU, and paste that.',
      };
    case 'invite-typo':
      return {
        kind,
        title: 'The invite has a typo',
        message: 'This looks like an invite, but a character is wrong, missing or extra.',
        next: 'Copy the invite link again, or compare the code character by character.',
      };
    case 'no-relay':
      return {
        kind,
        title: 'No relay server reachable',
        message:
          'To find each other, Freilauf apps use public relay servers run by others. None of them answered from this network.',
        next: `Check your internet connection and try again. Some company, school or public networks block these servers — another network (home Wi-Fi, a phone hotspot) usually works. ${LOG_HINT}`,
      };
    case 'invalid-invite':
      return {
        kind,
        title: 'That is not an invite',
        message: 'No invite link or code was found in what you entered.',
        next: 'Paste the invite link your friend sent (it starts with freilauf://join/), or the full invite code such as ABC-DEF-GHJK-MNPQ-RSTU.',
      };
    case 'invalid-server':
      return {
        kind,
        title: 'The server address is not valid',
        message: 'A server address starts with wss:// (or ws://), e.g. wss://example.org/signal.',
        next: 'Correct it in Settings → Group (advanced), switch “Use my own signalling server” off, or ask the host for a new invite link.',
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
        title: 'Your signalling server is not reachable',
        message: `Nothing answered at ${server}. The server may be switched off, the address may be mistyped, or it may not be reachable from this network.`,
        next: asHost
          ? 'Check that your server is running and that the address is right — “Test connection” under “Group ride” on the start screen checks it. A server on a home network needs a reverse proxy to be reachable from outside.'
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
        message: `The ride already has ${MAX_RIDERS_PER_GROUP} riders, the most a group ride supports.`,
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
  transport: 'relays' | 'self-hosted' = 'relays',
): {
  title: string;
  message: string;
} {
  if (role === 'host') {
    return {
      title: 'Waiting for friends',
      message:
        'Send them the invite link. They paste it under “Group ride” on their start screen — nothing to set up.',
    };
  }
  if (transport === 'relays') {
    return {
      title: 'Nobody else is here yet',
      message:
        'If your friend should already be riding, check that you used the invite from their current ride — every new ride has a new link. It can also take a few seconds for riders to find each other.',
    };
  }
  return {
    title: 'Nobody else is here yet',
    message: `If your friend should already be riding, check the code (${formatRoomCode(roomCode)}): on your own server a wrong code simply opens a new, empty room. With a code alone you also need the same server as the host — the invite link takes care of both.`,
  };
}

/** Explains a rider who is in the room but cannot be reached directly. */
export const PEER_TROUBLE_HINT =
  'You are both in the room, but your computers cannot connect to each other directly. This usually means a restrictive network (some mobile, company or university networks). Freilauf keeps trying; switching one of you to another network, e.g. home Wi-Fi instead of a phone hotspot, usually helps.';

/** What a relay ride's connection to the relays looks like (Group tab). */
export type RelayLinkState = 'connecting' | 'ready' | 'reconnecting';

export function relayStateFrom(state: string): RelayLinkState {
  if (state === 'joined') return 'ready';
  if (state === 'reconnecting') return 'reconnecting';
  return 'connecting';
}

export const RELAY_STATE_TEXT: Record<RelayLinkState, string> = {
  connecting: 'Looking for the relay servers…',
  ready: 'Ready: friends with the invite can find you.',
  reconnecting:
    'Lost the relay servers, trying again. Riders already connected keep riding; nobody new can join until one is back.',
};

/** Non-fatal trouble reported while in a ride (`GroupRide.getProblems()`). */
export type GroupNoteCode = 'secret-mismatch' | 'peer-unreachable' | 'room-full';

export interface GroupNote {
  code: GroupNoteCode;
  text: string;
}

const NOTE_TEXT: Record<GroupNoteCode, string> = {
  'secret-mismatch':
    'Someone tried to join with this ride’s code but a different secret, so they could not get in. If a friend is waiting, send them the whole invite link again.',
  'peer-unreachable':
    'A rider found this ride, but your computers could not connect directly. This usually means a restrictive network (some mobile, company or university networks); Freilauf has no relay for ride data. Switching one of you to another network usually helps.',
  'room-full': `A rider could not join: the ride already has ${MAX_RIDERS_PER_GROUP} riders.`,
};

export function groupNotes(codes: readonly string[]): GroupNote[] {
  const out: GroupNote[] = [];
  for (const code of ['peer-unreachable', 'secret-mismatch', 'room-full'] as const) {
    if (codes.includes(code)) out.push({ code, text: NOTE_TEXT[code] });
  }
  return out;
}

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
