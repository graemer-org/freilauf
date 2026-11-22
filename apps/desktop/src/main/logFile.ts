/**
 * The always-on diagnostic log file (`userData/logs/freilauf.log`), see
 * docs/diagnostics.md. No Electron imports (unit-tested in logFile.test.ts
 * with a temp dir).
 *
 * - append() only queues: lines are written asynchronously in batches, so
 *   logging never blocks the UI or the ride loop. flushSync() exists for quit
 *   and crash paths.
 * - Size-based rotation: freilauf.log → freilauf.1.log → … → freilauf.<keep>.log.
 * - Never throws: on a full disk or a locked file the lines are dropped and
 *   counted, and the count is written once writing works again.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LogContext, LogInfo, LogLevel } from '../shared/contract';
import type { LogEntry, Secrets } from '../renderer/core/logFormat';
import {
  formatLogLine,
  logFileNames,
  redactEntry,
  rotatedName,
  rotationPlan,
  shouldRotate,
  tailText,
} from '../renderer/core/logFormat';

export interface LogFileOptions {
  dir: string;
  baseName?: string;
  /** Rotate when the current file would grow beyond this. Default 2 MB. */
  maxBytes?: number;
  /** Rotated files kept besides the current one. Default 3. */
  keep?: number;
  /** Delay before queued lines are written. Default 250 ms. */
  flushMs?: number;
  /** Lines beyond this many queued bytes are dropped (and counted). Default 4 MB. */
  maxQueueBytes?: number;
}

const MAX_CHUNK_BYTES = 256 * 1024;
export const MAX_RECENT_BYTES = 1024 * 1024;

export class LogFile {
  readonly dir: string;
  readonly baseName: string;
  readonly filePath: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #flushMs: number;
  readonly #maxQueueBytes: number;

  #queue: string[] = [];
  #queueBytes = 0;
  /** Size of the current file; null = unknown (stat before the next write). */
  #size: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #draining: Promise<void> | null = null;
  #closed = false;
  #dropped = 0;
  #droppedUnreported = 0;
  #lastError: string | null = null;

  constructor(options: LogFileOptions) {
    this.dir = options.dir;
    this.baseName = options.baseName ?? 'freilauf.log';
    this.filePath = path.join(this.dir, this.baseName);
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.#keep = options.keep ?? 3;
    this.#flushMs = options.flushMs ?? 250;
    this.#maxQueueBytes = options.maxQueueBytes ?? 4 * 1024 * 1024;
  }

  /** Lines dropped since start (disk full, locked file, queue overflow). */
  get dropped(): number {
    return this.#dropped;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  /** Queues one line (without newline). Never throws, never blocks. */
  append(line: string): void {
    try {
      const text = `${line}\n`;
      if (this.#closed) {
        this.#appendSyncNow(text);
        return;
      }
      if (this.#queueBytes + text.length > this.#maxQueueBytes) {
        this.#drop(1, 'queue full');
        return;
      }
      this.#queue.push(text);
      this.#queueBytes += text.length;
      this.#timer ??= setTimeout(() => {
        this.#timer = null;
        void this.flush();
      }, this.#flushMs);
    } catch {
      this.#dropped++;
    }
  }

