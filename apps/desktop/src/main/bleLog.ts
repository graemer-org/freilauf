/**
 * BLE diagnostics log (`userData/logs/ble.log`), only written when the app was
 * started with FREILAUF_BLE_LOG=1. No Electron imports.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINE = 4000;

export class BleLog {
  readonly enabled: boolean;
  readonly filePath: string;
  private stream: fs.WriteStream | null = null;

  constructor(filePath: string, enabled: boolean) {
    this.filePath = filePath;
    this.enabled = enabled;
  }

  write(line: string): void {
    if (!this.enabled) return;
    if (!this.stream) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
      this.stream.on('error', (e) => {
        console.warn(`[ble-log] ${String(e)}`);
      });
    }
    const text = String(line)
      .replace(/[\r\n]+/g, ' ⏎ ')
      .slice(0, MAX_LINE);
    this.stream.write(`${new Date().toISOString()} ${text}\n`);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
