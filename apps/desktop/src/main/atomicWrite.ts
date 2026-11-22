/**
 * Atomic file writes: write a temp file in the same directory, fsync, rename
 * over the target. A crash mid-write leaves either the old or the new file,
 * never a truncated one. No Electron imports.
 *
 * On Windows `rename` over an existing file can fail transiently with
 * EPERM/EACCES/EBUSY while an antivirus scanner or the search indexer holds the
 * target open, so the rename is retried a few times.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRIES = 5;

let counter = 0;
function tempPath(target: string): string {
  counter = (counter + 1) % 1_000_000;
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${counter}.tmp`,
  );
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomicSync(target: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tempPath(target);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, target);
        return;
      } catch (e) {
        if (attempt >= RETRIES || !RETRY_CODES.has(errCode(e) ?? '')) throw e;
        sleepSync(20 * (attempt + 1));
      }
    }
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}

export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = tempPath(target);
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, target);
        return;
      } catch (e) {
        if (attempt >= RETRIES || !RETRY_CODES.has(errCode(e) ?? '')) throw e;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
