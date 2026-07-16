import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SKILL_DIR = path.resolve(import.meta.dirname, '../..');

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('persistent file permissions', () => {
  it('creates config and log files with private modes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-permissions-'));
    const ctiHome = path.join(home, 'named');
    try {
      const script = [
        "import { saveConfig } from './src/config.ts';",
        "saveConfig({runtime:'codex',enabledChannels:[],defaultWorkDir:'/tmp',defaultMode:'code'});",
        "const { setupLogger } = await import('./src/logger.ts');",
        'setupLogger();',
        "console.log('permission probe');",
        'await new Promise((resolve) => setTimeout(resolve, 50));',
      ].join(' ');
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: SKILL_DIR,
          env: { ...process.env, CTI_HOME: ctiHome, CTI_INSTANCE: 'quant-lab' },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(mode(ctiHome), 0o700);
      assert.equal(mode(path.join(ctiHome, 'config.env')), 0o600);
      assert.equal(mode(path.join(ctiHome, 'logs')), 0o700);
      assert.equal(mode(path.join(ctiHome, 'logs', 'bridge.log')), 0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('loads provider environment from config without allowing config to replace instance identity', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-env-'));
    const ctiHome = path.join(home, 'named');
    const providerKey = `provider-${crypto.randomUUID()}`;
    fs.mkdirSync(ctiHome, { recursive: true });
    fs.writeFileSync(
      path.join(ctiHome, 'config.env'),
      [
        'CTI_RUNTIME=codex',
        `OPENAI_API_KEY=${providerKey}`,
        'CTI_CODEX_BASE_URL=https://codex.invalid',
        'CTI_HOME=/tmp/identity-escape',
        'CTI_INSTANCE=default',
      ].join('\n'),
      { mode: 0o600 },
    );
    try {
      const script = [
        "const { loadConfig } = await import('./src/config.ts');",
        'loadConfig();',
        "process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY,base:process.env.CTI_CODEX_BASE_URL,home:process.env.CTI_HOME,instance:process.env.CTI_INSTANCE}));",
      ].join(' ');
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: SKILL_DIR,
          env: { ...process.env, CTI_HOME: ctiHome, CTI_INSTANCE: 'quant-lab' },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        key: providerKey,
        base: 'https://codex.invalid',
        home: ctiHome,
        instance: 'quant-lab',
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
