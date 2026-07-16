import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ── SSE utils tests ─────────────────────────────────────────

import { sseEvent } from '../sse-utils.js';

describe('sseEvent', () => {
  it('formats a string data payload', () => {
    const result = sseEvent('text', 'hello');
    assert.equal(result, 'data: {"type":"text","data":"hello"}\n');
  });

  it('stringifies object data payload', () => {
    const result = sseEvent('result', { usage: { input_tokens: 10 } });
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.type, 'result');
    const inner = JSON.parse(parsed.data);
    assert.equal(inner.usage.input_tokens, 10);
  });

  it('handles newlines in data', () => {
    const result = sseEvent('text', 'line1\nline2');
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.data, 'line1\nline2');
  });
});

// ── CodexProvider tests ─────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

describe('CodexProvider', () => {
  it('passes explicit execution policy exactly to start and resume without model or extra directories', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const originalPassModel = process.env.CTI_CODEX_PASS_MODEL;
    process.env.CTI_CODEX_PASS_MODEL = 'true';
    const provider = new CodexProvider(new PendingPermissions(), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      sessionPolicy: 'fixed-confirm-recovery',
    });
    const captured: Array<Record<string, unknown>> = [];
    const completed = () => ({
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'new-policy-thread' };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })(),
      }),
    });
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: (options: Record<string, unknown>) => { captured.push(options); return completed(); },
      resumeThread: (_id: string, options: Record<string, unknown>) => { captured.push(options); return completed(); },
    };
    try {
      await collectStream(provider.streamChat({
        prompt: 'start', sessionId: 'start-policy', model: 'must-not-pass', workingDirectory: '/tmp/work',
        forceFreshThread: true,
      }));
      await collectStream(provider.streamChat({
        prompt: 'resume', sessionId: 'resume-policy', sdkSessionId: 'existing-policy-thread',
        model: 'must-not-pass', workingDirectory: '/tmp/work',
      }));
    } finally {
      if (originalPassModel === undefined) delete process.env.CTI_CODEX_PASS_MODEL;
      else process.env.CTI_CODEX_PASS_MODEL = originalPassModel;
    }
    assert.equal(captured.length, 2);
    for (const options of captured) {
      assert.deepEqual(options, {
        workingDirectory: '/tmp/work',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
      });
      assert.equal('model' in options, false);
      assert.equal('additionalDirectories' in options, false);
    }
  });

  it('keeps legacy approval mapping and omits sandbox/network when unconfigured', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    let captured: Record<string, unknown> = {};
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: (options: Record<string, unknown>) => {
        captured = options;
        return { runStreamed: () => ({ events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
        })() }) };
      },
    };
    await collectStream(provider.streamChat({ prompt: 'legacy', sessionId: 'legacy-policy', permissionMode: 'acceptEdits' }));
    assert.equal(captured.approvalPolicy, 'on-failure');
    assert.equal('sandboxMode' in captured, false);
    assert.equal('networkAccessEnabled' in captured, false);
  });

  it('persists a private audited envelope associated with the completed rollout', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-provider-audit-'));
    const sessionsRoot = path.join(root, 'sessions');
    const runtimeDirectory = path.join(root, 'runtime');
    const workdir = path.join(root, 'repo');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.mkdirSync(path.join(workdir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workdir, 'AGENTS.md'), 'audit rules\n');
    fs.writeFileSync(path.join(sessionsRoot, 'rollout-audit-thread.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'audit-thread', cli_version: '0.144.5' } }),
    ].join('\n') + '\n');
    const provider = new CodexProvider(new PendingPermissions(), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      sessionPolicy: 'fixed-confirm-recovery',
      audit: {
        runtimeDirectory,
        instanceConfigHash: 'config-hash',
        sessionsRoot,
        sdkVersion: '0.144.5',
      },
    });
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => ({ runStreamed: () => {
        fs.appendFileSync(path.join(sessionsRoot, 'rollout-audit-thread.jsonl'), [
          JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-effective' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'audit prompt' } }),
        ].join('\n') + '\n');
        return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'audit-thread' };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })() };
      } }),
    };
    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'audit prompt',
      sessionId: 'audit-session',
      workingDirectory: workdir,
      conversationHistory: [{ role: 'assistant', content: 'ordered history' }],
    })));
    const status = events
      .filter((event) => event.type === 'status')
      .map((event) => JSON.parse(event.data))
      .find((event) => event.call_envelope_hash);
    assert.match(status.call_envelope_hash, /^[a-f0-9]{64}$/);
    assert.equal(status.effective_model, 'gpt-effective');
    const auditNames = fs.readdirSync(path.join(runtimeDirectory, 'codex-call-envelopes'));
    assert.equal(auditNames.length, 1);
    assert.match(auditNames[0], new RegExp(`^${status.call_envelope_hash}-[a-f0-9]{16}\\.json$`));
    const auditFile = path.join(runtimeDirectory, 'codex-call-envelopes', auditNames[0]);
    assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
    const persisted = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
    assert.equal(persisted.hash, status.call_envelope_hash);
    assert.equal(persisted.threadId, 'audit-thread');
    assert.deepEqual(persisted.conversationHistory, [{ role: 'assistant', content: 'ordered history' }]);
    assert.equal(persisted.serverContext, 'unobservable');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the completed result once and commits the new thread when audit association is unavailable', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-provider-stale-audit-'));
    const sessionsRoot = path.join(root, 'sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, 'rollout-stale-thread.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'stale-thread', cli_version: '0.144.5' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-old' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'same prompt' } }),
    ].join('\n') + '\n');
    let sdkCallCount = 0;
    const provider = new CodexProvider(new PendingPermissions(), {
      sessionPolicy: 'fixed-confirm-recovery',
      audit: {
        runtimeDirectory: path.join(root, 'runtime'),
        instanceConfigHash: 'config-hash',
        sessionsRoot,
        sdkVersion: '0.144.5',
      },
    });
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => ({ runStreamed: () => {
        sdkCallCount += 1;
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'stale-thread' };
          yield { type: 'item.completed', item: { type: 'agent_message', id: 'answer', text: 'completed once' } };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })() };
      } }),
    };

    const first = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'same prompt', sessionId: 'audit-failure-session', forceFreshThread: true,
    })));
    // Model a client that retries only provider-level errors. Completed turns must not trigger it.
    if (first.some((event) => event.type === 'error')) {
      await collectStream(provider.streamChat({
        prompt: 'same prompt', sessionId: 'audit-failure-session', forceFreshThread: true,
      }));
    }
    assert.equal(sdkCallCount, 1);
    assert.equal(first.filter((event) => event.type === 'result').length, 1);
    assert.equal(first.some((event) => event.type === 'error'), false);
    assert.equal(first.some((event) => event.type === 'text' && event.data === 'completed once'), true);
    const statuses = first.filter((event) => event.type === 'status').map((event) => JSON.parse(event.data));
    assert.equal(statuses.some((status) => status.session_id === 'stale-thread'), true);
    assert.equal(statuses.some((status) => status.audit_status === 'unavailable'), true);
    assert.equal(statuses.some((status) => status.call_envelope_hash || status.effective_model), false);
    assert.equal((provider as any).threadIds.get('audit-failure-session'), 'stale-thread');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a completed turn successful when private audit persistence fails', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-provider-write-audit-'));
    const sessionsRoot = path.join(root, 'sessions');
    const rollout = path.join(sessionsRoot, 'rollout-write-thread.jsonl');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: 'write-thread', cli_version: '0.144.5' } })}\n`);
    const blockedRuntime = path.join(root, 'runtime-file');
    fs.writeFileSync(blockedRuntime, 'not a directory');
    const provider = new CodexProvider(new PendingPermissions(), {
      sessionPolicy: 'fixed-confirm-recovery',
      audit: { runtimeDirectory: blockedRuntime, instanceConfigHash: 'config-hash', sessionsRoot, sdkVersion: '0.144.5' },
    });
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => ({ runStreamed: () => {
        fs.appendFileSync(rollout, [
          JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-effective' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'write prompt' } }),
        ].join('\n') + '\n');
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'write-thread' };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })() };
      } }),
    };
    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'write prompt', sessionId: 'write-audit-session', forceFreshThread: true,
    })));
    assert.equal(events.filter((event) => event.type === 'result').length, 1);
    assert.equal(events.some((event) => event.type === 'error'), false);
    assert.equal(events.filter((event) => event.type === 'status').map((event) => JSON.parse(event.data)).some((status) => status.audit_status === 'unavailable'), true);
    assert.equal((provider as any).threadIds.get('write-audit-session'), 'write-thread');
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('emits error when SDK init fails', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Force ensureSDK to fail by setting sdk to a broken module
    (provider as any).sdk = { Codex: class { constructor() { throw new Error('Missing API key'); } } };
    (provider as any).codex = null;
    // Reset so ensureSDK re-runs the constructor
    (provider as any).sdk = null;
    // Override ensureSDK directly
    (provider as any).ensureSDK = async () => { throw new Error('SDK init failed: Missing API key'); };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Codex authentication failed.');
    assert.doesNotMatch(events.map((event) => event.data).join('\n'), /Missing API key/);
  });

  it('maps agent_message item to text SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-1',
      text: 'Hello from Codex!',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Hello from Codex!');
  });

  it('maps command_execution item to tool_use + tool_result', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'ls -la',
      aggregated_output: 'file1.txt\nfile2.txt',
      exit_code: 0,
      status: 'completed',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);

    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Bash');
    assert.equal(toolUse.input.command, 'ls -la');

    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.tool_use_id, 'cmd-1');
    assert.equal(toolResult.is_error, false);
  });

  it('marks non-zero exit code as error', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-2',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.is_error, true);
  });

  it('maps file_change item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'file_change',
      id: 'fc-1',
      changes: [
        { path: 'src/main.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Edit');
    const toolResult = JSON.parse(events[1].data);
    assert.ok(toolResult.content.includes('update: src/main.ts'));
  });

  it('maps mcp_tool_call item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-1',
      server: 'myserver',
      tool: 'search',
      arguments: { query: 'test' },
      result: { content: 'found 3 results' },
    });

    const events = parseSSEChunks(chunks);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'mcp__myserver__search');
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, 'found 3 results');
  });

  it('maps mcp_tool_call with structured_content', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-2',
      server: 'myserver',
      tool: 'getData',
      arguments: {},
      result: { structured_content: { items: [1, 2, 3] } },
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, JSON.stringify({ items: [1, 2, 3] }));
  });

  it('skips empty agent_message', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-2',
      text: '',
    });

    assert.equal(chunks.length, 0);
  });

  it('does not pass model by default and still attempts resume for persisted thread ids', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;
    let capturedResumeOptions: Record<string, unknown> | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string, options: Record<string, unknown>) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        capturedResumeOptions = options;
        return mockThread;
      },
      startThread: (_opts: Record<string, unknown>) => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'model-default-session',
      sdkSessionId: 'old-claude-session-id',
      model: 'claude-sonnet-4-20250514',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should attempt resume for the persisted thread id');
    assert.equal(resumedThreadId, 'old-claude-session-id');
    assert.equal(startCalls, 0, 'Should not eagerly start a fresh thread when resume is available');
    assert.ok(capturedResumeOptions, 'resumeThread options should be captured');
    assert.ok(!Object.prototype.hasOwnProperty.call(capturedResumeOptions!, 'model'), 'Model should not be forwarded by default');
  });

  it('reuses the in-memory Codex thread even when the stored model is Claude-like', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).threadIds.set('sticky-codex-session', 'codex-thread-123');
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        return mockThread;
      },
      startThread: () => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'continue previous thread',
      sessionId: 'sticky-codex-session',
      sdkSessionId: 'old-claude-session-id',
      model: 'claude-sonnet-4-20250514',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should resume the in-memory Codex thread');
    assert.equal(resumedThreadId, 'codex-thread-123');
    assert.equal(startCalls, 0, 'Should not start a fresh thread when an in-memory Codex thread exists');
  });

  it('passes model only when CTI_CODEX_PASS_MODEL=true', async () => {
    const old = process.env.CTI_CODEX_PASS_MODEL;
    process.env.CTI_CODEX_PASS_MODEL = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'model-forward-session',
        model: 'gpt-5-codex',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.model, 'gpt-5-codex');
    } finally {
      if (old === undefined) {
        delete process.env.CTI_CODEX_PASS_MODEL;
      } else {
        process.env.CTI_CODEX_PASS_MODEL = old;
      }
    }
  });

  it('passes skipGitRepoCheck only when CTI_CODEX_SKIP_GIT_REPO_CHECK=true', async () => {
    const old = process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
    process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'skip-git-check-session',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.skipGitRepoCheck, true);
    } finally {
      if (old === undefined) {
        delete process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
      } else {
        process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = old;
      }
    }
  });

  it('retries with fresh thread when resume fails before any events', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    const resumeThread = {
      runStreamed: async () => {
        throw new Error('resuming session with different model');
      },
    };
    const freshThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return resumeThread;
      },
      startThread: () => {
        startCalls += 1;
        return freshThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'retry test',
      sessionId: 'resume-retry-session',
      sdkSessionId: 'codex-old-thread-id',
      model: 'gpt-5-codex',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    const resultEvent = events.find(e => e.type === 'result');

    assert.equal(resumeCalls, 1, 'Should attempt resume once');
    assert.equal(startCalls, 1, 'Should fall back to a fresh thread');
    assert.ok(!errorEvent, 'Retry success should not emit error');
    assert.ok(resultEvent, 'Retry success should emit result');
  });

  it('fails closed without starting fresh when fixed recovery resume fails', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    let startCalls = 0;

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => ({
        runStreamed: async () => { throw new Error('no such session'); },
      }),
      startThread: () => {
        startCalls += 1;
        return { runStreamed: () => ({ events: (async function* () {})() }) };
      },
    };

    const chunks = await collectStream(provider.streamChat({
      prompt: 'resume marker',
      sessionId: 'fixed-recovery-session',
      sdkSessionId: 'old-thread-canary',
      sessionPolicy: 'fixed-confirm-recovery',
    }));
    const events = parseSSEChunks(chunks);
    assert.equal(startCalls, 0);
    assert.equal(events.filter((event) => event.type === 'recovery_required').length, 1);
    assert.doesNotMatch(events.map((event) => event.data).join('\n'), /old-thread-canary|no such session/);
  });

  it('keeps fixed recovery on the persisted binding instead of an in-memory candidate', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    (provider as any).threadIds.set('persisted-sot-session', 'uncommitted-memory-canary');
    let resumedId = '';
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (id: string) => {
        resumedId = id;
        return {
          runStreamed: () => ({
            events: (async function* () {
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
            })(),
          }),
        };
      },
    };

    await collectStream(provider.streamChat({
      prompt: 'resume',
      sessionId: 'persisted-sot-session',
      sdkSessionId: 'persisted-thread-canary',
      sessionPolicy: 'fixed-confirm-recovery',
    }));
    assert.equal(resumedId, 'persisted-thread-canary');
  });

  it('uses an armed one-time recovery attempt to start fresh exactly once', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    let resumeCalls = 0;
    let startCalls = 0;

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return { runStreamed: () => ({ events: (async function* () {})() }) };
      },
      startThread: () => {
        startCalls += 1;
        return {
          runStreamed: () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'new-thread-canary' };
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
            })(),
          }),
        };
      },
    };

    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'replacement marker',
      sessionId: 'fixed-recovery-session',
      sdkSessionId: 'old-thread-canary',
      sessionPolicy: 'fixed-confirm-recovery',
      forceFreshThread: true,
    })));

    assert.equal(resumeCalls, 0);
    assert.equal(startCalls, 1);
    assert.ok(events.some((event) => event.type === 'status'));
  });
});

// ── Image input building tests ──────────────────────────────

import fs from 'node:fs';

/** Helper: build a full FileAttachment object for tests. */
function makeFile(type: string, data: string, name = 'test-file') {
  return { id: `file-${Date.now()}`, name, type, size: data.length, data };
}

describe('CodexProvider image input', () => {
  it('builds local_image input array for text+image', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Mock the SDK so we can capture the input passed to runStreamed
    let capturedInput: unknown;
    let sdkReadSha256: string | undefined;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        const parts = input as Array<Record<string, string>>;
        sdkReadSha256 = crypto.createHash('sha256').update(fs.readFileSync(parts[1].path)).digest('hex');
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    // Use valid base64 (1x1 red PNG pixel)
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const stream = provider.streamChat({
      prompt: 'Describe this image',
      sessionId: 'img-session',
      files: [makeFile('image/png', pngBase64, 'test.png')],
    });

    await collectStream(stream);

    assert.ok(Array.isArray(capturedInput), 'Input should be an array for image input');
    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'Describe this image');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'), 'Temp file should have .png extension');
    assert.equal(
      sdkReadSha256,
      crypto.createHash('sha256').update(Buffer.from(pngBase64, 'base64')).digest('hex'),
      'The bytes available at the SDK boundary must match the attachment bytes recorded by audit hashing',
    );
  });

  it('passes plain string when no images attached', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Hello',
      sessionId: 'no-img-session',
    });

    await collectStream(stream);

    assert.equal(typeof capturedInput, 'string', 'Input should be a plain string without images');
    assert.equal(capturedInput, 'Hello');
  });

  it('builds local_image input with multiple images, ignoring non-image files', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Compare these',
      sessionId: 'multi-img-session',
      files: [
        makeFile('image/png', 'cG5n', 'a.png'),
        makeFile('image/jpeg', 'anBn', 'b.jpg'),
        makeFile('text/plain', 'dGV4dA==', 'c.txt'),
      ],
    });

    await collectStream(stream);

    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 3, 'Should have 1 text + 2 local_image parts (non-image file excluded)');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'));
    assert.equal(parts[2].type, 'local_image');
    assert.ok(parts[2].path.endsWith('.jpg'));
  });
});

// ── Error event tests ───────────────────────────────────────

describe('CodexProvider error events', () => {
  it('reads the real turn.failed error.message shape and emits a sanitized ordinary error', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded secret-turn-canary' } };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-1',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Codex request failed.');
    assert.doesNotMatch(events.map((event) => event.data).join('\n'), /secret-turn-canary/);
  });

  it('classifies a top-level network error without exposing its payload', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'error', message: 'Connection lost secret-network-canary' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-2',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Codex network request failed.');
    assert.doesNotMatch(events.map((event) => event.data).join('\n'), /secret-network-canary/);
  });

  it('falls back to default message when message field is absent', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-3',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent);
    assert.equal(errorEvent!.data, 'Turn failed');
  });

  for (const fixture of [
    { name: 'turn.failed missing resume', event: { type: 'turn.failed', error: { message: 'no such session secret-resume-canary' } } },
    { name: 'top-level corrupt resume', event: { type: 'error', message: 'failed to parse rollout: corrupt session secret-resume-canary' } },
  ]) {
    it(`maps only explicit ${fixture.name} faults to recovery_required`, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        resumeThread: () => ({
          runStreamed: () => ({ events: (async function* () { yield fixture.event; })() }),
        }),
      };
      const events = parseSSEChunks(await collectStream(provider.streamChat({
        prompt: 'resume',
        sessionId: `explicit-${fixture.name}`,
        sdkSessionId: 'old-thread-canary',
        sessionPolicy: 'fixed-confirm-recovery',
      })));
      assert.equal(events.filter((event) => event.type === 'recovery_required').length, 1);
      assert.equal(events.some((event) => event.type === 'error'), false);
      assert.doesNotMatch(events.map((event) => event.data).join('\n'), /secret-resume-canary|old-thread-canary/);
    });
  }

  it('maps the real 0.144.5 missing-rollout resume rejection to recovery_required', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => ({
        runStreamed: async () => {
          throw new Error(
            'Codex Exec exited with code 1: thread/resume failed: no rollout found for thread id secret-resume-canary (code -32600)',
          );
        },
      }),
    };
    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'resume',
      sessionId: 'real-missing-rollout',
      sdkSessionId: 'old-thread-canary',
      sessionPolicy: 'fixed-confirm-recovery',
    })));
    assert.equal(events.filter((event) => event.type === 'recovery_required').length, 1);
    assert.equal(events.some((event) => event.type === 'error'), false);
    assert.doesNotMatch(events.map((event) => event.data).join('\n'), /secret-resume-canary|old-thread-canary/);
  });

  it('keeps pre-event auth failures as sanitized ordinary errors under fixed policy', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => ({
        runStreamed: async () => { throw new Error('Authentication failed secret-auth-canary'); },
      }),
    };
    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'resume',
      sessionId: 'pre-event-auth',
      sdkSessionId: 'old-thread-canary',
      sessionPolicy: 'fixed-confirm-recovery',
    })));
    assert.equal(events.some((event) => event.type === 'recovery_required'), false);
    assert.equal(events.find((event) => event.type === 'error')?.data, 'Codex authentication failed.');
    assert.doesNotMatch(events.map((event) => event.data).join('\n'), /secret-auth-canary|old-thread-canary/);
  });

  for (const terminalEvent of [
    { type: 'turn.failed', error: { message: 'Runtime failed secret-candidate-canary' } },
    { type: 'error', message: 'Runtime failed secret-candidate-canary' },
  ]) {
    it(`does not commit thread.started before ${terminalEvent.type} and resumes the old binding afterward`, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());
      let resumedId = '';
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => ({
          runStreamed: () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'failed-fresh-thread-canary' };
              yield terminalEvent;
            })(),
          }),
        }),
        resumeThread: (id: string) => {
          resumedId = id;
          return {
            runStreamed: () => ({
              events: (async function* () {
                yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
              })(),
            }),
          };
        },
      };
      const failedEvents = parseSSEChunks(await collectStream(provider.streamChat({
        prompt: 'fresh',
        sessionId: `candidate-${terminalEvent.type}`,
        sdkSessionId: 'persisted-old-thread-canary',
        sessionPolicy: 'fixed-confirm-recovery',
        forceFreshThread: true,
      })));
      assert.equal(failedEvents.some((event) => event.type === 'status'), false);
      assert.equal((provider as any).threadIds.has(`candidate-${terminalEvent.type}`), false);

      await collectStream(provider.streamChat({
        prompt: 'restart path',
        sessionId: `candidate-${terminalEvent.type}`,
        sdkSessionId: 'persisted-old-thread-canary',
        sessionPolicy: 'fixed-confirm-recovery',
      }));
      assert.equal(resumedId, 'persisted-old-thread-canary');
    });
  }
});
