/**
 * Renderer-side logger: redacts and forwards entries to
 * `FreilaufApi.diagnostics.log` (which batches them to the main process, or
 * keeps them in memory in the browser build). Never throws.
 */
import type { LogContext, LogLevel } from '../../shared/contract';
import type { Secrets } from './logFormat';
import { redactEntry } from './logFormat';

export interface ScopedLog {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export interface LogSink {
  log(level: LogLevel, source: string, message: string, context?: LogContext): void;
}

export const NULL_LOG: ScopedLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class Logger {
  readonly #sink: LogSink | null;
  #secrets: Secrets = {};

  constructor(sink: LogSink | null) {
    this.#sink = sink;
  }

  /** Rider name and room codes to mask (see logFormat.redact). */
  setSecrets(secrets: Secrets): void {
    this.#secrets = { ...this.#secrets, ...secrets };
  }

  log(level: LogLevel, source: string, message: string, context?: LogContext): void {
    if (!this.#sink) return;
    try {
      const e = redactEntry({ time: 0, level, source, message, context }, this.#secrets);
      if (e.context === undefined) this.#sink.log(level, source, e.message);
      else this.#sink.log(level, source, e.message, e.context);
    } catch {
      // Logging must never break the app.
    }
  }

  scope(source: string): ScopedLog {
    return {
      debug: (m, c) => this.log('debug', source, m, c),
      info: (m, c) => this.log('info', source, m, c),
      warn: (m, c) => this.log('warn', source, m, c),
      error: (m, c) => this.log('error', source, m, c),
    };
  }
}
