import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createExternalHealthReporter, resetExternalHealthStatus } from '../health-status.js';

describe('external health runtime state', () => {
  it('clears evidence inherited from a previous daemon run', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-health-reset-'));
    const healthPath = path.join(tmp, 'runtime', 'external-health.json');
    fs.mkdirSync(path.dirname(healthPath), { recursive: true });
    fs.writeFileSync(healthPath, JSON.stringify({
      feishu: { connection: 'connected', lastConnectedAt: '2025-01-01T00:00:00.000Z' },
      codex: { lastSuccessAt: '2025-01-01T00:00:01.000Z' },
    }));

    resetExternalHealthStatus(healthPath);

    assert.deepEqual(JSON.parse(fs.readFileSync(healthPath, 'utf8')), {});
    assert.equal(fs.statSync(healthPath).mode & 0o777, 0o600);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records only component state and fixture timestamps in a 0600 runtime file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-health-'));
    const healthPath = path.join(tmp, 'runtime', 'external-health.json');
    const times = [
      '2026-07-16T00:00:01.000Z',
      '2026-07-16T00:00:02.000Z',
      '2026-07-16T00:00:03.000Z',
      '2026-07-16T00:00:04.000Z',
      '2026-07-16T00:00:05.000Z',
    ];
    const canaries = ['secret_health_canary', 'user_health_canary', 'group_health_canary'];
    const report = createExternalHealthReporter(healthPath, () => times.shift()!);

    report({ component: 'feishu', state: 'connected' });
    report({ component: 'feishu', state: 'disconnected' });
    report({ component: 'feishu', state: 'accepted-inbound' });
    report({ component: 'codex', state: 'success' });
    report({ component: 'codex', state: 'error' });

    const raw = fs.readFileSync(healthPath, 'utf8');
    const status = JSON.parse(raw);
    assert.deepEqual(status, {
      feishu: {
        connection: 'disconnected',
        lastConnectedAt: '2026-07-16T00:00:01.000Z',
        lastDisconnectedAt: '2026-07-16T00:00:02.000Z',
        lastAcceptedInboundAt: '2026-07-16T00:00:03.000Z',
      },
      codex: {
        lastSuccessAt: '2026-07-16T00:00:04.000Z',
        lastErrorAt: '2026-07-16T00:00:05.000Z',
      },
    });
    assert.equal(fs.statSync(healthPath).mode & 0o777, 0o600);
    assert.doesNotMatch(raw, new RegExp(canaries.join('|')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
