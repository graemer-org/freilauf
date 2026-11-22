// Minimal ambient globals for this package's own typecheck. The package is
// compiled with `lib: ES2023` and `types: []` (no DOM, no Node), but every JS
// runtime we target provides `console`. This file is not imported anywhere, so
// consumers that do load DOM/Node typings never see a conflicting declaration.
declare var console: {
  error(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  log(...data: unknown[]): void;
};
