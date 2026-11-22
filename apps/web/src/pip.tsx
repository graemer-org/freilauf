/**
 * The web substitute for the desktop overlay: a Document Picture-in-Picture
 * window (Chromium only) with the same overlay tiles. It is a small
 * always-on-top window — NOT transparent and NOT click-through like the
 * desktop overlay; a web page cannot create one of those.
 *
 * The PiP document shares this page's JS realm, so it renders straight from
 * the App's store: no messaging needed.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeviceKind } from '@freilauf/devices';
import type { App } from '../../desktop/src/renderer/main/appStore';
import { OverlayView } from '../../desktop/src/renderer/overlay/ui/OverlayView';
import type { Bounds } from '../../desktop/src/shared/contract';
import { DEFAULT_SETTINGS } from '../../desktop/src/shared/contract';
import overlayCss from '../../desktop/src/renderer/overlay/ui/overlay.css?inline';
import { DEFAULT_PIP_BOUNDS, type OverlayWindowHost } from './browserApi';

/** `window.documentPictureInPicture` (not in TypeScript's DOM lib yet). */
export interface DocumentPictureInPictureLike {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

export function getDocumentPictureInPicture(): DocumentPictureInPictureLike | null {
  const pip = (globalThis as { documentPictureInPicture?: DocumentPictureInPictureLike })
    .documentPictureInPicture;
  return pip && typeof pip.requestWindow === 'function' ? pip : null;
}

// The desktop overlay is transparent over video; a PiP window has nothing
// behind it, so give it a dark backdrop.
const PIP_CSS = `${overlayCss}
html, body, #root { background: #0f1216; }`;

function PipOverlay({ app }: { app: App }) {
  const state = useSyncExternalStore(app.store.subscribe, app.store.getState);
  const live = state.live;
  const settings = state.settings?.overlay ?? DEFAULT_SETTINGS.overlay;
  const [everConnected, setEverConnected] = useState<ReadonlySet<DeviceKind>>(() => new Set());
  useEffect(() => {
    if (!live) return;
    setEverConnected((prev) => {
      let next: Set<DeviceKind> | null = null;
      for (const [kind, status] of Object.entries(live.devices) as [
        DeviceKind,
        (typeof live.devices)[DeviceKind],
      ][]) {
        if (status?.state === 'connected' && !prev.has(kind)) {
          next ??= new Set(prev);
          next.add(kind);
        }
      }
      return next ?? prev;
    });
  }, [live]);
  return (
    <OverlayView live={live} settings={settings} editMode={false} everConnected={everConnected} />
  );
}

export class StatsPipWindow implements OverlayWindowHost {
  readonly #pip: DocumentPictureInPictureLike | null;
  readonly #listeners = new Set<() => void>();
  #app: App | null = null;
  #window: Window | null = null;
  #root: Root | null = null;

  constructor(pip: DocumentPictureInPictureLike | null = getDocumentPictureInPicture()) {
    this.#pip = pip;
  }

  get supported(): boolean {
    return this.#pip !== null;
  }

  get isOpen(): boolean {
    return this.#window !== null;
  }

  attach(app: App): void {
    this.#app = app;
  }

  /** For useSyncExternalStore: fires when the window opens or closes. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Must be called from a click handler (the browser requires a user gesture). */
  async open(): Promise<void> {
    const app = this.#app;
    if (!this.#pip || !app || this.#window) return;
    const saved = app.store.getState().settings?.overlay.bounds ?? DEFAULT_PIP_BOUNDS;
    const win = await this.#pip.requestWindow({ width: saved.width, height: saved.height });
    const doc = win.document;
    doc.title = 'Freilauf stats';
    const style = doc.createElement('style');
    style.textContent = PIP_CSS;
    doc.head.append(style);
    const container = doc.createElement('div');
    container.id = 'root';
    doc.body.append(container);
    this.#window = win;
    this.#root = createRoot(container);
    this.#root.render(<PipOverlay app={app} />);
    win.addEventListener('pagehide', () => this.#onClosed(win), { once: true });
    this.#emit();
  }

  close(): void {
    this.#window?.close();
  }

  bounds(): Bounds | null {
    const win = this.#window;
    if (!win) return null;
    return { x: win.screenX, y: win.screenY, width: win.innerWidth, height: win.innerHeight };
  }

  resize(bounds: Bounds): void {
    try {
      this.#window?.resizeTo(bounds.width, bounds.height);
    } catch {
      // PiP windows only resize on a user gesture; ignore otherwise.
    }
  }

  #onClosed(win: Window): void {
    if (this.#window !== win) return;
    // Remember the size the user dragged it to for next time.
    const size = { width: win.innerWidth, height: win.innerHeight };
    this.#root?.unmount();
    this.#root = null;
    this.#window = null;
    if (size.width > 0 && size.height > 0) {
      void this.#app?.updateSettings({
        overlay: { bounds: { x: win.screenX, y: win.screenY, ...size } },
      });
    }
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
