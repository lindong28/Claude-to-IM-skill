import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_PATH,
  maskSecret,
  configToSettings,
  loadConfig,
  saveConfig,
  validateConfig,
  codexProviderOptionsFromConfig,
  type Config,
} from '../config.js';

// ── maskSecret ──

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret(''), '****');
  });

  it('preserves last 4 chars for longer values', () => {
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });

  it('handles exactly 5 chars', () => {
    assert.equal(maskSecret('12345'), '*2345');
  });
});

// ── configToSettings ──

describe('configToSettings', () => {
  const base: Config = {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
  };

  it('always sets remote_bridge_enabled to true', () => {
    const m = configToSettings(base);
    assert.equal(m.get('remote_bridge_enabled'), 'true');
    assert.equal(m.get('bridge_runtime'), 'claude');
  });

  it('sets channel enabled flags based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['telegram', 'discord'] });
    assert.equal(m.get('bridge_telegram_enabled'), 'true');
    assert.equal(m.get('bridge_discord_enabled'), 'true');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
  });

  it('maps telegram config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['telegram'],
      tgBotToken: 'bot123:abc',
      tgAllowedUsers: ['user1', 'user2'],
      tgChatId: '99999',
    });
    assert.equal(m.get('telegram_bot_token'), 'bot123:abc');
    assert.equal(m.get('telegram_bridge_allowed_users'), 'user1,user2');
    assert.equal(m.get('telegram_chat_id'), '99999');
  });

  it('maps discord config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['discord'],
      discordBotToken: 'discord-token',
      discordAllowedUsers: ['u1'],
      discordAllowedChannels: ['c1', 'c2'],
      discordAllowedGuilds: ['g1'],
    });
    assert.equal(m.get('bridge_discord_bot_token'), 'discord-token');
    assert.equal(m.get('bridge_discord_allowed_users'), 'u1');
    assert.equal(m.get('bridge_discord_allowed_channels'), 'c1,c2');
    assert.equal(m.get('bridge_discord_allowed_guilds'), 'g1');
  });

  it('maps feishu config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['feishu'],
      feishuAppId: 'app-id',
      feishuAppSecret: 'app-secret',
      feishuDomain: 'example.com',
      feishuAllowedUsers: ['fu1'],
      feishuGroupPolicy: 'allowlist',
      feishuGroupAllowFrom: ['fg1', 'fg2'],
      feishuRequireMention: true,
      sessionPolicy: 'fixed-confirm-recovery',
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_domain'), 'example.com');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
    assert.equal(m.get('bridge_feishu_group_policy'), 'allowlist');
    assert.equal(m.get('bridge_feishu_group_allow_from'), 'fg1,fg2');
    assert.equal(m.get('bridge_feishu_require_mention'), 'true');
    assert.equal(m.get('bridge_session_policy'), 'fixed-confirm-recovery');
  });

  it('sets bridge_qq_enabled based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['qq'] });
    assert.equal(m.get('bridge_qq_enabled'), 'true');
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
  });

  it('defaults bridge_qq_enabled to false', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_qq_enabled'), 'false');
  });

  it('maps qq config fields', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'qq-app-id',
      qqAppSecret: 'qq-secret',
      qqAllowedUsers: ['openid1', 'openid2'],
    });
    assert.equal(m.get('bridge_qq_app_id'), 'qq-app-id');
    assert.equal(m.get('bridge_qq_app_secret'), 'qq-secret');
    assert.equal(m.get('bridge_qq_allowed_users'), 'openid1,openid2');
  });

  it('maps qq image settings', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
      qqImageEnabled: false,
      qqMaxImageSize: 10,
    });
    assert.equal(m.get('bridge_qq_image_enabled'), 'false');
    assert.equal(m.get('bridge_qq_max_image_size'), '10');
  });

  it('maps weixin settings', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['weixin'],
      weixinBaseUrl: 'https://example.weixin.test',
      weixinCdnBaseUrl: 'https://cdn.weixin.test',
      weixinMediaEnabled: true,
    });
    assert.equal(m.get('bridge_weixin_enabled'), 'true');
    assert.equal(m.get('bridge_weixin_base_url'), 'https://example.weixin.test');
    assert.equal(m.get('bridge_weixin_cdn_base_url'), 'https://cdn.weixin.test');
    assert.equal(m.get('bridge_weixin_media_enabled'), 'true');
  });

  it('omits qq image settings when not set', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
    });
    assert.equal(m.has('bridge_qq_image_enabled'), false);
    assert.equal(m.has('bridge_qq_max_image_size'), false);
  });

  it('maps workdir and mode, omits model when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_default_work_dir'), '/tmp/test');
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.get('bridge_default_mode'), 'code');
  });

  it('maps model when explicitly set', () => {
    const m = configToSettings({ ...base, defaultModel: 'gpt-4o' });
    assert.equal(m.get('bridge_default_model'), 'gpt-4o');
    assert.equal(m.get('default_model'), 'gpt-4o');
  });

  it('maps non-default mode', () => {
    const m = configToSettings({ ...base, defaultMode: 'plan' });
    assert.equal(m.get('bridge_default_mode'), 'plan');
  });

  it('maps an opt-in fixed mode independently of the session policy', () => {
    const m = configToSettings({ ...base, fixedMode: 'code' });
    assert.equal(m.get('bridge_fixed_mode'), 'code');
    assert.equal(m.has('bridge_session_policy'), false);
  });

  it('omits optional fields when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('telegram_bot_token'), false);
    assert.equal(m.has('bridge_discord_bot_token'), false);
    assert.equal(m.has('bridge_feishu_app_id'), false);
    assert.equal(m.has('bridge_feishu_group_policy'), false);
    assert.equal(m.has('bridge_feishu_group_allow_from'), false);
    assert.equal(m.has('bridge_feishu_require_mention'), false);
    assert.equal(m.has('bridge_session_policy'), false);
    assert.equal(m.has('bridge_fixed_mode'), false);
  });
});

