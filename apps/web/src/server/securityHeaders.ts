/**
 * HTTP security headers for the web build. The CSP matches the desktop
 * renderer's (apps/desktop/src/renderer/index.html): ws:/wss: are for the
 * group-ride signalling server, which may live on another host.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
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
