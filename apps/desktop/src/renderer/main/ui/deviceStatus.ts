import type { ConnectionState, DeviceKind } from '@freilauf/devices';

export const DEVICE_KINDS: readonly DeviceKind[] = ['trainer', 'heartRate', 'controller'];

export const DEVICE_LABEL: Record<DeviceKind, string> = {
  trainer: 'Trainer',
  heartRate: 'Heart rate',
  controller: 'Controller',
};

export type Tone = 'ok' | 'busy' | 'warn' | 'off';

export interface DeviceDescription {
  text: string;
  tone: Tone;
}

/** Human status of one device slot, shared by the header chips and the Devices tab. */
export function describeDevice(
  state: ConnectionState | null,
  remembered: boolean,
  busy: 'pairing' | 'searching' | undefined,
): DeviceDescription {
  if (busy === 'pairing') return { text: 'pairing…', tone: 'busy' };
  if (busy === 'searching') return { text: 'searching…', tone: 'busy' };
  switch (state) {
    case 'connected':
      return { text: 'connected', tone: 'ok' };
    case 'connecting':
      return { text: 'connecting', tone: 'busy' };
    case 'reconnecting':
      return { text: 'reconnecting…', tone: 'warn' };
    case 'disconnected':
      return { text: 'disconnected', tone: 'warn' };
    case null:
      return remembered ? { text: 'not found', tone: 'warn' } : { text: 'not paired', tone: 'off' };
  }
}
