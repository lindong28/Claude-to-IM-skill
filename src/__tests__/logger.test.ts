import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConsoleErrorLevel, maskSecrets, redactSensitiveValues } from '../logger.js';

describe('classifyConsoleErrorLevel', () => {
  it('records Node deprecation warnings as warnings without downgrading real errors', () => {
    assert.equal(
      classifyConsoleErrorLevel(['(node:123) [DEP0169] DeprecationWarning: url.parse() is deprecated']),
      'WARN',
    );
    assert.equal(classifyConsoleErrorLevel(['bridge failed']), 'ERROR');
  });
});

describe('maskSecrets', () => {
  it('masks token=value patterns', () => {
    const input = 'token=secret123456789';
    const result = maskSecrets(input);
    assert.notEqual(result, input);
    // Should not contain the full token
    assert.ok(!result.includes('secret123456789'));
  });

  it('masks secret=value patterns', () => {
    const input = 'secret=my-secret-value';
    const result = maskSecrets(input);
    assert.ok(!result.includes('my-secret-value'));
  });

  it('masks password=value patterns', () => {
    const input = 'password=hunter2abc';
    const result = maskSecrets(input);
    assert.ok(!result.includes('hunter2abc'));
  });

  it('masks api_key=value patterns', () => {
    const input = 'api_key=sk-abcdef123456';
    const result = maskSecrets(input);
    assert.ok(!result.includes('sk-abcdef123456'));
  });

  it('masks Telegram bot token format', () => {
    const input = 'Using bot token bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a';
    const result = maskSecrets(input);
    assert.ok(!result.includes('bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a'));
  });

  it('masks Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.signature';
    const result = maskSecrets(input);
    assert.ok(!result.includes('Bearer eyJhbGciOiJIUzI1NiJ9.test.signature'));
  });

  it('leaves normal text unchanged', () => {
    const input = 'Starting bridge on port 8080';
    assert.equal(maskSecrets(input), input);
  });

  it('preserves last 4 chars of masked values', () => {
    const input = 'token=abcdefghijklmnop';
    const result = maskSecrets(input);
    // The last 4 chars of the matched portion should be visible
    assert.ok(result.includes('mnop'));
  });

  it('handles quoted values', () => {
    const input = 'token="my-secret-token"';
    const result = maskSecrets(input);
    assert.ok(!result.includes('my-secret-token'));
  });
});

describe('redactSensitiveValues', () => {
  it('removes standalone configured secrets and replaces identifiers with stable irreversible refs', () => {
    const secret = 'standalone_secret_canary';
    const userId = 'user_identifier_canary';
    const groupId = 'group_identifier_canary';
    const input = `failure ${secret} user=${userId} group=${groupId} repeat=${userId}`;
    const redacted = redactSensitiveValues(input, {
      secrets: [secret],
      identifiers: [userId, groupId],
    });
    assert.doesNotMatch(redacted, new RegExp([secret, userId, groupId].join('|')));
    const refs = redacted.match(/ref=[a-f0-9]{12}/g) || [];
    assert.equal(refs.length, 3);
    assert.equal(refs[0], refs[2]);
    assert.notEqual(refs[0], refs[1]);
  });
});
