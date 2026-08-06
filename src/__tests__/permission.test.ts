// Cross-repo precondition: when the sibling cti-core worktree exists, this file must load its required lifecycle build.
// Standalone clones skip those cases; `npm install` can replace the paired link and will fail the guard locally.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PendingQuestionRecord } from 'claude-to-im/src/lib/bridge/host.js';
import type { OutboundMessage, SendResult } from 'claude-to-im/src/lib/bridge/types.js';
import { PendingPermissions } from '../permission-gateway.js';

const brokerSpecifier = 'claude-to-im/src/lib/bridge/question-broker.js';
const pairedCoreDirectory = fileURLToPath(new URL('../../../cti-core/', import.meta.url));
const hasPairedCoreWorktree = existsSync(pairedCoreDirectory);
const crossRepoTestOptions = {
  skip: hasPairedCoreWorktree ? false : 'paired cti-core worktree is not present',
};

async function loadCoreModules() {
  let resolvedBroker: string;
  let expectedBroker: string;
  try {
    resolvedBroker = realpathSync(fileURLToPath(import.meta.resolve(brokerSpecifier)));
    expectedBroker = realpathSync(fileURLToPath(new URL('../../../cti-core/dist/lib/bridge/question-broker.js', import.meta.url)));
  } catch (cause) {
    throw new Error(
      'Cross-repo test precondition failed: could not resolve both the loaded claude-to-im broker and the paired cti-core dist build. Restore node_modules/claude-to-im and run npm run build in the paired cti-core worktree.',
      { cause },
    );
  }
  assert.equal(
    resolvedBroker,
    expectedBroker,
    `Cross-repo test precondition failed: claude-to-im resolved to ${resolvedBroker}, expected the paired cti-core worktree build at ${expectedBroker}. npm install may have replaced node_modules/claude-to-im.`,
  );
  try {
    const modules = await Promise.all([
      import('claude-to-im/src/lib/bridge/channel-adapter.js'),
      import('claude-to-im/src/lib/bridge/context.js'),
      import(brokerSpecifier),
    ]);
    return { modules, resolvedBroker };
  } catch (cause) {
    throw new Error(
      `Cross-repo test precondition failed: the paired cti-core build at ${resolvedBroker} could not be loaded. Run npm run build in the paired cti-core worktree.`,
      { cause },
    );
  }
}

