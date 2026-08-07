import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAuthError,
  classifyAuthError,
  SDKLLMProvider,
  isNonClaudeModel,
  parseCliMajorVersion,
  handleMessage,
  consumeSdkMessages,
  buildSubprocessEnv,
  shouldSuppressCompletedTransportExit,
} from '../llm-provider.js';
import type { StreamState } from '../llm-provider.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { sseEvent } from '../sse-utils.js';

// ── Helpers ──

/** Collect enqueued SSE strings from a fake controller. */
function makeFakeController() {
  const chunks: string[] = [];
  const controller = {
    enqueue(data: string) { chunks.push(data); },
    close() { /* no-op */ },
    error() { /* no-op */ },
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController<string>;
  return { controller, chunks };
}

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: unknown }> {
  return chunks.map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

function freshState(): StreamState {
  return {
    hasReceivedResult: false,
    hasReachedEndTurn: false,
    hasStreamedText: false,
    lastAssistantHadCompletableText: false,
    lastAssistantText: '',
  };
}

describe('buildSubprocessEnv secret isolation', () => {
  it('strips every secret-bearing CTI key while preserving non-secret CTI settings', () => {
    const saved = { ...process.env };
    try {
      process.env.CTI_ENV_ISOLATION = 'strict';
      process.env.CTI_RUNTIME = 'claude';
      process.env.CTI_FEISHU_APP_SECRET = 'feishu-secret-canary';
      process.env.CTI_TG_BOT_TOKEN = 'telegram-secret-canary';
      process.env.CTI_DISCORD_BOT_TOKEN = 'discord-secret-canary';
      process.env.CTI_QQ_APP_SECRET = 'qq-secret-canary';
      process.env.CTI_DEFAULT_MODE = 'code';
      process.env.CTI_FEISHU_APP_ID = 'cli_app_id_allowed';

      const env = buildSubprocessEnv();

      assert.equal(env.CTI_FEISHU_APP_SECRET, undefined);
      assert.equal(env.CTI_TG_BOT_TOKEN, undefined);
      assert.equal(env.CTI_DISCORD_BOT_TOKEN, undefined);
      assert.equal(env.CTI_QQ_APP_SECRET, undefined);
      assert.equal(env.CTI_DEFAULT_MODE, 'code');
      assert.equal(env.CTI_FEISHU_APP_ID, 'cli_app_id_allowed');
      assert.doesNotMatch(JSON.stringify(env), /secret-canary/);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('also strips secret-bearing CTI keys in inherit mode', () => {
    const savedMode = process.env.CTI_ENV_ISOLATION;
    const savedSecret = process.env.CTI_FEISHU_APP_SECRET;
    try {
      process.env.CTI_ENV_ISOLATION = 'inherit';
      process.env.CTI_FEISHU_APP_SECRET = 'inherit-secret-canary';
      assert.equal(buildSubprocessEnv().CTI_FEISHU_APP_SECRET, undefined);
    } finally {
      if (savedMode === undefined) delete process.env.CTI_ENV_ISOLATION;
      else process.env.CTI_ENV_ISOLATION = savedMode;
      if (savedSecret === undefined) delete process.env.CTI_FEISHU_APP_SECRET;
      else process.env.CTI_FEISHU_APP_SECRET = savedSecret;
    }
  });
});

// ── classifyAuthError ──

describe('classifyAuthError', () => {
  it('returns "cli" for local login errors', () => {
    assert.equal(classifyAuthError('Error: Not logged in'), 'cli');
    assert.equal(classifyAuthError('Please run /login'), 'cli');
    assert.equal(classifyAuthError('loggedIn:false'), 'cli');
  });

  it('returns "api" for remote credential errors', () => {
    assert.equal(classifyAuthError('Error: Unauthorized'), 'api');
    assert.equal(classifyAuthError('invalid API key provided'), 'api');
    assert.equal(classifyAuthError('authentication has failed'), 'api');
    assert.equal(classifyAuthError('HTTP 401 Unauthorized'), 'api');
    assert.equal(classifyAuthError('does not have access to Claude'), 'api');
  });

  it('returns "entitlement" when an organization disables Claude Code access', () => {
    assert.equal(
      classifyAuthError(
        'Your organization has disabled Claude subscription access for Claude Code · ' +
        'Use an Anthropic API key instead, or ask your admin to enable access',
      ),
      'entitlement',
    );
  });

  it('returns false for non-auth errors', () => {
    assert.equal(classifyAuthError('process exited with code 1'), false);
    assert.equal(classifyAuthError('ECONNREFUSED'), false);
    assert.equal(classifyAuthError(''), false);
  });

  it('returns false for local permission / generic 403 (not API auth)', () => {
    assert.equal(classifyAuthError('permission denied: /usr/local/bin'), false);
    assert.equal(classifyAuthError('HTTP 403 Forbidden'), false);
    assert.equal(classifyAuthError('EACCES: permission denied, open /etc/hosts'), false);
  });

  it('prefers "cli" when both patterns match', () => {
    // "Not logged in" should be cli even if "unauthorized" is also present
    assert.equal(classifyAuthError('Not logged in, unauthorized'), 'cli');
  });
});

// ── isAuthError (backwards compat) ──

describe('isAuthError', () => {
  it('detects "Not logged in" in error message', () => {
    assert.equal(isAuthError('Error: Not logged in · Please run /login'), true);
  });

  it('detects "Please run /login" in stderr', () => {
    assert.equal(isAuthError('some preamble\nPlease run /login\n'), true);
  });

  it('detects loggedIn: false in JSON output', () => {
    assert.equal(isAuthError('{"loggedIn": false, "user": null}'), true);
  });

  it('detects loggedIn:false without spaces', () => {
    assert.equal(isAuthError('loggedIn:false'), true);
  });

  it('detects "unauthorized" (case-insensitive)', () => {
    assert.equal(isAuthError('Error: Unauthorized access'), true);
  });

  it('detects "invalid api key"', () => {
    assert.equal(isAuthError('Error: invalid API key provided'), true);
    assert.equal(isAuthError('invalid api-key'), true);
  });

  it('detects "authentication failed"', () => {
    assert.equal(isAuthError('authentication has failed'), true);
  });

  it('detects HTTP 401', () => {
    assert.equal(isAuthError('HTTP error 401'), true);
    assert.equal(isAuthError('status: 401 Unauthorized'), true);
  });

  it('returns false for non-auth errors', () => {
    assert.equal(isAuthError('Claude Code process exited with code 1'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isAuthError(''), false);
  });

  it('returns false for generic network error', () => {
    assert.equal(isAuthError('ECONNREFUSED 127.0.0.1:443'), false);
  });

  it('returns false for HTTP 400 or 500', () => {
    assert.equal(isAuthError('HTTP error 400 Bad Request'), false);
    assert.equal(isAuthError('HTTP error 500 Internal Server Error'), false);
  });
});

// ── isNonClaudeModel ──

describe('isNonClaudeModel', () => {
  it('detects gpt- prefixed models', () => {
    assert.equal(isNonClaudeModel('gpt-5-codex'), true);
    assert.equal(isNonClaudeModel('gpt-4o'), true);
  });

  it('detects o1/o3 prefixed models', () => {
    assert.equal(isNonClaudeModel('o1-preview'), true);
    assert.equal(isNonClaudeModel('o3-mini'), true);
  });

  it('detects codex- prefixed models', () => {
    assert.equal(isNonClaudeModel('codex-mini'), true);
  });

  it('detects openai/ prefixed models', () => {
    assert.equal(isNonClaudeModel('openai/gpt-4o'), true);
  });

  it('returns false for claude models', () => {
    assert.equal(isNonClaudeModel('claude-opus-4-6'), false);
    assert.equal(isNonClaudeModel('claude-sonnet-4-6'), false);
  });

  it('returns false for undefined/empty', () => {
    assert.equal(isNonClaudeModel(undefined), false);
    assert.equal(isNonClaudeModel(''), false);
  });
});

// ── parseCliMajorVersion ──

describe('parseCliMajorVersion', () => {
  it('parses "2.3.1" to 2', () => {
    assert.equal(parseCliMajorVersion('2.3.1'), 2);
  });

  it('parses "claude 2.3.1" to 2', () => {
    assert.equal(parseCliMajorVersion('claude 2.3.1'), 2);
  });

  it('parses "1.0.17" to 1', () => {
    assert.equal(parseCliMajorVersion('1.0.17'), 1);
  });

  it('parses "@anthropic-ai/claude-code: 1.0.3" to 1', () => {
    assert.equal(parseCliMajorVersion('@anthropic-ai/claude-code: 1.0.3'), 1);
  });

  it('returns undefined for non-version strings', () => {
    assert.equal(parseCliMajorVersion('unknown'), undefined);
    assert.equal(parseCliMajorVersion(''), undefined);
  });
});

// ── handleMessage + StreamState ──

describe('handleMessage state tracking', () => {
  it('sets hasStreamedText on text_delta', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    } as any, controller, state);

    assert.equal(state.hasStreamedText, true);
    assert.equal(state.hasReceivedResult, false);
  });

  it('captures assistant text without emitting it', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'org has no access' }] },
    } as any, controller, state);

    assert.equal(state.lastAssistantText, 'org has no access');
    // No text SSE should be emitted — only tool_use blocks get forwarded
    const textEvents = chunks.filter(c => c.includes('"type":"text"') || c.includes('"type":"text"'));
    // Parse more carefully
    const hasTextEvent = chunks.some(c => {
      try { const d = JSON.parse(c.replace('data: ', '')); return d.type === 'text'; }
      catch { return false; }
    });
    assert.equal(hasTextEvent, false, 'assistant text should NOT be emitted directly');
  });

  it('records a final assistant end_turn', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    } as any, controller, state);

    assert.equal(state.hasReachedEndTurn, true);
  });

  it('sets hasReceivedResult on success result', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'result',
      subtype: 'success',
      session_id: 'sess1',
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 20 },
      total_cost_usd: 0.001,
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
  });

  it('sets hasReceivedResult on error result', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'result',
      subtype: 'error',
      errors: ['something went wrong'],
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
  });

  it('never emits an empty error when an error result has no errors array content', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'stop_sequence',
        content: [{
          type: 'text',
          text: 'Your organization has disabled Claude subscription access for Claude Code',
        }],
      },
    } as any, controller, state);
    handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [],
    } as any, controller, state);

    const errorEvents = chunks.map((chunk) => JSON.parse(chunk.slice('data: '.length)))
      .filter((event) => event.type === 'error');
    assert.equal(errorEvents.length, 1);
    assert.equal(typeof errorEvents[0].data, 'string');
    assert.ok(errorEvents[0].data.trim().length > 0, 'error body must not be empty');
    assert.match(errorEvents[0].data, /organization.*disabled Claude Code/i);
    assert.match(errorEvents[0].data, /re-enable|API key/i);
  });

  it('emits tool_use from assistant block', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/foo' } },
        ],
      },
    } as any, controller, state);

    assert.equal(state.lastAssistantText, 'Let me check');
    assert.equal(chunks.length, 1); // only tool_use, no text
    assert.ok(chunks[0].includes('tool_use'));
  });
});

