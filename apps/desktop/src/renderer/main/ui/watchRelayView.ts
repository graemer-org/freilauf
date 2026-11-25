/**
 * Words for "Share with my watch" (Devices screen, start screen, ride toolbar).
 * Pure; unit-tested in watchRelayView.test.ts.
 */
import type { RelayServiceKind } from '@freilauf/devices';
import type { WatchRelayStatus } from '../../../shared/contract';
import type { Tone } from './deviceStatus';

export const WATCH_RELAY_KINDS: readonly RelayServiceKind[] = [
  'heartRate',
  'power',
  'speedCadence',
  'trainer',
];

export const WATCH_RELAY_KIND_LABEL: Record<RelayServiceKind, string> = {
  heartRate: 'Heart rate',
  power: 'Power and cadence',
  speedCadence: 'Speed and distance',
  trainer: 'Smart trainer data (FTMS)',
};

export const WATCH_RELAY_KIND_HINT: Record<RelayServiceKind, string> = {
  heartRate: 'Appears as a heart-rate sensor. Sent only while a heart-rate strap is connected.',
  power: 'Appears as a power meter (with cadence).',
  speedCadence:
    'Appears as a bike speed and cadence sensor. Speed and distance are the ride’s virtual ones.',
  trainer:
    'Appears as a fitness machine. Off by default: most watches do not use it, and some apps would then try to control the trainer.',
};

/** What a watch lists the shared kinds as (for "look for … as …"). */
const SENSOR_NAME: Record<RelayServiceKind, string> = {
  heartRate: 'heart-rate sensor',
  power: 'power meter',
  speedCadence: 'bike sensor',
  trainer: 'fitness machine',
};

/** "a, b and c" */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export interface WatchRelayDescription {
  text: string;
  tone: Tone;
}

export function describeWatchRelay(status: WatchRelayStatus): WatchRelayDescription {
  switch (status.state) {
    case 'unavailable':
      return {
        text: `${status.browser ? 'Not available in the browser' : 'Not supported on this computer'} — ${status.reason}`,
        tone: 'off',
      };
    case 'off':
      return { text: 'Off', tone: 'off' };
    case 'starting':
      return { text: 'Starting…', tone: 'busy' };
    case 'unsupported':
      return { text: `Not supported on this computer — ${status.reason}`, tone: 'warn' };
    case 'sharing': {
      if (status.devices > 0) {
        return {
          text: `Connected: ${status.devices} ${status.devices === 1 ? 'device' : 'devices'}`,
          tone: 'ok',
        };
      }
      const as = listWords(status.sharing.map((k) => SENSOR_NAME[k]));
      const name = status.computerName ? ` (“${status.computerName}”)` : '';
      return {
        text: `Waiting for a watch — look for this PC’s Bluetooth name${name} as a ${as}`,
        tone: 'busy',
      };
    }
    case 'error':
      return {
        text: status.retrying ? `${status.message} Trying again…` : status.message,
        tone: 'warn',
      };
  }
}

/** The short badge next to the device chips; null when sharing is off or impossible. */
export function watchRelayBadge(
  status: WatchRelayStatus,
  enabled: boolean,
): WatchRelayDescription | null {
  if (!enabled || status.state === 'unavailable' || status.state === 'off') return null;
  switch (status.state) {
    case 'sharing':
      return status.devices > 0
        ? { text: `Watch: ${status.devices}`, tone: 'ok' }
        : { text: 'Watch: waiting', tone: 'busy' };
    case 'starting':
      return { text: 'Watch: starting', tone: 'busy' };
    case 'unsupported':
    case 'error':
      return { text: 'Watch: problem', tone: 'warn' };
  }
}