describe('PendingPermissions', () => {
  it('waitFor resolves on allow', async () => {
    const pp = new PendingPermissions();
    const promise = pp.waitFor('req-1');
    assert.equal(pp.size, 1);

    pp.resolve('req-1', { behavior: 'allow' });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.equal(pp.size, 0);
  });

  it('waitFor resolves on deny', async () => {
    const pp = new PendingPermissions();
    const promise = pp.waitFor('req-2');

    pp.resolve('req-2', { behavior: 'deny', message: 'Not allowed' });
    const result = await promise;
    assert.equal(result.behavior, 'deny');
    assert.equal(result.message, 'Not allowed');
  });

  it('resolve returns false for unknown id', () => {
    const pp = new PendingPermissions();
    assert.equal(pp.resolve('unknown', { behavior: 'allow' }), false);
  });

  it('resolve returns true for known id', async () => {
    const pp = new PendingPermissions();
    pp.waitFor('req-3');
    assert.equal(pp.resolve('req-3', { behavior: 'allow' }), true);
  });

  it('denyAll resolves all pending', async () => {
    const pp = new PendingPermissions();
    const p1 = pp.waitFor('req-a');
    const p2 = pp.waitFor('req-b');
    assert.equal(pp.size, 2);

    pp.denyAll();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.behavior, 'deny');
    assert.equal(r2.behavior, 'deny');
    assert.equal(pp.size, 0);
  });

  it('denyAll message says bridge shutting down', async () => {
    const pp = new PendingPermissions();
    const p = pp.waitFor('req-c');
    pp.denyAll();
    const result = await p;
    assert.equal(result.message, 'Bridge shutting down');
  });

  it('timeout auto-denies after expiry', async () => {
    // Create with short timeout for testing
    const pp = new PendingPermissions();
    // Access private field to set short timeout
    (pp as any).timeoutMs = 50;

    const result = await pp.waitFor('req-timeout');
    assert.equal(result.behavior, 'deny');
    assert.match(result.message!, /timed out/i);
    assert.equal(pp.size, 0);
  });

  it('does not apply the tool-permission timeout to AskUserQuestion waits', async () => {
    const pp = new PendingPermissions();
    (pp as any).timeoutMs = 20;
    const waiting = pp.waitForQuestion('ask-long-wait');

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(pp.size, 1);
    assert.equal(pp.resolve('ask-long-wait', { behavior: 'deny', message: 'question released by broker' }), true);
    assert.deepEqual(await waiting, { behavior: 'deny', message: 'question released by broker' });
  });

  it('loads the paired cti-core worktree build with the required question lifecycle', crossRepoTestOptions, async () => {
    const { modules, resolvedBroker } = await loadCoreModules();
    const [, , { QuestionBroker }] = modules;
    assert.equal(
      typeof QuestionBroker.prototype.closePendingQuestionsForChat,
      'function',
      `Cross-repo test precondition failed: ${resolvedBroker} does not export the newly built QuestionBroker.closePendingQuestionsForChat method. Run npm run build in the paired cti-core worktree.`,
    );
    const builtSource = readFileSync(resolvedBroker, 'utf8');
    assert.match(
      builtSource,
      /bridge_question_card_wait_seconds/,
      `Cross-repo test precondition failed: ${resolvedBroker} is stale and lacks bridge_question_card_wait_seconds. Run npm run build in the paired cti-core worktree.`,
    );
    assert.match(
      builtSource,
      /fallbackReissueCount/,
      `Cross-repo test precondition failed: ${resolvedBroker} is stale and lacks fallbackReissueCount. Run npm run build in the paired cti-core worktree.`,
    );
    assert.doesNotMatch(
      builtSource,
      /DEFAULT_ACTION_TIMEOUT_MS/,
      `Cross-repo test precondition failed: ${resolvedBroker} still contains the obsolete DEFAULT_ACTION_TIMEOUT_MS build. Run npm run build in the paired cti-core worktree.`,
    );
  });

  it('uses the core broker as the single question deadline and rejects a late card click', crossRepoTestOptions, async () => {
    const { modules } = await loadCoreModules();
    const [{ BaseChannelAdapter }, { initBridgeContext }, { QuestionBroker }] = modules;
    const pp = new PendingPermissions();
    (pp as any).timeoutMs = 10;
    const questions = new Map<string, PendingQuestionRecord>();
    const sent: OutboundMessage[] = [];
    class QuestionAdapter extends BaseChannelAdapter {
      readonly channelType = 'feishu';
      readonly supportsQuestionCards = true;
      async start() {}
      async stop() {}
      isRunning() { return true; }
      async consumeOne() { return null; }
      async send(message: OutboundMessage): Promise<SendResult> {
        sent.push(structuredClone(message));
        return { ok: true, messageId: `question-${sent.length}` };
      }
      validateConfig() { return null; }
      isAuthorized() { return true; }
    }
    initBridgeContext({
      store: {
        getSetting: () => null,
        savePendingQuestion(record: PendingQuestionRecord) {
          questions.set(record.questionRequestId, structuredClone(record));
        },
        getPendingQuestion(id: string) {
          return questions.get(id) ? structuredClone(questions.get(id)!) : null;
        },
        listPendingQuestions() {
          return [...questions.values()].map((record) => structuredClone(record));
        },
        transitionPendingQuestion(id: string, expected: PendingQuestionRecord['state'][], update: Partial<PendingQuestionRecord>) {
          const current = questions.get(id);
          if (!current || !expected.includes(current.state)) return false;
          questions.set(id, { ...current, ...structuredClone(update) });
          return true;
        },
      } as any,
      llm: { streamChat: () => new ReadableStream() },
      permissions: {
        resolvePendingPermission: () => false,
        resolvePendingQuestion(id, resolution) {
          return pp.resolve(id, resolution);
        },
      },
      lifecycle: {},
    });
    const adapter = new QuestionAdapter();
    const broker = new QuestionBroker({ actionTimeoutMs: 30, generation: () => 'single-deadline' });
    const waiting = pp.waitForQuestion('ask-single-deadline');
    await broker.forwardQuestionRequest(
      adapter,
      { channelType: 'feishu', chatId: 'group-single-question-deadline' },
      'ask-single-deadline',
      [{
        question: 'Continue?',
        header: 'Continue',
        options: [
          { label: 'Yes', description: 'Continue' },
          { label: 'No', description: 'Stop' },
        ],
        multiSelect: false,
      }],
      'session-single-deadline',
    );

    const result = await waiting;
    assert.deepEqual(result, {
      behavior: 'deny',
      message: 'Interactive question moved to text fallback',
    });
    assert.equal(questions.get('ask-single-deadline')!.state, 'fallback-pending');
    assert.equal(sent.length, 2, JSON.stringify(sent));
    assert.match(sent.at(-1)!.text, /reply in text/i);
    const late = broker.handleQuestionCallback(
      'ask:submit:ask-single-deadline:single-deadline',
      'group-single-question-deadline',
      'question-1',
      { q_0: 'Yes' },
    );
    assert.equal(late.accepted, false);
    assert.equal(late.resumePrompt, undefined);
    broker.dispose();
  });

  it('returns a complete AskUserQuestion answers mapping exactly once', async () => {
    const pp = new PendingPermissions();
    const questions = [
      {
        question: 'Database?',
        header: 'Database',
        options: [
          { label: 'PostgreSQL', description: 'Relational' },
          { label: 'MongoDB', description: 'Document' },
        ],
        multiSelect: false,
      },
      {
        question: 'Features?',
        header: 'Features',
        options: [
          { label: 'Auth', description: 'Authentication' },
          { label: 'Cache', description: 'Caching' },
        ],
        multiSelect: true,
      },
    ];
    const waiting = pp.waitForQuestion('ask-1');
    assert.equal(pp.resolveQuestion('ask-1', {
      questions,
      answers: { 'Database?': 'PostgreSQL', 'Features?': 'Auth, Cache' },
    }), true);
    assert.equal(pp.resolveQuestion('ask-1', {
      questions: [],
      answers: {},
    }), false);
    assert.deepEqual(await waiting, {
      behavior: 'allow',
      updatedInput: {
        questions,
        answers: { 'Database?': 'PostgreSQL', 'Features?': 'Auth, Cache' },
      },
    });
  });
});