describe('SDK end_turn completion fallback', () => {
  it('does not arm on a real-shaped thinking-only end_turn record before delayed text', async () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: {
          id: 'msg-real-shaped-thinking-gap',
          stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: '', signature: '' }],
        },
      } as any;
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'delayed final text' } },
      } as SDKMessage;
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: {
          id: 'msg-real-shaped-thinking-gap',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'delayed final text' }],
        },
      } as any;
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'message_stop' },
      } as SDKMessage;
      yield {
        type: 'result', subtype: 'success', session_id: 'session-thinking-gap', is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
      } as any;
    })();

    await consumeSdkMessages(messages, controller, state, abortController, 5);

    assert.equal(abortController.signal.aborted, false);
    assert.equal(state.hasReceivedResult, true);
    assert.match(chunks.join('\n'), /delayed final text/);
  });

  it('does not arm a thinking-only terminal record from earlier narration in the same turn', async () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check…' } },
      } as SDKMessage;
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: {
          id: 'msg-earlier-narration',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me check…' },
            { type: 'tool_use', id: 'tool-earlier', name: 'Read', input: { file_path: '/tmp/example' } },
          ],
        },
      } as any;
      yield {
        type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-earlier', content: 'done' }] },
      } as any;
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: {
          id: 'msg-final-after-tool',
          stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: '', signature: '' }],
        },
      } as any;
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Actual final answer' } },
      } as SDKMessage;
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: {
          id: 'msg-final-after-tool',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Actual final answer' }],
        },
      } as any;
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'message_stop' },
      } as SDKMessage;
      yield {
        type: 'result', subtype: 'success', session_id: 'session-intra-turn-gap', is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
      } as any;
    })();

    await consumeSdkMessages(messages, controller, state, abortController, 5);

    assert.equal(abortController.signal.aborted, false);
    assert.equal(state.hasReceivedResult, true);
    assert.equal(state.lastAssistantText, 'Actual final answer');
    assert.match(chunks.join('\n'), /Actual final answer/);
  });

  it('arms from the pinned SDK message_stop signal when assistant stop_reason is null', async () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'real terminal text' } },
      } as SDKMessage;
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: { stop_reason: null, content: [{ type: 'text', text: 'real terminal text' }] },
      } as any;
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'message_stop' },
      } as SDKMessage;
      await new Promise<never>(() => undefined);
    })();

    const outcome = await Promise.race([
      consumeSdkMessages(messages, controller, state, abortController, 5).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 80)),
    ]);

    assert.equal(outcome, 'completed');
    assert.equal(abortController.signal.aborted, true);
    assert.equal(chunks.filter((chunk) => chunk.includes('real terminal text')).length, 1);
  });

  it('finishes a streamed response when the SDK never emits its result', async () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

    const messages = (async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'completed text' } },
      } as SDKMessage;
      yield {
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'completed text' }] },
      } as SDKMessage;
      await new Promise<never>(() => undefined);
    })();

    try {
      await consumeSdkMessages(messages, controller, state, abortController, 5);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(abortController.signal.aborted, true);
    assert.equal(state.hasReceivedResult, false);
    assert.equal(chunks.filter((chunk) => chunk.includes('completed text')).length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /did not emit a result.*after a top-level terminal signal/);
  });

  it('does not arm the result deadline from a subagent end_turn', async () => {
    const { controller } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'assistant',
        parent_tool_use_id: 'task-tool-use',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'subagent answer' }] },
      } as any;
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'top-level answer' }] },
      } as any;
      yield {
        type: 'result', subtype: 'success', session_id: 'session-top', is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
      } as any;
    })();

    await consumeSdkMessages(messages, controller, state, abortController, 5);

    assert.equal(abortController.signal.aborted, false);
    assert.equal(state.hasReceivedResult, true);
    assert.equal(state.lastAssistantText, 'top-level answer');
  });

  it('forwards subagent tool progress without accepting subagent text as the answer', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant', parent_tool_use_id: 'agent-parent',
      message: {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'private child narration' },
          { type: 'tool_use', id: 'child-tool', name: 'Read', input: { file_path: '/tmp/example' } },
        ],
      },
    } as any, controller, state);
    handleMessage({
      type: 'user', parent_tool_use_id: 'agent-parent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'child-tool', content: 'read complete', is_error: false }],
      },
    } as any, controller, state);

    const rendered = chunks.join('\n');
    assert.match(rendered, /"type":"tool_use"/);
    assert.match(rendered, /"type":"tool_result"/);
    assert.doesNotMatch(rendered, /private child narration/);
    assert.equal(state.lastAssistantText, '');
    assert.equal(state.hasReachedEndTurn, false);
  });

  it('does not arm from the message_stop that closes a top-level tool-use turn', async () => {
    const { controller } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: {
          stop_reason: null,
          content: [{ type: 'tool_use', id: 'agent-tool', name: 'Agent', input: {} }],
        },
      } as any;
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'message_stop' },
      } as SDKMessage;
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield {
        type: 'user', parent_tool_use_id: 'agent-tool',
        message: { content: [{ type: 'text', text: 'child done' }] },
      } as any;
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'message_start' },
      } as SDKMessage;
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: { stop_reason: null, content: [{ type: 'text', text: 'parent final' }] },
      } as any;
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'message_stop' },
      } as SDKMessage;
      yield {
        type: 'result', subtype: 'success', session_id: 'session-agent', is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
      } as any;
    })();

    await consumeSdkMessages(messages, controller, state, abortController, 5);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(state.hasReceivedResult, true);
    assert.equal(state.lastAssistantText, 'parent final');
  });

  it('disarms a top-level end_turn when later non-result activity resumes', async () => {
    const { controller } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'premature terminal' }] },
      } as SDKMessage;
      yield {
        type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'resumed' } },
      } as SDKMessage;
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield {
        type: 'result', subtype: 'success', session_id: 'session-resumed', is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
      } as any;
    })();

    await consumeSdkMessages(messages, controller, state, abortController, 5);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(state.hasReceivedResult, true);
  });

  it('uses only the top-level final assistant text for a no-delta fallback', async () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'assistant', parent_tool_use_id: 'task-tool-use',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'subagent intermediate' }] },
      } as SDKMessage;
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'top-level final' }] },
      } as SDKMessage;
      await new Promise<never>(() => undefined);
    })();

    await consumeSdkMessages(messages, controller, state, abortController, 5);
    const rendered = chunks.join('\n');
    assert.match(rendered, /top-level final/);
    assert.doesNotMatch(rendered, /subagent intermediate/);
  });

  it('closes the SDK iterator on the result-timeout path', async () => {
    const { controller } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    let nextCount = 0;
    let returnCalled = false;
    const messages: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCount += 1;
            if (nextCount === 1) {
              return {
                done: false,
                value: {
                  type: 'assistant', parent_tool_use_id: null,
                  message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
                } as SDKMessage,
              };
            }
            return new Promise<IteratorResult<SDKMessage>>(() => undefined);
          },
          async return() {
            returnCalled = true;
            return { done: true, value: undefined };
          },
        };
      },
    };

    await consumeSdkMessages(messages, controller, state, abortController, 5);
    assert.equal(returnCalled, true);
  });

  it('processes an error result that arrives just after the result deadline', async () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    const messages = (async function* () {
      yield {
        type: 'assistant', parent_tool_use_id: null,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'candidate answer' }] },
      } as SDKMessage;
      await new Promise((resolve) => setTimeout(resolve, 8));
      yield {
        type: 'result', subtype: 'error_during_execution', is_error: true,
        errors: ['late terminal error'],
      } as SDKMessage;
    })();

    await consumeSdkMessages(messages, controller, state, abortController, 5);
    assert.equal(state.hasReceivedResult, true);
    assert.match(chunks.join('\n'), /late terminal error/);
    assert.doesNotMatch(chunks.join('\n'), /candidate answer/);
  });

  it('returns immediately after a drained result instead of reading the aborted iterator again', async () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    let nextCount = 0;
    const messages: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKMessage>> {
            nextCount += 1;
            if (nextCount === 1) {
              return {
                done: false,
                value: {
                  type: 'assistant', parent_tool_use_id: null,
                  message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'candidate' }] },
                } as any,
              };
            }
            if (nextCount === 2) {
              await new Promise((resolve) => setTimeout(resolve, 8));
              return {
                done: false,
                value: {
                  type: 'result', subtype: 'success', session_id: 'session-drained', is_error: false,
                  usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
                } as any,
              };
            }
            throw new Error('iterator read after terminal result');
          },
        };
      },
    };

    await consumeSdkMessages(messages, controller, state, abortController, 5);

    assert.equal(nextCount, 2);
    assert.equal(state.hasReceivedResult, true);
    assert.doesNotMatch(chunks.join('\n'), /iterator read after terminal result/);
  });

  it('lets a normal result reach iterator completion and runs iterator cleanup', async () => {
    const { controller } = makeFakeController();
    const state = freshState();
    const abortController = new AbortController();
    let nextCount = 0;
    let doneObserved = false;
    let returnCalled = false;
    const messages: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKMessage>> {
            nextCount += 1;
            if (nextCount === 1) {
              return {
                done: false,
                value: {
                  type: 'result', subtype: 'success', session_id: 'session-normal-result', is_error: false,
                  usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
                } as any,
              };
            }
            doneObserved = true;
            return { done: true, value: undefined };
          },
          async return() {
            returnCalled = true;
            return { done: true, value: undefined };
          },
        };
      },
    };

    await consumeSdkMessages(messages, controller, state, abortController, 5);

    assert.equal(state.hasReceivedResult, true);
    assert.equal(doneObserved, true);
    assert.equal(returnCalled, true);
  });
});

