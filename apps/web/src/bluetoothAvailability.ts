/**
 * Why Web Bluetooth is (not) usable on this page, and what the user can do.
 * Pure: the environment is passed in, so the message selection is unit-tested.
 */

export type BluetoothUnavailableReason =
  'insecure-context' | 'unsupported-browser' | 'disabled-in-browser' | 'no-adapter';

export type BluetoothAvailability =
  | { available: true }
  | {
      available: false;
      reason: BluetoothUnavailableReason;
      title: string;
      message: string;
    };

export interface BluetoothEnvironment {
  /** `'bluetooth' in navigator` */
  hasBluetoothApi: boolean;
  /** `window.isSecureContext` */
  isSecureContext: boolean;
  /** `location.protocol`, e.g. `http:` */
  protocol: string;
  /** `location.host`, e.g. `nas.local:8080` */
  host: string;
  userAgent: string;
  /** `navigator.brave` exists (Brave ships Web Bluetooth disabled behind a flag). */
  isBrave?: boolean;
  /** Result of `navigator.bluetooth.getAvailability()`, if known. */
  adapterAvailable?: boolean;
}

const SIM_HINT = 'You can still try the app with simulated devices: add ?sim=1 to the address.';

function browserName(ua: string): 'firefox' | 'safari' | 'ios' | 'samsung' | 'other' {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'ios';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'firefox';
  if (/\bSamsungBrowser\//.test(ua)) return 'samsung';
  if (/\bSafari\//.test(ua) && !/\b(Chrome|Chromium|CriOS|Edg|OPR)\//.test(ua)) return 'safari';
  return 'other';
}

export function bluetoothAvailability(env: BluetoothEnvironment): BluetoothAvailability {
  // Chromium hides navigator.bluetooth entirely outside a secure context, so
  // check this first: it is by far the most common cause on a NAS.
  if (!env.isSecureContext) {
    return {
      available: false,
      reason: 'insecure-context',
      title: 'Bluetooth needs HTTPS',
      message:
        `This page was opened over ${env.protocol}//${env.host}, which browsers treat as insecure, ` +
        'so they disable Bluetooth. Open Freilauf over HTTPS (for example through your NAS’s ' +
        'reverse proxy with a certificate), or as http://localhost on the computer running the ' +
        `container. ${SIM_HINT}`,
    };
  }
  if (!env.hasBluetoothApi) {
    if (env.isBrave) {
      return {
        available: false,
        reason: 'disabled-in-browser',
        title: 'Bluetooth is turned off in Brave',
        message:
          'Brave ships Web Bluetooth disabled. Enable it at brave://flags/#brave-web-bluetooth-api ' +
          `and restart Brave, or use Chrome or Edge. ${SIM_HINT}`,
      };
    }
    const browser = browserName(env.userAgent);
    const which =
      browser === 'firefox'
        ? 'Firefox does not support Web Bluetooth.'
        : browser === 'safari'
          ? 'Safari does not support Web Bluetooth.'
          : browser === 'ios'
            ? 'Browsers on iPhone and iPad do not support Web Bluetooth.'
            : 'This browser does not offer Web Bluetooth.';
    return {
      available: false,
      reason: 'unsupported-browser',
      title: 'This browser cannot use Bluetooth',
      message:
        `${which} Open Freilauf in Chrome or Edge on Windows, macOS, Linux, ChromeOS or Android ` +
        `(on Linux, Chrome may need chrome://flags/#enable-experimental-web-platform-features). ${SIM_HINT}`,
    };
  }
  if (env.adapterAvailable === false) {
    return {
      available: false,
      reason: 'no-adapter',
      title: 'No Bluetooth adapter found',
      message:
        'The browser reports no usable Bluetooth adapter on this computer. Turn Bluetooth on in the ' +
        `operating system (and allow the browser to use it), then reload. ${SIM_HINT}`,
    };
  }
  return { available: true };
}
