import type { FreilaufApi } from '../shared/contract';

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts in both windows. */
    freilauf: FreilaufApi;
  }
}

export {};