describe('catch block error suppression logic', () => {
  // These tests verify the logic expressed in the catch block by testing
  // the state conditions that drive its behavior.

  it('result received + exit code → should suppress (transport noise)', () => {
    const state: StreamState = {
      hasReceivedResult: true,
      hasReceivedSuccessfulResult: true,
      hasReachedEndTurn: false,
      hasStreamedText: true,
      lastAssistantText: '',
    };
    const errorMsg = 'Claude Code process exited with code 1';

    assert.equal(shouldSuppressCompletedTransportExit(state, errorMsg), true);
  });

  it('partial text + exit code (no result) → should NOT suppress (real crash)', () => {
    const state: StreamState = { hasReceivedResult: false, hasReachedEndTurn: false, hasStreamedText: true, lastAssistantText: '' };
    const errorMsg = 'Claude Code process exited with code 1';
    assert.equal(
      shouldSuppressCompletedTransportExit(state, errorMsg),
      false,
      'partial output crash must NOT be suppressed',
    );
  });

  it('assistant text with recognised auth error → should surface as business error', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasReachedEndTurn: false,
      hasStreamedText: false,
      lastAssistantText: 'Your organization does not have access to Claude',
    };

    // Case 2 condition: lastAssistantText must be a recognised auth/access error
    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    assert.equal(shouldSurface, true);
  });

  it('assistant text with normal content + crash → should NOT surface as business error', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasReachedEndTurn: false,
      hasStreamedText: false,
      lastAssistantText: 'Here is my analysis of the code...',
    };

    // Normal response text is not a recognised auth error — must fall through to error handling
    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    assert.equal(shouldSurface, false, 'normal assistant text must NOT be treated as business error');
  });

  it('no streaming + no assistant text → should show full error', () => {
    const state: StreamState = { hasReceivedResult: false, hasReachedEndTurn: false, hasStreamedText: false, lastAssistantText: '' };

    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    const shouldSuppress = state.hasReceivedResult;
    assert.equal(shouldSurface, false);
    assert.equal(shouldSuppress, false);
    // This means the catch block falls through to building the full error message
  });

  it('streaming + result + exit code → should suppress', () => {
    // Normal successful flow that ends with exit code 0 won't throw,
    // but some edge cases might. Verify suppression.
    const state: StreamState = {
      hasReceivedResult: true,
      hasReceivedSuccessfulResult: true,
      hasReachedEndTurn: false,
      hasStreamedText: true,
      lastAssistantText: 'some response',
    };

    assert.equal(
      shouldSuppressCompletedTransportExit(state, 'Claude Code process exited with code 1'),
      true,
    );
  });

  it('top-level end_turn + transport exit → should complete from the terminal response', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasReachedEndTurn: true,
      hasStreamedText: true,
      lastAssistantHadCompletableText: true,
      lastAssistantText: 'complete response',
    };
    assert.equal(
      shouldSuppressCompletedTransportExit(state, 'Claude Code process exited with code 1'),
      true,
    );
  });

  it('empty terminal candidate + transport exit → should surface the failure', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasReachedEndTurn: true,
      hasStreamedText: false,
      lastAssistantHadCompletableText: false,
      lastAssistantText: '',
    };
    assert.equal(
      shouldSuppressCompletedTransportExit(state, 'Claude Code process exited with code 1'),
      false,
    );
  });

  it('error result without delivered answer + transport exit → should not suppress', () => {
    const { controller } = makeFakeController();
    const state = freshState();
    handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'stop_sequence',
        content: [{
          type: 'text',
          text: 'Your organization has disabled Claude subscription access for Claude Code',
        }],
      },
    } as any, controller, state);
    handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [],
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true, 'the SDK error result sets the first old disjunct');
    assert.equal(state.hasReachedEndTurn, false, 'stop_sequence cannot set the end_turn disjunct');
    assert.equal(state.hasStreamedText, false, 'no answer was delivered');
    assert.equal(
      shouldSuppressCompletedTransportExit(state, 'Claude Code process exited with code 1'),
      false,
      'a failed result without an answer is not completed transport noise',
    );
  });

  it('error result invalidates an earlier end_turn candidate before transport exit', () => {
    const { controller } = makeFakeController();
    const state = freshState();
    handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'candidate answer' }],
      },
    } as any, controller, state);
    handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['late terminal error'],
    } as any, controller, state);

    assert.equal(state.hasReachedEndTurn, false);
    assert.equal(state.lastAssistantHadCompletableText, false);
    assert.equal(
      shouldSuppressCompletedTransportExit(state, 'Claude Code process exited with code 1'),
      false,
    );
  });
});