describe('Feishu startup policy validation', () => {
  const valid: Config = {
    runtime: 'codex',
    enabledChannels: ['feishu'],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
    feishuAppId: 'cli_test_app',
    feishuAppSecret: 'cli_test_secret',
    feishuAllowedUsers: ['user_canary'],
    feishuGroupPolicy: 'allowlist',
    feishuGroupAllowFrom: ['group_canary'],
    feishuRequireMention: true,
    sessionPolicy: 'fixed-confirm-recovery',
  };

  it('accepts the locked named-instance policy', () => {
    assert.doesNotThrow(() => validateConfig(valid));
  });

  const missingCases: Array<[string, Partial<Config>]> = [
    ['CTI_FEISHU_GROUP_POLICY', { feishuGroupPolicy: undefined }],
    ['CTI_FEISHU_APP_ID', { feishuAppId: undefined }],
    ['CTI_FEISHU_APP_SECRET', { feishuAppSecret: undefined }],
    ['CTI_FEISHU_ALLOWED_USERS', { feishuAllowedUsers: [] }],
    ['CTI_FEISHU_GROUP_ALLOW_FROM', { feishuGroupAllowFrom: [] }],
  ];
  for (const [field, patch] of missingCases) {
    it(`rejects allowlist config missing ${field}`, () => {
      assert.throws(
        () => validateConfig({ ...valid, ...patch }),
        new RegExp(field),
      );
    });
  }

  for (const value of [undefined, false] as const) {
    it(`rejects fixed Feishu policy when require mention is ${String(value)}`, () => {
      assert.throws(
        () => validateConfig({ ...valid, feishuRequireMention: value }),
        /CTI_FEISHU_REQUIRE_MENTION.*true/,
      );
    });
  }

  it('preserves generic Feishu allowlist compatibility when fixed recovery is unset', () => {
    assert.doesNotThrow(() => validateConfig({
      ...valid,
      sessionPolicy: undefined,
      feishuRequireMention: false,
    }));
  });

  it('preserves existing non-Feishu defaults', () => {
    assert.doesNotThrow(() => validateConfig({
      runtime: 'claude',
      enabledChannels: ['weixin'],
      defaultWorkDir: '/tmp/default',
      defaultMode: 'code',
      fixedMode: 'code',
    }));
  });
});

describe('Codex execution policy validation', () => {
  const base: Config = {
    runtime: 'codex',
    enabledChannels: [],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
  };

  it('accepts and maps the locked named-instance policy', () => {
    const config: Config = {
      ...base,
      codexSandboxMode: 'workspace-write',
      codexApprovalPolicy: 'never',
      codexNetworkAccess: true,
      sessionPolicy: 'fixed-confirm-recovery',
      configHash: 'config-hash-canary',
    };
    assert.doesNotThrow(() => validateConfig(config));
    assert.deepEqual(codexProviderOptionsFromConfig(config), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      sessionPolicy: 'fixed-confirm-recovery',
      audit: {
        runtimeDirectory: path.join(CONFIG_PATH, '..', 'runtime'),
        instanceConfigHash: 'config-hash-canary',
      },
    });
  });

  it('omits unset policy overrides for backward compatibility', () => {
    assert.deepEqual(codexProviderOptionsFromConfig(base), {});
  });
});

