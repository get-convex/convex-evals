import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import type { LockFileStatus } from './types.js';
import { getLockFilePath } from './guidelineStore.js';

export function readLockFile(provider: string, model: string): LockFileStatus | null {
  const path = getLockFilePath(provider, model);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeLockFile(provider: string, model: string, status: LockFileStatus): void {
  const path = getLockFilePath(provider, model);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(path, JSON.stringify(status, null, 2), 'utf-8');
}

export function deleteLockFile(provider: string, model: string): void {
  const path = getLockFilePath(provider, model);
  if (existsSync(path)) unlinkSync(path);
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
