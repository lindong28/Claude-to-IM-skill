import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SKILL_DIR = path.resolve(import.meta.dirname, '../..');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const MACOS_LAUNCHD_SKIP_REASON = 'requires macOS launchd and plutil semantics';

function shell(command: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('/bin/bash', ['-c', command], {
    cwd: SKILL_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('instance-aware macOS lifecycle scripts', {
  skip: process.platform === 'darwin' ? false : MACOS_LAUNCHD_SKIP_REASON,
}, () => {
  let home: string;
  let binDir: string;
  let launchctlLog: string;
  let env: NodeJS.ProcessEnv;
  let childProcesses: Set<ChildProcess>;

  beforeEach(() => {
    childProcesses = new Set();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cti-instance-')));
    binDir = path.join(home, 'bin');
    launchctlLog = path.join(home, 'launchctl.log');
    fs.mkdirSync(binDir, { recursive: true });
    const launchctl = path.join(binDir, 'launchctl');
    fs.writeFileSync(
      launchctl,
      '#!/usr/bin/env bash\n' +
        'printf "%s\\n" "$*" >> "${CTI_TEST_LAUNCHCTL_LOG}"\n' +
        'state="$HOME/.cti-test-launchctl-managed"\n' +
        'delay="$HOME/.cti-test-launchctl-delay"\n' +
        'case "${1:-}" in\n' +
        '  print) [ -f "$state" ] || exit 1; if [ -f "$delay" ]; then remaining=$(cat "$delay"); if [ "$remaining" -gt 0 ]; then printf "%s\\n" "$((remaining - 1))" > "$delay"; else rm -f "$delay" "$state"; exit 1; fi; fi; printf "pid = 4242\\n" ;;\n' +
        '  bootstrap) touch "$state"; [ -z "${CTI_TEST_BOOTSTRAP_WAIT:-}" ] || sleep "$CTI_TEST_BOOTSTRAP_WAIT"; if [ "${CTI_TEST_MUTATE_DEFAULT:-}" = 1 ]; then printf "mutated\\n" >> "$HOME/.claude-to-im/config.env"; fi ;;\n' +
        '  kickstart) mkdir -p "$CTI_HOME/runtime"; printf "4242" > "$CTI_HOME/runtime/bridge.pid"; printf "{\\"running\\":true}" > "$CTI_HOME/runtime/status.json" ;;\n' +
        '  bootout) if [ "${CTI_TEST_BOOTOUT_FAIL:-}" = 1 ]; then exit 5; fi; if [ -n "${CTI_TEST_BOOTOUT_DELAY_POLLS:-}" ]; then printf "%s\\n" "$CTI_TEST_BOOTOUT_DELAY_POLLS" > "$delay"; else rm -f "$state"; fi ;;\n' +
        'esac\n',
      { mode: 0o700 },
    );
    env = {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      CTI_TEST_LAUNCHCTL_LOG: launchctlLog,
      CTI_HOME: '',
      CTI_INSTANCE: '',
    };
  });

  afterEach(async () => {
    try {
      await Promise.all([...childProcesses].map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      })));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves default and named identities while preserving an explicit home', () => {
    const defaultOut = shell(
      'unset CTI_INSTANCE CTI_HOME; source scripts/instance-env.sh; printf "%s|%s|%s" "$CTI_INSTANCE" "$CTI_HOME" "$CTI_LAUNCHD_LABEL"',
      env,
    );
    assert.equal(defaultOut, `default|${home}/.claude-to-im|com.claude-to-im.bridge`);

    const namedOut = shell(
      'CTI_INSTANCE=quant-lab; unset CTI_HOME; source scripts/instance-env.sh; printf "%s|%s|%s" "$CTI_INSTANCE" "$CTI_HOME" "$CTI_LAUNCHD_LABEL"',
      env,
    );
    assert.equal(
      namedOut,
      `quant-lab|${home}/.claude-to-im-quant-lab|com.claude-to-im.bridge.quant-lab`,
    );

    const explicitHome = path.join(home, 'custom-home');
    const explicitOut = shell(
      'CTI_INSTANCE=quant-lab; source scripts/instance-env.sh; printf "%s|%s|%s" "$CTI_INSTANCE" "$CTI_HOME" "$CTI_LAUNCHD_LABEL"',
      { ...env, CTI_HOME: explicitHome },
    );
    assert.equal(explicitOut, `quant-lab|${explicitHome}|com.claude-to-im.bridge.quant-lab`);
  });

  it('rejects an invalid instance before filesystem or launchctl side effects', () => {
    const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'status'], {
      env: { ...process.env, ...env, CTI_INSTANCE: '../escape' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /invalid.*instance/i);
    assert.equal(fs.existsSync(launchctlLog), false);
    assert.equal(fs.existsSync(path.join(home, '.claude-to-im-../escape')), false);
  });

  it('rejects a named identity that aliases the default home', () => {
    const defaultHome = path.join(home, '.claude-to-im');
    fs.mkdirSync(defaultHome, { recursive: true });
    const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'status'], {
      env: {
        ...process.env,
        ...env,
        CTI_INSTANCE: 'quant-lab',
        CTI_HOME: defaultHome,
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /instance home.*default|default.*home/i);
    assert.equal(fs.existsSync(launchctlLog), false);
  });

  it('rejects relative, HOME, ancestor, and symlink-escaped explicit homes', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-outside-'));
    const link = path.join(home, 'escaped-home');
    fs.symlinkSync(path.dirname(home), link);
    try {
      for (const unsafeHome of ['relative-home', home, path.dirname(home), link]) {
        const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'status'], {
          env: {
            ...process.env,
            ...env,
            CTI_INSTANCE: 'quant-lab',
            CTI_HOME: unsafeHome,
          },
          encoding: 'utf8',
        });
        assert.notEqual(result.status, 0, unsafeHome);
      }
      const sentinel = path.join(home, 'home-sentinel');
      fs.writeFileSync(sentinel, 'keep');
      const removeHome = spawnSync(
        '/bin/bash',
        [path.join(SCRIPTS_DIR, 'daemon.sh'), 'remove', 'quant-lab'],
        {
          env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab', CTI_HOME: home },
          encoding: 'utf8',
        },
      );
      assert.notEqual(removeHome.status, 0);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');

      const safeCustom = shell(
        'source scripts/instance-env.sh; printf "%s" "$CTI_HOME"',
        { ...env, CTI_INSTANCE: 'custom', CTI_HOME: outside },
      );
      assert.equal(safeCustom, fs.realpathSync(outside));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('prevents two instance names from claiming or removing the same canonical home', () => {
    const sharedHome = path.join(home, 'shared-custom');
    fs.mkdirSync(sharedHome, { recursive: true });
    fs.writeFileSync(path.join(sharedHome, 'config.env'), 'CTI_RUNTIME=codex\n', { mode: 0o600 });
    const sentinel = path.join(sharedHome, 'alpha-sentinel');
    fs.writeFileSync(sentinel, 'keep');

    shell('bash scripts/daemon.sh start', { ...env, CTI_INSTANCE: 'alpha', CTI_HOME: sharedHome });
    shell('bash scripts/daemon.sh stop', { ...env, CTI_INSTANCE: 'alpha', CTI_HOME: sharedHome });
    const beta = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'remove', 'beta'], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'beta', CTI_HOME: sharedHome },
      encoding: 'utf8',
    });
    assert.notEqual(beta.status, 0);
    assert.match(`${beta.stdout}${beta.stderr}`, /owner|ownership/i);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  });

  it('generates isolated, secret-free plists and preserves proxy behavior', () => {
    const canaries = {
      CTI_FEISHU_APP_SECRET: `secret-${crypto.randomUUID()}`,
      CTI_FEISHU_ALLOWED_USERS: `user-${crypto.randomUUID()}`,
      CTI_FEISHU_GROUP_ALLOW_FROM: `group-${crypto.randomUUID()}`,
      OPENAI_API_KEY: `openai-${crypto.randomUUID()}`,
      ANTHROPIC_API_KEY: `anthropic-${crypto.randomUUID()}`,
    };
    const generate = [
      'source scripts/instance-env.sh',
      'SKILL_DIR="$PWD"',
      'PID_FILE="$CTI_HOME/runtime/bridge.pid"',
      'STATUS_FILE="$CTI_HOME/runtime/status.json"',
      'LOG_FILE="$CTI_HOME/logs/bridge.log"',
      'source scripts/supervisor-macos.sh',
      'generate_plist',
      'printf "%s" "$PLIST_FILE"',
    ].join('; ');

    const defaultPlistPath = shell(generate, {
      ...env,
      ...canaries,
      HTTP_PROXY: 'http://proxy.invalid:8080',
      NO_PROXY: 'host-a.invalid&host-b.invalid\\c-literal',
      CTI_ENV_ISOLATION: 'strict',
    });
    const namedPlistPath = shell(generate, {
      ...env,
      ...canaries,
      HTTP_PROXY: 'http://proxy.invalid:8080',
      NO_PROXY: 'host-a.invalid&host-b.invalid\\c-literal',
      CTI_ENV_ISOLATION: 'strict',
      CTI_INSTANCE: 'quant-lab',
    });

    assert.notEqual(defaultPlistPath, namedPlistPath);
    const defaultPlist = fs.readFileSync(defaultPlistPath, 'utf8');
    const namedPlist = fs.readFileSync(namedPlistPath, 'utf8');
    assert.match(defaultPlist, /com\.claude-to-im\.bridge/);
    assert.match(defaultPlist, new RegExp(`${escapeRegex(home)}/\\.claude-to-im/logs/bridge\\.log`));
    assert.match(namedPlist, /com\.claude-to-im\.bridge\.quant-lab/);
    assert.match(namedPlist, new RegExp(`${escapeRegex(home)}/\\.claude-to-im-quant-lab/logs/bridge\\.log`));
    assert.match(namedPlist, /<key>CTI_HOME<\/key>/);
    assert.match(namedPlist, /<key>CTI_INSTANCE<\/key>/);
    assert.match(namedPlist, /<key>HTTP_PROXY<\/key>/);
    assert.match(namedPlist, /host-a\.invalid&amp;host-b\.invalid/);
    assert.match(namedPlist, /\\c-literal/);
    assert.match(namedPlist, /<string>--use-env-proxy<\/string>/);
    assert.match(namedPlist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
    for (const [key, value] of Object.entries(canaries)) {
      assert.doesNotMatch(namedPlist, new RegExp(key));
      assert.doesNotMatch(namedPlist, new RegExp(value));
    }
    const ctiKeys = [...namedPlist.matchAll(/<key>(CTI_[A-Z0-9_]+)<\/key>/g)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(ctiKeys, ['CTI_HOME', 'CTI_INSTANCE']);
    assert.equal(mode(namedPlistPath), 0o600);
    execFileSync('/usr/bin/plutil', ['-lint', defaultPlistPath]);
    execFileSync('/usr/bin/plutil', ['-lint', namedPlistPath]);

    const lowercasePlistPath = shell(generate, {
      ...env,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: 'http://lowercase-proxy.invalid:8080',
      CTI_INSTANCE: 'lowercase',
    });
    const lowercasePlist = fs.readFileSync(lowercasePlistPath, 'utf8');
    assert.match(lowercasePlist, /<key>http_proxy<\/key>/);
    assert.match(lowercasePlist, /<string>--use-env-proxy<\/string>/);
  });

  it('rejects authenticated proxy URLs instead of persisting credentials in a plist', () => {
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    const plist = path.join(home, 'Library/LaunchAgents/com.claude-to-im.bridge.quant-lab.plist');
    const command = [
      'set -e',
      'source scripts/instance-env.sh',
      'SKILL_DIR="$PWD"',
      'PID_FILE="$CTI_HOME/runtime/bridge.pid"',
      'STATUS_FILE="$CTI_HOME/runtime/status.json"',
      'LOG_FILE="$CTI_HOME/logs/bridge.log"',
      'source scripts/supervisor-macos.sh',
      'generate_plist',
    ].join('; ');
    fs.mkdirSync(namedHome, { recursive: true });

    const result = spawnSync('/bin/bash', ['-c', command], {
      cwd: SKILL_DIR,
      env: {
        ...process.env,
        ...env,
        CTI_INSTANCE: 'quant-lab',
        HTTPS_PROXY: 'http://proxy-user:proxy-password@proxy.invalid:8080',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /authenticated proxy.*not supported/i);
    assert.equal(fs.existsSync(plist), false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /proxy-user|proxy-password/);
  });

  it('keeps status read-only, and reports the resolved identity', () => {
    const defaultHome = path.join(home, '.claude-to-im');
    const runtimeDir = path.join(defaultHome, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const stalePid = path.join(runtimeDir, 'bridge.pid');
    fs.writeFileSync(stalePid, '99999999');

    const output = shell('bash scripts/daemon.sh status', env);
    assert.match(output, /Instance:\s*default/);
    assert.match(output, new RegExp(`Home:\\s*${escapeRegex(defaultHome)}`));
    assert.match(output, /Label:\s*com\.claude-to-im\.bridge/);
    assert.equal(fs.existsSync(stalePid), true);
  });

  it('does not register or create runtime state when config is missing', () => {
    const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'start'], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /config.*missing/i);
    assert.equal(fs.existsSync(path.join(home, '.claude-to-im-quant-lab')), false);
    assert.equal(
      fs.existsSync(path.join(home, 'Library/LaunchAgents/com.claude-to-im.bridge.quant-lab.plist')),
      false,
    );
    assert.equal(fs.existsSync(launchctlLog), false);
  });

  it('rejects invalid Feishu or Codex policy before lifecycle or supervisor side effects', () => {
    const fixtures = [
      ['bad-policy', 'CTI_FEISHU_GROUP_POLICY=secret-invalid-policy-canary'],
      ['bad-boolean', 'CTI_FEISHU_GROUP_POLICY=allowlist\nCTI_FEISHU_REQUIRE_MENTION=secret-invalid-boolean-canary'],
      ['missing-group', 'CTI_FEISHU_GROUP_POLICY=allowlist\nCTI_FEISHU_REQUIRE_MENTION=true\nCTI_FEISHU_APP_ID=app\nCTI_FEISHU_APP_SECRET=secret\nCTI_FEISHU_ALLOWED_USERS=user'],
      ['bad-sandbox', 'CTI_CODEX_SANDBOX_MODE=secret-invalid-sandbox-canary'],
      ['bad-approval', 'CTI_CODEX_APPROVAL_POLICY=secret-invalid-approval-canary'],
      ['bad-network', 'CTI_CODEX_NETWORK_ACCESS=secret-invalid-network-canary'],
      ['missing-mention-fixed', [
        'CTI_FEISHU_APP_ID=app',
        'CTI_FEISHU_APP_SECRET=secret',
        'CTI_FEISHU_ALLOWED_USERS=user',
        'CTI_FEISHU_GROUP_POLICY=allowlist',
        'CTI_FEISHU_GROUP_ALLOW_FROM=group',
        'CTI_SESSION_POLICY=fixed-confirm-recovery',
      ].join('\n')],
      ['false-mention-fixed', [
        'CTI_FEISHU_APP_ID=app',
        'CTI_FEISHU_APP_SECRET=secret',
        'CTI_FEISHU_ALLOWED_USERS=user',
        'CTI_FEISHU_GROUP_POLICY=allowlist',
        'CTI_FEISHU_GROUP_ALLOW_FROM=group',
        'CTI_FEISHU_REQUIRE_MENTION=false',
        'CTI_SESSION_POLICY=fixed-confirm-recovery',
      ].join('\n')],
    ];
    for (const [instance, extra] of fixtures) {
      const namedHome = path.join(home, `.claude-to-im-${instance}`);
      fs.mkdirSync(namedHome, { recursive: true });
      fs.writeFileSync(
        path.join(namedHome, 'config.env'),
        `CTI_RUNTIME=codex\nCTI_ENABLED_CHANNELS=feishu\n${extra}\n`,
        { mode: 0o600 },
      );
      const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'start'], {
        env: { ...process.env, ...env, CTI_INSTANCE: instance },
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0, instance);
      assert.match(output, /configuration error/i, instance);
      assert.doesNotMatch(output, /secret-invalid-(?:policy|boolean|sandbox|approval|network)-canary/, instance);
      assert.deepEqual(fs.readdirSync(namedHome).sort(), ['config.env'], instance);
      assert.equal(fs.existsSync(path.join(namedHome, '.cti-instance-owner')), false, instance);
      assert.equal(fs.existsSync(path.join(namedHome, 'runtime')), false, instance);
      assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `com.claude-to-im.bridge.${instance}.plist`)), false, instance);
      assert.equal(fs.existsSync(launchctlLog), false, instance);
    }
  });

  it('enforces stop, uninstall, and remove ownership boundaries', () => {
    const defaultHome = path.join(home, '.claude-to-im');
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    const plistDir = path.join(home, 'Library', 'LaunchAgents');
    const defaultPlist = path.join(plistDir, 'com.claude-to-im.bridge.plist');
    const namedPlist = path.join(plistDir, 'com.claude-to-im.bridge.quant-lab.plist');
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.mkdirSync(namedHome, { recursive: true });
    fs.writeFileSync(path.join(namedHome, '.cti-instance-owner'), 'quant-lab\n', { mode: 0o600 });
    fs.mkdirSync(plistDir, { recursive: true });
    const defaultConfig = path.join(defaultHome, 'config.env');
    fs.writeFileSync(defaultConfig, 'CTI_RUNTIME=claude\n');
    fs.writeFileSync(defaultPlist, 'default plist');
    fs.writeFileSync(namedPlist, 'named plist');
    const defaultHash = fs.readFileSync(defaultConfig, 'utf8');

    shell('bash scripts/daemon.sh stop', { ...env, CTI_INSTANCE: 'quant-lab' });
    assert.equal(fs.existsSync(namedHome), true);
    assert.equal(fs.existsSync(namedPlist), true);

    shell('bash scripts/daemon.sh uninstall', { ...env, CTI_INSTANCE: 'quant-lab' });
    assert.equal(fs.existsSync(namedHome), true);
    assert.equal(fs.existsSync(namedPlist), false);

    const mismatch = spawnSync(
      '/bin/bash',
      [path.join(SCRIPTS_DIR, 'daemon.sh'), 'remove', 'wrong-name'],
      { env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' }, encoding: 'utf8' },
    );
    assert.notEqual(mismatch.status, 0);
    assert.equal(fs.existsSync(namedHome), true);

    shell('bash scripts/daemon.sh remove quant-lab', { ...env, CTI_INSTANCE: 'quant-lab' });
    assert.equal(fs.existsSync(namedHome), false);
    assert.equal(fs.existsSync(defaultHome), true);
    assert.equal(fs.existsSync(defaultPlist), true);
    assert.equal(fs.readFileSync(defaultConfig, 'utf8'), defaultHash);

    const defaultRemove = spawnSync(
      '/bin/bash',
      [path.join(SCRIPTS_DIR, 'daemon.sh'), 'remove', 'default'],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    assert.notEqual(defaultRemove.status, 0);
    assert.equal(fs.existsSync(defaultHome), true);
  });

  it('propagates a real bootout failure and preserves selected state', () => {
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    fs.mkdirSync(path.join(namedHome, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(namedHome, '.cti-instance-owner'), 'quant-lab\n', { mode: 0o600 });
    fs.writeFileSync(path.join(namedHome, 'runtime', 'bridge.pid'), '4242');
    const plist = path.join(home, 'Library/LaunchAgents/com.claude-to-im.bridge.quant-lab.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, 'keep');
    fs.writeFileSync(path.join(home, '.cti-test-launchctl-managed'), 'managed');

    const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'stop'], {
      env: {
        ...process.env,
        ...env,
        CTI_INSTANCE: 'quant-lab',
        CTI_TEST_BOOTOUT_FAIL: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(plist), true);
    assert.equal(fs.existsSync(path.join(namedHome, 'runtime', 'bridge.pid')), true);
  });

  it('waits for launchd to finish an asynchronous bootout', () => {
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    fs.mkdirSync(path.join(namedHome, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(namedHome, '.cti-instance-owner'), 'quant-lab\n', { mode: 0o600 });
    fs.writeFileSync(path.join(namedHome, 'runtime', 'bridge.pid'), '4242');
    fs.writeFileSync(path.join(home, '.cti-test-launchctl-managed'), 'managed');

    shell('bash scripts/daemon.sh stop', {
      ...env,
      CTI_INSTANCE: 'quant-lab',
      CTI_TEST_BOOTOUT_DELAY_POLLS: '2',
    });

    assert.equal(fs.existsSync(path.join(home, '.cti-test-launchctl-managed')), false);
    assert.equal(fs.existsSync(path.join(namedHome, 'runtime', 'bridge.pid')), false);
  });

  it('serializes lifecycle operations by canonical home', async () => {
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    fs.mkdirSync(namedHome, { recursive: true });
    fs.writeFileSync(path.join(namedHome, 'config.env'), 'CTI_RUNTIME=codex\n', { mode: 0o600 });
    const first = spawn('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'start'], {
      env: {
        ...process.env,
        ...env,
        CTI_INSTANCE: 'quant-lab',
        CTI_TEST_BOOTSTRAP_WAIT: '1',
      },
      stdio: 'ignore',
    });
    childProcesses.add(first);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'stop'], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    assert.notEqual(second.status, 0);
    assert.match(`${second.stdout}${second.stderr}`, /lifecycle.*lock|operation.*progress/i);
    await new Promise<void>((resolve, reject) => {
      first.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`first exit ${code}`)));
    });
    childProcesses.delete(first);
  });

  it('never follows a lifecycle-lock symlink swapped during stale repair', () => {
    const instance = 'quant-lab';
    const namedHome = path.join(home, `.claude-to-im-${instance}`);
    const lockRoot = path.join(home, '.claude-to-im-lifecycle-locks');
    const lockKey = crypto.createHash('sha256').update(namedHome).digest('hex');
    const lockPath = path.join(lockRoot, `${lockKey}.lock`);
    const victim = path.join(home, 'victim');
    const victimOwner = path.join(victim, 'owner');
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, 'owner'), `99999999\n${instance}\n`, { mode: 0o600 });
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(victimOwner, 'must-survive\n', { mode: 0o600 });

    fs.writeFileSync(
      path.join(binDir, 'rm'),
      '#!/usr/bin/env bash\n' +
        'if [ "${CTI_TEST_SWAP_ON_RM:-}" = 1 ]; then\n' +
        '  unset CTI_TEST_SWAP_ON_RM\n' +
        '  /bin/mv "$CTI_TEST_LOCK_PATH" "$CTI_TEST_LOCK_PATH.moved"\n' +
        '  /bin/ln -s "$CTI_TEST_VICTIM" "$CTI_TEST_LOCK_PATH"\n' +
        'fi\n' +
        'exec /bin/rm "$@"\n',
      { mode: 0o700 },
    );

    const result = spawnSync(
      '/bin/bash',
      [path.join(SCRIPTS_DIR, 'doctor.sh'), '--repair-stale-lock'],
      {
        env: {
          ...process.env,
          ...env,
          CTI_INSTANCE: instance,
          CTI_TEST_SWAP_ON_RM: '1',
          CTI_TEST_LOCK_PATH: lockPath,
          CTI_TEST_VICTIM: victim,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(victimOwner, 'utf8'), 'must-survive\n');
    assert.match(`${result.stdout}${result.stderr}`, /refus|changed|unsafe/i);
  });

  it('migrates existing named persistence permissions before registration', () => {
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    const dataDir = path.join(namedHome, 'data');
    const runtimeDir = path.join(namedHome, 'runtime');
    const logDir = path.join(namedHome, 'logs');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(logDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(namedHome, 0o755);
    fs.chmodSync(dataDir, 0o755);
    fs.writeFileSync(path.join(namedHome, 'config.env'), 'CTI_RUNTIME=codex\n', { mode: 0o644 });
    fs.writeFileSync(path.join(dataDir, 'legacy.json'), '{}', { mode: 0o644 });

    shell('bash scripts/daemon.sh start', { ...env, CTI_INSTANCE: 'quant-lab' });
    assert.equal(mode(namedHome), 0o700);
    assert.equal(mode(dataDir), 0o700);
    assert.equal(mode(path.join(namedHome, 'config.env')), 0o600);
    assert.equal(mode(path.join(dataDir, 'legacy.json')), 0o600);
  });

  it('fails a named operation if the default config changes concurrently', () => {
    const defaultHome = path.join(home, '.claude-to-im');
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.mkdirSync(namedHome, { recursive: true });
    fs.writeFileSync(path.join(defaultHome, 'config.env'), 'CTI_RUNTIME=claude\n');
    fs.writeFileSync(path.join(namedHome, 'config.env'), 'CTI_RUNTIME=codex\n');

    const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'daemon.sh'), 'start'], {
      env: {
        ...process.env,
        ...env,
        CTI_INSTANCE: 'quant-lab',
        CTI_TEST_MUTATE_DEFAULT: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /default instance config changed/i);
  });

  it('doctor reports and validates only the selected named persistence boundary', () => {
    const namedHome = path.join(home, '.claude-to-im-quant-lab');
    const secret = `secret-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    const groupId = `group-${crypto.randomUUID()}`;
    for (const dir of ['data', 'data/messages', 'runtime', 'logs']) {
      fs.mkdirSync(path.join(namedHome, dir), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(namedHome, dir), 0o700);
    }
    fs.chmodSync(namedHome, 0o700);
    const configLines = [
        'CTI_RUNTIME=codex',
        'CTI_ENABLED_CHANNELS=feishu',
        'CTI_FEISHU_APP_ID=test-app',
        `CTI_FEISHU_APP_SECRET=${secret}`,
        `CTI_FEISHU_ALLOWED_USERS=${userId}`,
        `CTI_FEISHU_GROUP_ALLOW_FROM=${groupId}`,
        'CTI_FEISHU_GROUP_POLICY=allowlist',
        'CTI_FEISHU_REQUIRE_MENTION=true',
        'CTI_SESSION_POLICY=fixed-confirm-recovery',
        'CTI_CODEX_SANDBOX_MODE=workspace-write',
        'CTI_CODEX_APPROVAL_POLICY=never',
        'CTI_CODEX_NETWORK_ACCESS=true',
      ];
    fs.writeFileSync(
      path.join(namedHome, 'config.env'),
      configLines.join('\n'),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(namedHome, 'runtime', 'external-health.json'),
      JSON.stringify({
        feishu: {
          connection: 'connected',
          lastDisconnectedAt: '2026-07-16T00:00:00.500Z',
          lastConnectedAt: '2026-07-16T00:00:01.000Z',
          lastAcceptedInboundAt: '2026-07-16T00:00:02.000Z',
        },
        codex: {
          lastErrorAt: '2026-07-16T00:00:02.500Z',
          lastSuccessAt: '2026-07-16T00:00:03.000Z',
        },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(namedHome, 'runtime', 'status.json'),
      JSON.stringify({
        running: true,
        pid: process.pid,
        startedAt: '2026-07-16T00:00:00.000Z',
      }),
      { mode: 0o600 },
    );
    const namedPlist = path.join(home, 'Library', 'LaunchAgents', 'com.claude-to-im.bridge.quant-lab.plist');
    fs.mkdirSync(path.dirname(namedPlist), { recursive: true });
    fs.writeFileSync(namedPlist, '<plist><string>quant-lab</string></plist>');
    fs.writeFileSync(path.join(binDir, 'curl'), '#!/usr/bin/env bash\nprintf \'{"code":0}\'\n', {
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(namedHome, 'logs', 'bridge.log'),
      '[2026-07-15T23:59:59.000Z] [ERROR] previous run failed\n'
        + '[2026-07-16T00:00:00.000Z] [INFO] [claude-to-im] Starting bridge (run_id: current-run)\n'
        + '[2026-07-16T00:00:04.000Z] [ERROR] (node:123) [DEP0169] DeprecationWarning: url.parse() is deprecated\n',
      { mode: 0o600 },
    );

    const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /Instance:\s*quant-lab/);
    assert.match(output, new RegExp(`Home:\\s*${escapeRegex(namedHome)}`));
    assert.match(output, /Label:\s*com\.claude-to-im\.bridge\.quant-lab/);
    assert.match(output, /\[OK\]\s+Named instance home permissions are 700/);
    assert.match(output, /\[OK\]\s+Named data\/runtime\/log directories are 700/);
    assert.match(output, /\[OK\]\s+Named data\/runtime\/log files are 600/);
    assert.match(output, /\[OK\]\s+Feishu group policy is allowlist/);
    assert.match(output, /\[OK\]\s+Feishu allowed users configured \(count: 1\)/);
    assert.match(output, /\[OK\]\s+Feishu allowed groups configured \(count: 1\)/);
    assert.match(output, /\[OK\]\s+Feishu require mention is true/);
    assert.match(output, /\[OK\]\s+Named plist excludes Feishu sensitive keys and values/);
    assert.match(output, /\[OK\]\s+Feishu external connection connected \(2026-07-16T00:00:01.000Z\)/);
    assert.match(output, /Feishu previous disconnect in current run \(2026-07-16T00:00:00.500Z\)/);
    assert.match(output, /\[OK\]\s+Feishu accepted inbound observed \(2026-07-16T00:00:02.000Z\)/);
    assert.match(output, /\[OK\]\s+Codex provider success observed \(2026-07-16T00:00:03.000Z\)/);
    assert.match(output, /Codex previous provider error in current run \(2026-07-16T00:00:02.500Z\)/);
    assert.match(output, /\[OK\]\s+No recent errors in log/);
    assert.match(output, /Codex effective policy:\s+sandbox=workspace-write, approval=never, network=true/);
    for (const sensitive of [secret, userId, groupId]) assert.doesNotMatch(output, new RegExp(sensitive));

    fs.writeFileSync(
      path.join(namedHome, 'runtime', 'external-health.json'),
      JSON.stringify({
        feishu: {
          connection: 'disconnected',
          lastConnectedAt: '2026-07-16T00:00:01.000Z',
          lastAcceptedInboundAt: '2026-07-16T00:00:02.000Z',
          lastDisconnectedAt: '2026-07-16T00:00:04.000Z',
        },
        codex: {
          lastSuccessAt: '2026-07-16T00:00:03.000Z',
          lastErrorAt: '2026-07-16T00:00:05.000Z',
        },
      }),
      { mode: 0o600 },
    );
    const unhealthy = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    const unhealthyOutput = `${unhealthy.stdout}${unhealthy.stderr}`;
    assert.match(unhealthyOutput, /\[FAIL\]\s+Feishu external connection disconnected \(2026-07-16T00:00:04.000Z\)/);
    assert.match(unhealthyOutput, /\[FAIL\]\s+Codex provider error observed \(2026-07-16T00:00:05.000Z\)/);
    for (const sensitive of [secret, userId, groupId]) assert.doesNotMatch(unhealthyOutput, new RegExp(sensitive));

    const invalidCanaries = ['sandbox-invalid-canary', 'approval-invalid-canary', 'network-invalid-canary'];
    fs.writeFileSync(
      path.join(namedHome, 'config.env'),
      configLines.map((line) => {
        if (line.startsWith('CTI_CODEX_SANDBOX_MODE=')) return `CTI_CODEX_SANDBOX_MODE=${invalidCanaries[0]}`;
        if (line.startsWith('CTI_CODEX_APPROVAL_POLICY=')) return `CTI_CODEX_APPROVAL_POLICY=${invalidCanaries[1]}`;
        if (line.startsWith('CTI_CODEX_NETWORK_ACCESS=')) return `CTI_CODEX_NETWORK_ACCESS=${invalidCanaries[2]}`;
        return line;
      }).join('\n'),
      { mode: 0o600 },
    );
    const invalidPolicy = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    const invalidOutput = `${invalidPolicy.stdout}${invalidPolicy.stderr}`;
    assert.match(invalidOutput, /Codex effective policy:\s+sandbox=invalid, approval=invalid, network=invalid/);
    assert.match(invalidOutput, /\[FAIL\]\s+Codex execution policy config values are valid/);
    for (const canary of invalidCanaries) assert.doesNotMatch(invalidOutput, new RegExp(canary));

    fs.writeFileSync(
      path.join(namedHome, 'config.env'),
      configLines.filter((line) => !line.startsWith('CTI_CODEX_')).join('\n'),
      { mode: 0o600 },
    );
    const inheritedPolicy = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    const inheritedOutput = `${inheritedPolicy.stdout}${inheritedPolicy.stderr}`;
    assert.match(inheritedOutput, /Codex effective policy:\s+sandbox=inherited, approval=derived-from-permission-mode, network=inherited/);
    assert.doesNotMatch(inheritedOutput, /approval=on-failure/);
    assert.match(inheritedOutput, /\[OK\]\s+Codex execution policy config values are valid/);

    fs.writeFileSync(path.join(namedHome, 'config.env'), configLines.join('\n'), { mode: 0o600 });

    fs.writeFileSync(
      path.join(namedHome, 'runtime', 'status.json'),
      JSON.stringify({ running: true, pid: process.pid, startedAt: '2026-07-16T00:00:10.000Z' }),
    );
    const stale = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    assert.match(`${stale.stdout}${stale.stderr}`, /\[FAIL\]\s+Feishu external connection connected/);
    assert.match(`${stale.stdout}${stale.stderr}`, /\[FAIL\]\s+Codex provider success observed/);

    fs.writeFileSync(
      path.join(namedHome, 'runtime', 'status.json'),
      JSON.stringify({ running: true, pid: 99999999, startedAt: '2026-07-16T00:00:00.000Z' }),
    );
    const crashed = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    const crashedOutput = `${crashed.stdout}${crashed.stderr}`;
    assert.match(crashedOutput, /\[FAIL\]\s+Feishu external connection disconnected \(2026-07-16T00:00:04.000Z\)/);
    assert.match(crashedOutput, /\[FAIL\]\s+Feishu accepted inbound not current \(last observed 2026-07-16T00:00:02.000Z\)/);
    assert.match(crashedOutput, /\[FAIL\]\s+Codex provider error observed \(2026-07-16T00:00:05.000Z\)/);

    fs.writeFileSync(
      path.join(namedHome, 'runtime', 'external-health.json'),
      JSON.stringify({
        feishu: {
          connection: 'connected',
          lastDisconnectedAt: '2026-07-16T00:00:00.500Z',
          lastConnectedAt: '2026-07-16T00:00:00.600Z',
          lastAcceptedInboundAt: '2026-07-16T00:00:00.700Z',
        },
        codex: {
          lastErrorAt: '2026-07-16T00:00:00.400Z',
          lastSuccessAt: '2026-07-16T00:00:00.800Z',
        },
      }),
      { mode: 0o600 },
    );
    const reconnectedThenCrashed = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
      env: { ...process.env, ...env, CTI_INSTANCE: 'quant-lab' },
      encoding: 'utf8',
    });
    const reconnectedThenCrashedOutput = `${reconnectedThenCrashed.stdout}${reconnectedThenCrashed.stderr}`;
    assert.match(reconnectedThenCrashedOutput, /\[FAIL\]\s+Feishu external connection not current \(last connected 2026-07-16T00:00:00.600Z\)/);
    assert.doesNotMatch(reconnectedThenCrashedOutput, /\[FAIL\]\s+Feishu external connection disconnected/);
    assert.match(reconnectedThenCrashedOutput, /\[FAIL\]\s+Codex provider not current \(last success 2026-07-16T00:00:00.800Z\)/);
  });

});

describe('portable instance contracts', () => {
  function createPortableDoctorFixture(): {
    home: string;
    namedHome: string;
    binDir: string;
    curlLog: string;
    env: NodeJS.ProcessEnv;
  } {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cti-doctor-portable-')));
    const namedHome = path.join(home, '.claude-to-im-portable');
    const binDir = path.join(home, 'bin');
    const curlLog = path.join(home, 'curl.log');
    for (const dir of [binDir, namedHome, ...['data', 'runtime', 'logs'].map((dir) => path.join(namedHome, dir))]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    fs.writeFileSync(
      path.join(binDir, 'stat'),
      '#!/usr/bin/env bash\n' +
        'if [ "${CTI_TEST_USE_SYSTEM_STAT:-0}" = "1" ]; then exec /usr/bin/stat "$@"; fi\n' +
        'if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ] && [ "${CTI_TEST_GNU_MODE_PREFIX:-0}" = "1" ]; then\n' +
        '  if [ "$(uname -s)" = "Darwin" ]; then mode=$(/usr/bin/stat -f "%Lp" "$3"); else mode=$(/usr/bin/stat -c "%a" "$3"); fi\n' +
        '  if [[ "$3" = */config.env ]]; then printf "%s\\n" "$mode"; else printf "1%s\\n" "${mode: -3}"; fi\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [ "${1:-}" = "-f" ]; then\n' +
        '  printf \'  File: "%s"\\n    ID: fake Namelen: 255 Type: test\\nBlock size: 4096\n\' "${3:-${2:-}}"\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [ "${1:-}" = "-c" ] && [ "$(uname -s)" = "Darwin" ]; then\n' +
        '  format="$2"\n' +
        '  shift 2\n' +
        '  [ "$format" != "%a" ] || format="%Lp"\n' +
        '  exec /usr/bin/stat -f "$format" "$@"\n' +
        'fi\n' +
        'exec /usr/bin/stat "$@"\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(binDir, 'curl'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CTI_TEST_CURL_LOG"\nprintf \'{"code":0}\'\n',
      { mode: 0o700 },
    );
    return {
      home,
      namedHome,
      binDir,
      curlLog,
      env: {
        HOME: home,
        PATH: `${binDir}:${process.env.PATH}`,
        CTI_HOME: namedHome,
        CTI_INSTANCE: 'portable',
        CTI_TEST_CURL_LOG: curlLog,
      },
    };
  }

  function writePortableDoctorConfig(namedHome: string, domain?: string): void {
    const lines = [
      'CTI_RUNTIME=codex',
      'CTI_ENABLED_CHANNELS=feishu',
      'CTI_FEISHU_APP_ID=test-app',
      'CTI_FEISHU_APP_SECRET=test-secret',
      'CTI_FEISHU_ALLOWED_USERS=test-user',
      'CTI_FEISHU_GROUP_ALLOW_FROM=test-group',
      'CTI_FEISHU_GROUP_POLICY=allowlist',
      'CTI_FEISHU_REQUIRE_MENTION=true',
    ];
    if (domain !== undefined) lines.push(`CTI_FEISHU_DOMAIN=${domain}`);
    fs.writeFileSync(path.join(namedHome, 'config.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(path.join(namedHome, 'config.env'), 0o600);
  }

  it('keeps the Linux default-home contract and exposes a safe uninstall hook', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cti-instance-portable-')));
    try {
      const output = shell(
        [
          'set -e',
          'unset CTI_HOME CTI_INSTANCE',
          'source scripts/instance-env.sh',
          'PID_FILE="$CTI_HOME/runtime/bridge.pid"',
          'LOG_FILE="$CTI_HOME/logs/bridge.log"',
          'SKILL_DIR="$PWD"',
          'read_pid() { :; }',
          'pid_alive() { return 1; }',
          'source scripts/supervisor-linux.sh',
          'declare -F supervisor_uninstall >/dev/null',
          'printf "%s|%s" "$CTI_INSTANCE" "$CTI_HOME"',
        ].join('; '),
        { HOME: home, CTI_HOME: '', CTI_INSTANCE: '' },
      );
      assert.equal(output, `default|${home}/.claude-to-im`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves the Windows default home and service identity contract', () => {
    const script = fs.readFileSync(path.join(SCRIPTS_DIR, 'supervisor-windows.ps1'), 'utf8');
    assert.match(script, /\$CtiHome\s*=\s*if \(\$env:CTI_HOME\).*\.claude-to-im/);
    assert.match(script, /\$ServiceName\s*=\s*'ClaudeToIMBridge'/);
  });

  it('rejects an extra directory mode bit while surviving GNU stat -f filesystem output', () => {
    const fixture = createPortableDoctorFixture();
    try {
      writePortableDoctorConfig(fixture.namedHome, 'feishu');
      let result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env, CTI_TEST_GNU_MODE_PREFIX: '1' },
        encoding: 'utf8',
      });
      let output = `${result.stdout}${result.stderr}`;
      assert.match(output, /\[FAIL\]\s+Named instance home permissions are 700 \(currently 1700\)/);
      assert.match(output, /\[OK\]\s+config\.env permissions are 600/);
      assert.doesNotMatch(output, /Block size: 4096/);

      fs.chmodSync(fixture.namedHome, 0o1700);
      result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env, CTI_TEST_USE_SYSTEM_STAT: '1' },
        encoding: 'utf8',
      });
      output = `${result.stdout}${result.stderr}`;
      assert.match(output, /\[FAIL\]\s+Named instance home permissions are 700 \(currently 1700\)/);
      assert.match(output, /\[OK\]\s+config\.env permissions are 600/);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('uses object identities instead of GNU stat -f filesystem output during stale-lock repair', () => {
    const fixture = createPortableDoctorFixture();
    const lockRoot = path.join(fixture.home, '.claude-to-im-lifecycle-locks');
    const lockKey = crypto.createHash('sha256').update(fixture.namedHome).digest('hex');
    const lockPath = path.join(lockRoot, `${lockKey}.lock`);
    try {
      fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner'), '99999999\nportable\n', { mode: 0o600 });
      fs.writeFileSync(
        path.join(fixture.binDir, 'rm'),
        '#!/usr/bin/env bash\n' +
          '/bin/mv "$CTI_TEST_LOCK_PATH" "$CTI_TEST_LOCK_PATH.moved"\n' +
          '/bin/mkdir "$CTI_TEST_LOCK_PATH"\n' +
          'exec /bin/rm "$@"\n',
        { mode: 0o700 },
      );

      const result = spawnSync(
        '/bin/bash',
        [path.join(SCRIPTS_DIR, 'doctor.sh'), '--repair-stale-lock'],
        {
          env: { ...process.env, ...fixture.env, CTI_TEST_LOCK_PATH: lockPath },
          encoding: 'utf8',
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /Refusing lifecycle-lock repair/);
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('successfully removes an unchanged stale lock through the validated identity path', () => {
    const fixture = createPortableDoctorFixture();
    const lockRoot = path.join(fixture.home, '.claude-to-im-lifecycle-locks');
    const lockKey = crypto.createHash('sha256').update(fixture.namedHome).digest('hex');
    const lockPath = path.join(lockRoot, `${lockKey}.lock`);
    try {
      fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner'), '99999999\nportable\n', { mode: 0o600 });
      const result = spawnSync(
        '/bin/bash',
        [path.join(SCRIPTS_DIR, 'doctor.sh'), '--repair-stale-lock'],
        { env: { ...process.env, ...fixture.env }, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /Removed verified stale lifecycle lock/);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('maps Feishu domain tokens to the same REST origins as the adapter', () => {
    const fixture = createPortableDoctorFixture();
    try {
      for (const [domain, expectedOrigin] of [
        ['lark', 'https://open.larksuite.com'],
        ['feishu', 'https://open.feishu.cn'],
        [undefined, 'https://open.feishu.cn'],
      ] as const) {
        writePortableDoctorConfig(fixture.namedHome, domain);
        fs.rmSync(fixture.curlLog, { force: true });
        const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
          env: { ...process.env, ...fixture.env },
          encoding: 'utf8',
        });
        const output = `${result.stdout}${result.stderr}`;
        const curlLog = fs.readFileSync(fixture.curlLog, 'utf8');
        assert.match(output, /\[OK\]\s+CTI_FEISHU_DOMAIN is lark, feishu, or unset/);
        assert.match(output, /\[OK\]\s+Feishu app credentials are valid/);
        assert.match(curlLog, new RegExp(`${escapeRegex(expectedOrigin)}/open-apis/auth/v3/tenant_access_token/internal`));
        assert.doesNotMatch(curlLog, /(?:^|\s)(?:lark|feishu)\/open-apis/);
      }

      for (const invalidDomain of ['https://open.larksuite.com', 'international']) {
        writePortableDoctorConfig(fixture.namedHome, invalidDomain);
        fs.rmSync(fixture.curlLog, { force: true });
        const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
          env: { ...process.env, ...fixture.env },
          encoding: 'utf8',
        });
        const output = `${result.stdout}${result.stderr}`;
        const curlLog = fs.readFileSync(fixture.curlLog, 'utf8');
        assert.match(output, /\[FAIL\]\s+CTI_FEISHU_DOMAIN is lark, feishu, or unset/);
        assert.match(curlLog, /https:\/\/open\.feishu\.cn\/open-apis\/auth\/v3\/tenant_access_token\/internal/);
        assert.doesNotMatch(curlLog, /open\.larksuite\.com/);
      }
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('matches config.ts whitespace trimming and last-key-wins semantics', () => {
    const fixture = createPortableDoctorFixture();
    try {
      writePortableDoctorConfig(fixture.namedHome, '  lark  ');
      let result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      assert.match(`${result.stdout}${result.stderr}`, /\[OK\]\s+CTI_FEISHU_DOMAIN is lark, feishu, or unset/);
      assert.match(fs.readFileSync(fixture.curlLog, 'utf8'), /https:\/\/open\.larksuite\.com\/open-apis/);

      writePortableDoctorConfig(fixture.namedHome, 'lark');
      fs.appendFileSync(fixture.namedHome + '/config.env', 'CTI_FEISHU_DOMAIN=feishu\n');
      fs.rmSync(fixture.curlLog, { force: true });
      result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      assert.match(`${result.stdout}${result.stderr}`, /\[OK\]\s+CTI_FEISHU_DOMAIN is lark, feishu, or unset/);
      assert.match(fs.readFileSync(fixture.curlLog, 'utf8'), /https:\/\/open\.feishu\.cn\/open-apis/);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('documents CTI_FEISHU_DOMAIN as the runtime enum instead of a URL', () => {
    const example = fs.readFileSync(path.join(SKILL_DIR, 'config.env.example'), 'utf8');
    assert.match(example, /Domain selector: lark for international Lark tenants; feishu or unset for Feishu CN/i);
    assert.match(example, /CTI_FEISHU_DOMAIN=lark/);
    assert.doesNotMatch(example, /CTI_FEISHU_DOMAIN=https?:\/\//);
  });

  it('validates and reports the configured question-card wait', () => {
    const fixture = createPortableDoctorFixture();
    try {
      writePortableDoctorConfig(fixture.namedHome, 'feishu');
      const configPath = path.join(fixture.namedHome, 'config.env');
      fs.appendFileSync(configPath, 'CTI_QUESTION_CARD_WAIT_SECONDS=3600\n');
      let result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Question cards wait|CTI_QUESTION_CARD_WAIT_SECONDS/);

      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, 'utf8').replace('CTI_RUNTIME=codex', 'CTI_RUNTIME=claude'),
        { mode: 0o600 },
      );
      result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      assert.match(`${result.stdout}${result.stderr}`, /\[OK\]\s+Question cards wait 3600 seconds before text fallback; outer expiry is 86400 seconds/);

      fs.appendFileSync(configPath, 'CTI_QUESTION_CARD_WAIT_SECONDS=0\n');
      result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      assert.match(`${result.stdout}${result.stderr}`, /\[FAIL\]\s+CTI_QUESTION_CARD_WAIT_SECONDS is an integer from 1 to 86400/);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('documents the question-card wait and /stop escape in setup guidance', () => {
    const guide = fs.readFileSync(path.join(SKILL_DIR, 'references', 'setup-guides.md'), 'utf8');
    const example = fs.readFileSync(path.join(SKILL_DIR, 'config.env.example'), 'utf8');
    const readme = fs.readFileSync(path.join(SKILL_DIR, 'README.md'), 'utf8');
    assert.match(guide, /CTI_QUESTION_CARD_WAIT_SECONDS=3600/);
    assert.match(example, /CTI_QUESTION_CARD_WAIT_SECONDS=3600/);
    assert.doesNotMatch(example, /CTI_QUESTION_CARD_WAIT_SECONDS=86400/);
    assert.match(readme, /strictly less than the question's remaining outer-expiry time/i);
    assert.match(readme, /after a restart.*remaining time.*expire instead of fallback/i);
    assert.match(readme, /persisted text fallback.*reposted once.*expires.*next restart/i);
    assert.match(guide, /\/stop.*closes all pending questions.*releases all provider waits.*next message.*new instruction/i);
  });

  it('reports effective persisted Claude binding modes and fixed overrides without changing them', () => {
    const fixture = createPortableDoctorFixture();
    try {
      writePortableDoctorConfig(fixture.namedHome, 'feishu');
      const configPath = path.join(fixture.namedHome, 'config.env');
      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, 'utf8').replace('CTI_RUNTIME=codex', 'CTI_RUNTIME=claude'),
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(fixture.namedHome, 'data', 'bindings.json'), JSON.stringify({
        'feishu:one': { mode: 'code' },
        'feishu:two': { mode: 'ask' },
        'feishu:three': { mode: 'plan' },
      }), { mode: 0o600 });
      let result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      let output = `${result.stdout}${result.stderr}`;
      assert.match(output, /\[INFO\]\s+Claude configured mode for new bindings is acceptEdits/);
      assert.match(output, /\[INFO\]\s+Claude effective existing binding modes: acceptEdits=1, default=1, plan=1/);
      assert.doesNotMatch(output, /filesystem setting sources/);
      assert.match(output, /\[INFO\]\s+Claude unresolved tool requests require IM approval/);

      fs.appendFileSync(path.join(fixture.namedHome, 'config.env'), 'CTI_FIXED_MODE=ask\n');
      result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      output = `${result.stdout}${result.stderr}`;
      assert.match(output, /\[INFO\]\s+Claude effective binding mode is default \(fixed by CTI_FIXED_MODE=ask; applies to all bindings\)/);

      fs.appendFileSync(path.join(fixture.namedHome, 'config.env'), 'CTI_AUTO_APPROVE=true\n');
      result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      assert.match(`${result.stdout}${result.stderr}`, /\[INFO\]\s+Claude unresolved tool requests are auto-approved \(CTI_AUTO_APPROVE=true\)/);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('does not print Claude posture claims for a Codex-only instance', () => {
    const fixture = createPortableDoctorFixture();
    try {
      writePortableDoctorConfig(fixture.namedHome, 'feishu');
      const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /Codex effective policy:/);
      assert.doesNotMatch(output, /Claude .*permission mode|Claude unresolved tool requests|filesystem setting sources/);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('runs the repository installer contract when GNU stat -f returns filesystem output', () => {
    const fixture = createPortableDoctorFixture();
    try {
      const tempRoot = path.join(fixture.home, 'repo');
      const tempScripts = path.join(tempRoot, 'claude-to-im', 'scripts');
      fs.mkdirSync(tempScripts, { recursive: true });
      for (const script of ['install-from-repo.test.sh', 'install-from-repo.sh', 'instance-env.sh']) {
        fs.copyFileSync(path.join(SCRIPTS_DIR, script), path.join(tempScripts, script));
      }
      fs.writeFileSync(
        path.join(tempRoot, 'install.sh'),
        'claude-to-im/scripts/install-from-repo.sh\n' +
          'skill-configs/*/instances/*/config.env\n',
      );
      const result = spawnSync('/bin/bash', [path.join(tempScripts, 'install-from-repo.test.sh')], {
        cwd: tempRoot,
        env: { ...process.env, PATH: `${fixture.binDir}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ok - claude-to-im repository installer boundary/);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('reports a missing config.env through the full doctor contract', () => {
    const fixture = createPortableDoctorFixture();
    try {
      const result = spawnSync('/bin/bash', [path.join(SCRIPTS_DIR, 'doctor.sh')], {
        env: { ...process.env, ...fixture.env },
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, output);
      assert.match(output, /\[FAIL\]\s+config\.env exists/);
      assert.match(output, /Results:/);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });
});
