import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeFailureSummary, type FailureKind } from '../failure-sanitizer.js';
import { atomicWritePrivateFile } from '../private-files.js';

const SKILL_DIR = path.resolve(import.meta.dirname, '../..');

function persistentFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  };
  visit(root);
  return result;
}

describe('process failure persistence', () => {
  for (const kind of ['unhandledRejection', 'uncaughtException', 'fatal'] as FailureKind[]) {
    it(`never persists or displays the raw ${kind} error`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-failure-'));
      const ctiHome = path.join(home, '.claude-to-im-quant-lab');
      const canary = `exact-${crypto.randomUUID()}`;
      try {
        fs.mkdirSync(path.join(ctiHome, 'runtime'), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(ctiHome, 'logs'), { recursive: true, mode: 0o700 });
        atomicWritePrivateFile(path.join(ctiHome, '.cti-instance-owner'), 'quant-lab\n');
        const summary = safeFailureSummary(kind, new Error(canary));
        atomicWritePrivateFile(
          path.join(ctiHome, 'runtime', 'status.json'),
          JSON.stringify({ running: false, lastExitReason: summary }),
        );
        atomicWritePrivateFile(path.join(ctiHome, 'logs', 'bridge.log'), summary);

        const binDir = path.join(home, 'bin');
        fs.mkdirSync(binDir);
        fs.writeFileSync(path.join(binDir, 'launchctl'), '#!/usr/bin/env bash\nexit 1\n', {
          mode: 0o700,
        });
        const status = execFileSync('/bin/bash', [path.join(SKILL_DIR, 'scripts/daemon.sh'), 'status'], {
          env: {
            ...process.env,
            HOME: home,
            PATH: `${binDir}:${process.env.PATH}`,
            CTI_INSTANCE: 'quant-lab',
            CTI_HOME: ctiHome,
          },
          encoding: 'utf8',
        });
        assert.doesNotMatch(summary, new RegExp(canary));
        assert.doesNotMatch(status, new RegExp(canary));
        for (const filePath of persistentFiles(ctiHome)) {
          assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), new RegExp(canary), filePath);
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
