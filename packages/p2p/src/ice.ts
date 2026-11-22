/** ICE configuration shared by both transports. */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Public STUN only. Symmetric NATs need TURN; see docs/p2p.md. */
export const DEFAULT_ICE_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