describe('SDKLLMProvider user-visible failures', () => {
  const pendingPerms = {
    waitFor: async () => ({ behavior: 'deny' }),
    waitForQuestion: async () => ({ behavior: 'deny' }),
  } as any;

  const params = {
    prompt: 'What time is it?',
    workingDirectory: process.cwd(),
    permissionMode: 'acceptEdits',
  } as any;

  it('surfaces an actionable entitlement error for the incident SDK sequence', async () => {
    const queryFn = () => (async function* () {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          stop_reason: 'stop_sequence',
          content: [{
            type: 'text',
            text: 'Your organization has disabled Claude subscription access for Claude Code · ' +
              'Use an Anthropic API key instead, or ask your admin to enable access',
          }],
        },
      } as any;
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
      } as any;
      throw new Error('Claude Code process exited with code 1');
    })() as any;
    const provider = new SDKLLMProvider(pendingPerms, undefined, false, queryFn as any);

    const events = parseSSEChunks(await collectStream(provider.streamChat(params)));
    const errors = events.filter((event) => event.type === 'error')
      .map((event) => String(event.data));

    assert.equal(errors.length, 1, 'the failed turn should have one clear terminal error');
    assert.ok(errors[0].trim().length > 0, 'the terminal error body must not be empty');
    assert.match(errors[0], /organization.*disabled Claude Code/i);
    assert.match(errors[0], /re-enable|API key/i);
  });

  it('uses an actionable generic fallback when the provider throws an empty error', async () => {
    const queryFn = () => (async function* () {
      throw new Error('');
    })() as any;
    const provider = new SDKLLMProvider(pendingPerms, undefined, false, queryFn as any);

    const events = parseSSEChunks(await collectStream(provider.streamChat(params)));
    const errors = events.filter((event) => event.type === 'error')
      .map((event) => String(event.data));

    assert.equal(errors.length, 1);
    assert.ok(errors[0].trim().length > 0, 'the terminal error body must not be empty');
    assert.match(errors[0], /could not complete this task/i);
    assert.match(errors[0], /operator|doctor|log/i);
  });

  it('does not emit a cached answer after an error result invalidates end_turn', async () => {
    const queryFn = () => (async function* () {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'candidate answer' }],
        },
      } as any;
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['late terminal error'],
      } as any;
      throw new Error('Claude Code process exited with code 1');
    })() as any;
    const provider = new SDKLLMProvider(pendingPerms, undefined, false, queryFn as any);

    const events = parseSSEChunks(await collectStream(provider.streamChat(params)));
    assert.deepEqual(events.filter((event) => event.type === 'text'), []);
    assert.deepEqual(
      events.filter((event) => event.type === 'error').map((event) => event.data),
      ['late terminal error'],
    );
  });

  it('treats an all-whitespace structured error array as missing diagnostics', async () => {
    const queryFn = () => (async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['', '   '],
      } as any;
    })() as any;
    const provider = new SDKLLMProvider(pendingPerms, undefined, false, queryFn as any);

    const events = parseSSEChunks(await collectStream(provider.streamChat(params)));
    const errors = events.filter((event) => event.type === 'error').map((event) => String(event.data));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /provider returned no diagnostic/i);
  });

  it('uses a stderr-only entitlement diagnostic when structured errors are empty', async () => {
    const queryFn = ({ options }: any) => (async function* () {
      options.stderr(
        'Your organization has disabled Claude subscription access for Claude Code · ' +
        'Use an Anthropic API key instead, or ask your admin to enable access',
      );
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
      } as any;
      throw new Error('Claude Code process exited with code 1');
    })() as any;
    const provider = new SDKLLMProvider(pendingPerms, undefined, false, queryFn as any);

    const events = parseSSEChunks(await collectStream(provider.streamChat(params)));
    const errors = events.filter((event) => event.type === 'error').map((event) => String(event.data));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /organization.*disabled Claude Code/i);
    assert.match(errors[0], /re-enable|API key/i);
  });
});
