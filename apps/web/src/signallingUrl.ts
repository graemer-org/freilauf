import { DEFAULT_SETTINGS } from '../../desktop/src/shared/contract';

/** The path the bundled server (src/server) serves the signalling WebSocket on. */
export const SIGNALLING_PATH = '/signal';

/**
 * Own-server address prefilled in the web build: the same origin the page came
 * from, at `/signal`, so a single published port (or reverse-proxy entry)
 * serves the app and the fallback signalling. `wss:` when the page is served
 * over HTTPS. Only used when "Use my own signalling server" is switched on;
 * group rides go over the public relays by default.
 */
export function defaultSignallingUrl(location: { protocol: string; host: string }): string {
  if (!location.host) return DEFAULT_SETTINGS.group.signallingUrl;
  if (location.protocol === 'https:') return `wss://${location.host}${SIGNALLING_PATH}`;
  if (location.protocol === 'http:') return `ws://${location.host}${SIGNALLING_PATH}`;
  return DEFAULT_SETTINGS.group.signallingUrl;
}