  /** Writes everything queued so far. Resolves when it is on disk (or dropped). */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#draining) await this.#draining;
    if (this.#queue.length === 0) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
    });
    await this.#draining;
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const { chunk, lines } = this.#takeChunk();
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        if (this.#size === null) this.#size = await statSize(this.filePath);
        const text = this.#droppedNotice() + chunk;
        const bytes = Buffer.byteLength(text);
        if (shouldRotate(this.#size, bytes, this.#maxBytes)) await this.#rotate();
        await fs.promises.appendFile(this.filePath, text, 'utf8');
        this.#size += bytes;
        this.#droppedUnreported = 0;
      } catch (e) {
        this.#size = null;
        this.#drop(lines, describe(e));
      }
    }
  }

  /** Synchronous: for quit and crash paths. Writes the queue (and waits for nothing). */
  flushSync(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#queue.length > 0) {
      const { chunk, lines } = this.#takeChunk();
      try {
        this.#writeSync(chunk);
      } catch (e) {
        this.#size = null;
        this.#drop(lines, describe(e));
      }
    }
  }

  /** Flushes synchronously; later lines are written synchronously one by one. */
  close(): void {
    this.flushSync();
    this.#closed = true;
  }

  #appendSyncNow(text: string): void {
    try {
      this.#writeSync(text);
    } catch (e) {
      this.#size = null;
      this.#drop(1, describe(e));
    }
  }

  #writeSync(chunk: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.#size === null) this.#size = statSizeSync(this.filePath);
    const text = this.#droppedNotice() + chunk;
    const bytes = Buffer.byteLength(text);
    if (shouldRotate(this.#size, bytes, this.#maxBytes)) this.#rotateSync();
    fs.appendFileSync(this.filePath, text, 'utf8');
    this.#size += bytes;
    this.#droppedUnreported = 0;
  }

  #takeChunk(): { chunk: string; lines: number } {
    let bytes = 0;
    let n = 0;
    while (
      n < this.#queue.length &&
      (n === 0 || bytes + this.#queue[n]!.length <= MAX_CHUNK_BYTES)
    ) {
      bytes += this.#queue[n]!.length;
      n++;
    }
    const lines = this.#queue.splice(0, n);
    this.#queueBytes -= bytes;
    return { chunk: lines.join(''), lines: n };
  }

  #drop(lines: number, reason: string): void {
    this.#dropped += lines;
    this.#droppedUnreported += lines;
    this.#lastError = reason;
  }

  #droppedNotice(): string {
    if (this.#droppedUnreported === 0) return '';
    return `${formatLogLine({
      time: Date.now(),
      level: 'warn',
      source: 'log',
      message: `${this.#droppedUnreported} log line(s) were dropped`,
      context: { reason: this.#lastError, droppedTotal: this.#dropped },
    })}\n`;
  }

  async #rotate(): Promise<void> {
    for (const step of rotationPlan(this.baseName, this.#keep)) {
      if (step.op === 'delete') {
        await fs.promises.rm(path.join(this.dir, step.name), { force: true });
      } else {
        await fs.promises
          .rename(path.join(this.dir, step.from), path.join(this.dir, step.to))
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') throw e;
          });
      }
    }
    this.#size = 0;
  }

  #rotateSync(): void {
    for (const step of rotationPlan(this.baseName, this.#keep)) {
      if (step.op === 'delete') {
        fs.rmSync(path.join(this.dir, step.name), { force: true });
      } else {
        try {
          fs.renameSync(path.join(this.dir, step.from), path.join(this.dir, step.to));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
    }
    this.#size = 0;
  }

  /** Current file first, then rotated ones newest to oldest; missing files are left out. */
  async info(): Promise<LogInfo> {
    await this.flush();
    const files: LogInfo['files'] = [];
    for (const name of logFileNames(this.baseName, this.#keep)) {
      try {
        const st = await fs.promises.stat(path.join(this.dir, name));
        files.push({ name, bytes: st.size });
      } catch {
        // not there
      }
    }
    return { directory: this.dir, files };
  }

  /** The last `maxBytes` of the log (current file, plus the previous one if needed). */
  async readRecent(maxBytes: number): Promise<string> {
    await this.flush();
    const limit = Math.max(0, Math.min(MAX_RECENT_BYTES, Math.floor(maxBytes)));
    if (limit === 0) return '';
    let text = await readOrEmpty(path.join(this.dir, this.baseName));
    if (text.length < limit) {
      text = (await readOrEmpty(path.join(this.dir, rotatedName(this.baseName, 1)))) + text;
    }
    return tailText(text, limit);
  }

  /** All files, oldest first and the current one last, each preceded by a marker line. */
  async readAll(): Promise<string> {
    await this.flush();
    const parts: string[] = [];
    for (const name of logFileNames(this.baseName, this.#keep).reverse()) {
      const text = await readOrEmpty(path.join(this.dir, name));
      if (!text) continue;
      parts.push(`----- ${name} -----\n${text.endsWith('\n') ? text : `${text}\n`}`);
    }
    return parts.join('');
  }
}

/**
 * Main-process front of the log: redacts, formats and queues entries; mirrors
 * info and above to the console (dev and `electron .` users see them as before).
 */
export class DiagnosticLog {
  readonly file: LogFile;
  #secrets: Secrets = {};
  readonly #console: boolean;

  constructor(file: LogFile, options: { console?: boolean } = {}) {
    this.file = file;
    this.#console = options.console ?? true;
  }

  setSecrets(secrets: Secrets): void {
    this.#secrets = { ...this.#secrets, ...secrets };
  }

  write(entry: LogEntry): void {
    try {
      const line = formatLogLine(redactEntry(entry, this.#secrets));
      this.file.append(line);
      if (this.#console && entry.level !== 'debug') {
        const out =
          entry.level === 'error'
            ? console.error
            : entry.level === 'warn'
              ? console.warn
              : console.log;
        out(`[freilauf] ${line.slice(25)}`);
      }
    } catch {
      // never throw into the app
    }
  }

  log(level: LogLevel, source: string, message: string, context?: LogContext): void {
    this.write({ time: Date.now(), level, source, message, context });
  }

  scope(source: string): MainLog {
    return {
      debug: (m, c) => this.log('debug', source, m, c),
      info: (m, c) => this.log('info', source, m, c),
      warn: (m, c) => this.log('warn', source, m, c),
      error: (m, c) => this.log('error', source, m, c),
    };
  }
}

export interface MainLog {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

async function statSize(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

function statSizeSync(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function describe(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  return err && typeof err === 'object' && err.code ? `${err.code}: ${err.message}` : String(e);
}
