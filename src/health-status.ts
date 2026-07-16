import fs from 'node:fs';

import type { ExternalHealthEvent } from 'claude-to-im/src/lib/bridge/host.js';
import { atomicWritePrivateFile } from './private-files.js';

interface ExternalHealthStatus {
  feishu?: {
    connection?: 'connected' | 'disconnected';
    lastConnectedAt?: string;
    lastDisconnectedAt?: string;
    lastAcceptedInboundAt?: string;
  };
  codex?: {
    lastSuccessAt?: string;
    lastErrorAt?: string;
  };
}
function readStatus(filePath: string): ExternalHealthStatus {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ExternalHealthStatus;
  } catch {
    return {};
  }
}

export function resetExternalHealthStatus(filePath: string): void {
  atomicWritePrivateFile(filePath, '{}');
}

export function createExternalHealthReporter(
  filePath: string,
  now: () => string = () => new Date().toISOString(),
): (event: ExternalHealthEvent) => void {
  return (event) => {
    const status = readStatus(filePath);
    const timestamp = now();
    if (event.component === 'feishu') {
      const feishu = status.feishu || {};
      if (event.state === 'connected') {
        feishu.connection = 'connected';
        feishu.lastConnectedAt = timestamp;
      } else if (event.state === 'disconnected') {
        feishu.connection = 'disconnected';
        feishu.lastDisconnectedAt = timestamp;
      } else {
        feishu.lastAcceptedInboundAt = timestamp;
      }
      status.feishu = feishu;
    } else {
      const codex = status.codex || {};
      if (event.state === 'success') codex.lastSuccessAt = timestamp;
      else codex.lastErrorAt = timestamp;
      status.codex = codex;
    }
    atomicWritePrivateFile(filePath, JSON.stringify(status, null, 2));
  };
}