// ── Config file parsing (loadConfig/saveConfig round-trip) ──

describe('loadConfig/saveConfig round-trip', () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-test-'));
    origHome = process.env.HOME || '';
    // We can't easily override CTI_HOME since it's a const,
    // so we test the parsing logic indirectly through configToSettings
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(CONFIG_PATH, { force: true });
  });

  it('configToSettings returns correct defaults', () => {
    const m = configToSettings({
      runtime: 'claude',
      enabledChannels: [],
      defaultWorkDir: process.cwd(),
      defaultMode: 'code',
    });
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
    assert.equal(m.get('bridge_discord_enabled'), 'false');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
    assert.equal(m.get('bridge_qq_enabled'), 'false');
    assert.equal(m.get('bridge_weixin_enabled'), 'false');
  });

  it('round-trips Feishu and session policies', () => {
    const config: Config = {
      runtime: 'codex',
      enabledChannels: ['feishu'],
      defaultWorkDir: '/tmp/fixed',
      defaultMode: 'code',
      feishuAppId: 'cli_test_app',
      feishuAppSecret: 'cli_test_secret',
      feishuAllowedUsers: ['user_canary'],
      feishuGroupPolicy: 'allowlist',
      feishuGroupAllowFrom: ['group_canary'],
      feishuRequireMention: true,
      sessionPolicy: 'fixed-confirm-recovery',
      codexSandboxMode: 'workspace-write',
      codexApprovalPolicy: 'never',
      codexNetworkAccess: true,
    };

    saveConfig(config);
    const loaded = loadConfig();
    assert.equal(loaded.feishuGroupPolicy, config.feishuGroupPolicy);
    assert.deepEqual(loaded.feishuGroupAllowFrom, config.feishuGroupAllowFrom);
    assert.equal(loaded.feishuRequireMention, config.feishuRequireMention);
    assert.equal(loaded.sessionPolicy, config.sessionPolicy);
    assert.equal(loaded.fixedMode, config.fixedMode);
    assert.equal(loaded.codexSandboxMode, config.codexSandboxMode);
    assert.equal(loaded.codexApprovalPolicy, config.codexApprovalPolicy);
    assert.equal(loaded.codexNetworkAccess, config.codexNetworkAccess);
    assert.match(loaded.configHash || '', /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(CONFIG_PATH).mode & 0o777, 0o600);
  });

  for (const [key, value] of [
    ['CTI_FEISHU_GROUP_POLICY', 'permissive'],
    ['CTI_FEISHU_REQUIRE_MENTION', 'yes'],
    ['CTI_SESSION_POLICY', 'mutable-ish'],
    ['CTI_FIXED_MODE', 'mutable-ish'],
    ['CTI_CODEX_SANDBOX_MODE', 'unsafe-ish'],
    ['CTI_CODEX_APPROVAL_POLICY', 'always'],
    ['CTI_CODEX_NETWORK_ACCESS', 'yes'],
  ]) {
    it(`rejects invalid ${key} before startup`, () => {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, `${key}=${value}\n`, { mode: 0o600 });
      assert.throws(() => loadConfig(), new RegExp(key));
    });
  }

  it('omits model controls when saving a named instance', () => {
    const originalInstance = process.env.CTI_INSTANCE;
    process.env.CTI_INSTANCE = 'quant-lab';
    try {
      saveConfig({
        runtime: 'codex',
        enabledChannels: [],
        defaultWorkDir: '/tmp/fixed',
        defaultModel: 'must-not-be-persisted',
        defaultMode: 'code',
        codexSandboxMode: 'workspace-write',
        codexApprovalPolicy: 'never',
        codexNetworkAccess: true,
      });
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      assert.doesNotMatch(content, /CTI_DEFAULT_MODEL|CTI_CODEX_PASS_MODEL/);
    } finally {
      if (originalInstance === undefined) delete process.env.CTI_INSTANCE;
      else process.env.CTI_INSTANCE = originalInstance;
    }
  });
});
