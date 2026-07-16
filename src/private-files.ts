import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
}

export function atomicWritePrivateFile(filePath: string, data: string): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    fs.chmodSync(tmpPath, PRIVATE_FILE_MODE);
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Rename removes the temporary path; cleanup is only for failed writes.
    }
  }
}

export function preparePrivateAppendFile(filePath: string): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const fd = fs.openSync(filePath, 'a', PRIVATE_FILE_MODE);
  try {
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
}
