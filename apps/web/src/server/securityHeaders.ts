/**
 * HTTP security headers for the web build. The CSP matches the desktop
 * renderer's (apps/desktop/src/renderer/index.html): wss: is for group rides —
 * the public relay servers (any host: the relay list can be changed in
 * Settings) and an own signalling server on another host; ws: only for an own
 * server without TLS. https: is for loading route scenery from an Overpass server and the
 * weather of a day from a historical weather archive, which the rider asks for per route (the
 * endpoints can be changed in Settings, so any host; see docs/adr/0011-osm-scenery.md and
 * docs/adr/0012-historical-wind.md). No third-party scripts, nothing else connects.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

/** frame-ancestors only works as a header, not in a <meta> CSP. */
export const CONTENT_SECURITY_POLICY_HEADER = `${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`;

/** Web Bluetooth only for our own origin; powerful features we never use are off. */
export const PERMISSIONS_POLICY = [
  'bluetooth=(self)',
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
].join(', ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY_HEADER,
  'permissions-policy': PERMISSIONS_POLICY,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};
