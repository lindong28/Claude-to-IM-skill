import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAuditedCallEnvelope,
  hashRepositoryInstructionSnapshot,
  associateCodexRollout,
  captureCodexRolloutCheckpoint,
  persistCodexCallEnvelope,
} from '../codex-audit.js';

describe('Codex call-envelope audit contract', () => {
  it('associates the exact thread and target turn and hashes every bridge-observable input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rollout-fixture-'));
    const rollout = path.join(root, 'rollout-thread-123.jsonl');
    const oldLines = [
      { timestamp: '2026-07-16T00:00:00Z', type: 'session_meta', payload: { id: 'thread-123', cli_version: '0.144.5', cwd: '/repo' } },
      { timestamp: '2026-07-16T00:00:01Z', type: 'turn_context', payload: { model: 'gpt-old' } },
      { timestamp: '2026-07-16T00:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'exact prompt' } },
    ];
    fs.writeFileSync(rollout, `${oldLines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const checkpoint = captureCodexRolloutCheckpoint(root);
    const newLines = [
      { timestamp: '2026-07-16T00:00:03Z', type: 'turn_context', payload: { model: 'gpt-effective' } },
      { timestamp: '2026-07-16T00:00:04Z', type: 'event_msg', payload: { type: 'user_message', message: 'exact prompt' } },
    ];
    fs.appendFileSync(rollout, `${newLines.map((line) => JSON.stringify(line)).join('\n')}\n`);

    const association = associateCodexRollout(root, 'thread-123', 'exact prompt', checkpoint);
    assert.equal(association?.effectiveModel, 'gpt-effective');
    assert.equal(association?.cliVersion, '0.144.5');
    assert.equal(association?.turnOrdinal, 2);

    const first = buildAuditedCallEnvelope({
      effectiveModel: association!.effectiveModel,
      sdkVersion: '0.144.5',
      cliVersion: association!.cliVersion,
      threadId: 'thread-123',
      input: 'exact prompt',
      conversationHistory: [{ role: 'user', content: 'before' }],
      attachments: [{ id: 'a', name: 'chart.png', type: 'image/png', size: 3, data: 'YWJj', filePath: '/repo/chart.png' }],
      workingDirectory: '/repo',
      repoInstructionSnapshotHash: 'repo-hash',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      instanceConfigHash: 'config-hash',
      rolloutAssociation: association!,
    });
    const changed = buildAuditedCallEnvelope({ ...first.envelope, conversationHistory: [{ role: 'user', content: 'changed' }] });
    const sameCallDifferentEvidence = buildAuditedCallEnvelope({
      ...first.envelope,
      rolloutAssociation: { ...first.envelope.rolloutAssociation, rolloutSha256: 'different-rollout-evidence' },
    });
    assert.match(first.hash, /^[a-f0-9]{64}$/);
    assert.notEqual(first.hash, changed.hash);
    assert.equal(first.hash, sameCallDifferentEvidence.hash);
    assert.equal(first.envelope.attachments[0].contentSha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal('data' in first.envelope.attachments[0], false);
    assert.deepEqual(first.envelope.toolFileInputs, [{
      type: 'local_image',
      contentSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sourceFilePath: '/repo/chart.png',
    }]);
    assert.equal(first.envelope.serverContext, 'unobservable');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never falls back to a historical identical prompt when the current turn is not observable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rollout-stale-'));
    const rollout = path.join(root, 'rollout-thread-stale.jsonl');
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-stale', cli_version: '0.144.5' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-old' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'same prompt' } }),
    ].join('\n') + '\n');
    const checkpoint = captureCodexRolloutCheckpoint(root);
    assert.equal(associateCodexRollout(root, 'thread-stale', 'same prompt', checkpoint), undefined);
    fs.appendFileSync(rollout, `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-new-but-unproven' } })}\n`);
    assert.equal(associateCodexRollout(root, 'thread-stale', 'same prompt', checkpoint), undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails closed when more than one new turn makes the association ambiguous', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rollout-ambiguous-'));
    const rollout = path.join(root, 'rollout-thread-ambiguous.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-ambiguous', cli_version: '0.144.5' } })}\n`);
    const checkpoint = captureCodexRolloutCheckpoint(root);
    fs.appendFileSync(rollout, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-one' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'same prompt' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-two' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'same prompt' } }),
    ].join('\n') + '\n');
    assert.equal(associateCodexRollout(root, 'thread-ambiguous', 'same prompt', checkpoint), undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves separate rollout evidence for repeated calls with the same envelope hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-audit-repeat-'));
    const base = buildAuditedCallEnvelope({
      effectiveModel: 'gpt-effective', sdkVersion: '0.144.5', cliVersion: '0.144.5',
      threadId: 'thread-repeat', input: 'same', conversationHistory: [], attachments: [],
      workingDirectory: '/repo', repoInstructionSnapshotHash: 'repo-hash', approvalPolicy: 'never',
      instanceConfigHash: 'config-hash',
      rolloutAssociation: { effectiveModel: 'gpt-effective', cliVersion: '0.144.5', turnOrdinal: 1, rolloutSha256: 'a'.repeat(64) },
    });
    const replay = buildAuditedCallEnvelope({
      ...base.envelope,
      rolloutAssociation: { ...base.envelope.rolloutAssociation, turnOrdinal: 2, rolloutSha256: 'b'.repeat(64) },
    });
    assert.equal(base.hash, replay.hash);
    persistCodexCallEnvelope(root, base);
    persistCodexCallEnvelope(root, replay);
    assert.equal(fs.readdirSync(path.join(root, 'codex-call-envelopes')).length, 2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hashes observable repo instruction candidates deterministically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-repo-instructions-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rules\n');
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'CLAUDE.md'), 'nested rules\n');
    const first = hashRepositoryInstructionSnapshot(path.join(root, 'nested'));
    const second = hashRepositoryInstructionSnapshot(path.join(root, 'nested'));
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
    fs.writeFileSync(path.join(root, 'nested', 'CLAUDE.md'), 'changed rules\n');
    assert.notEqual(hashRepositoryInstructionSnapshot(path.join(root, 'nested')), first);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not claim an association when the thread or exact input differs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rollout-negative-'));
    fs.writeFileSync(path.join(root, 'rollout.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'other-thread', cli_version: '0.144.5' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-effective' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'exact prompt' } }),
    ].join('\n'));
    const checkpoint = { fileSizes: {} };
    assert.equal(associateCodexRollout(root, 'thread-123', 'exact prompt', checkpoint), undefined);
    assert.equal(associateCodexRollout(root, 'other-thread', 'different prompt', checkpoint), undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
