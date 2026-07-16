import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from './config.js';
import {
  ensurePrivateDirectory,
  preparePrivateAppendFile,
  PRIVATE_FILE_MODE,
} from './private-files.js';
import crypto from 'node:crypto';

const MASK_PATTERNS: RegExp[] = [
  /(?:token|secret|password|api_key)["']?\s*[:=]\s*["']?([^\s"',]+)/gi,
  /bot\d+:[A-Za-z0-9_-]{35}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

export function maskSecrets(text: string): string {
  let result = text;
  for (const pattern of MASK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      if (match.length <= 4) return match;
      return '*'.repeat(match.length - 4) + match.slice(-4);
    });
  }
  return result;
}

export interface SensitiveLogValues {
  secrets?: Array<string | undefined>;
  identifiers?: Array<string | undefined>;
}

export function redactSensitiveValues(text: string, values: SensitiveLogValues = {}): string {
  let result = text;
  const secrets = [...new Set((values.secrets || []).filter((value): value is string => Boolean(value)))]
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    result = result.split(secret).join('[REDACTED]');
  }

  const identifiers = [...new Set((values.identifiers || []).filter((value): value is string => Boolean(value)))]
    .sort((a, b) => b.length - a.length);
  for (const identifier of identifiers) {
    const ref = crypto.createHash('sha256').update(identifier).digest('hex').slice(0, 12);
    result = result.split(identifier).join(`ref=${ref}`);
  }
  return result;
}

export function classifyConsoleErrorLevel(args: unknown[]): 'WARN' | 'ERROR' {
  const text = args.filter((value): value is string => typeof value === 'string').join(' ');
  return /^\(node:\d+\) \[DEP\d+\] DeprecationWarning:/.test(text) ? 'WARN' : 'ERROR';
}

const LOG_DIR = path.join(CTI_HOME, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED = 3;

let logStream: fs.WriteStream | null = null;

function openLogStream(): fs.WriteStream {
  preparePrivateAppendFile(LOG_PATH);
  return fs.createWriteStream(LOG_PATH, { flags: 'a', mode: PRIVATE_FILE_MODE });
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return; // file doesn't exist yet
  }

  // Close current stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  // Rotate: delete .3, shift .2→.3, .1→.2, current→.1
  const path3 = `${LOG_PATH}.${MAX_ROTATED}`;
  if (fs.existsSync(path3)) fs.unlinkSync(path3);

  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    const src = `${LOG_PATH}.${i}`;
    const dst = `${LOG_PATH}.${i + 1}`;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }

  fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  fs.chmodSync(`${LOG_PATH}.1`, PRIVATE_FILE_MODE);
  logStream = openLogStream();
}

export function setupLogger(sensitiveValues: SensitiveLogValues = {}): void {
  ensurePrivateDirectory(LOG_DIR);
  logStream = openLogStream();

  const write = (level: string, args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const formatted = `[${timestamp}] [${level}] ${message}`;
    const masked = maskSecrets(redactSensitiveValues(formatted, sensitiveValues));

    rotateIfNeeded();
    logStream?.write(masked + '\n');
  };

  console.log = (...args: unknown[]) => write('INFO', args);
  console.error = (...args: unknown[]) => write(classifyConsoleErrorLevel(args), args);
  console.warn = (...args: unknown[]) => write('WARN', args);
}
