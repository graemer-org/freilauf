// This package has no DOM/Node typings; every runtime we target has console.
declare const console: { error(...data: unknown[]): void };

export type Unsubscribe = () => void;
export type Listener<T> = (value: T) => void;

export interface Emitter<T> {
  on(listener: Listener<T>): Unsubscribe;
  emit(value: T): void;
  clear(): void;
}

/** Minimal typed event emitter. A throwing listener does not stop the others. */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<Listener<T>>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value) {
      for (const l of [...listeners]) {
        try {
          l(value);
        } catch (err) {
          console.error('listener failed', err);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
