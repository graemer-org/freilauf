import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { App, AppState } from '../appStore';

/**
 * Carries only the stable `App` object. High-frequency state is never put
 * in context; components subscribe to narrow slices with `useAppState`.
 */
export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp() outside <MainApp>');
  return app;
}

/**
 * Subscribes to a slice of the store. Selectors must return primitives or
 * references that already live in the state (no fresh objects/arrays),
 * otherwise every update re-renders.
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  return useStore(useApp().store, selector);
}

/** True when keyboard focus is somewhere text-like, where shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
