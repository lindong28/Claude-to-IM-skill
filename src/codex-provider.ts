/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApprovalMode,
  SandboxMode,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';
import {
  associateCodexRollout,
  buildAuditedCallEnvelope,
  captureCodexRolloutCheckpoint,
  hashRepositoryInstructionSnapshot,
  persistCodexCallEnvelope,
} from './codex-audit.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

export interface CodexProviderOptions {
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  networkAccessEnabled?: boolean;
  sessionPolicy?: 'fixed-confirm-recovery';
  audit?: {
    runtimeDirectory: string;
    instanceConfigHash: string;
    sessionsRoot?: string;
    sdkVersion?: string;
  };
}

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): ApprovalMode {
  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

function installedCodexSdkVersion(): string {
  try {
    const packageFile = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'node_modules',
      '@openai',
      'codex-sdk',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function isExplicitResumeFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('session') && lower.includes('not found')) ||
    (lower.includes('no rollout found') && lower.includes('thread id')) ||
    (lower.includes('failed to parse') && lower.includes('rollout')) ||
    ((lower.includes('corrupt') || lower.includes('incompatible'))
      && (lower.includes('session') || lower.includes('rollout')))
  );
}

function eventErrorMessage(event: ThreadEvent): string | undefined {
  if (event.type === 'turn.failed') return event.error?.message;
  if (event.type === 'error') return event.message;
  return undefined;
}

function sanitizedCodexError(message: string | undefined, fallback: string): string {
  if (!message) return fallback;
  const lower = message.toLowerCase();
  if (/auth|unauthorized|api[ _-]?key|not logged in|login/.test(lower)) {
    return 'Codex authentication failed.';
  }
  if (/network|connection|econn|timed? ?out|dns|socket/.test(lower)) {
    return 'Codex network request failed.';
  }
  if (/working directory|\bcwd\b|not a directory|no such file or directory/.test(lower)) {
    return 'Codex working directory is unavailable.';
  }
  return 'Codex request failed.';
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(
    private pendingPerms: PendingPermissions,
    private options: CodexProviderOptions = {},
  ) {}

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const fixedRecovery = (self.options.sessionPolicy || params.sessionPolicy) === 'fixed-confirm-recovery';
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            let savedThreadId = params.forceFreshThread
              ? undefined
              : (fixedRecovery
                ? (params.sdkSessionId || undefined)
                : (inMemoryThreadId || params.sdkSessionId || undefined));

            const approvalPolicy = self.options.approvalPolicy || toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex() && !fixedRecovery;

            const threadOptions: ThreadOptions = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              ...(self.options.sandboxMode ? { sandboxMode: self.options.sandboxMode } : {}),
              approvalPolicy,
              ...(self.options.networkAccessEnabled !== undefined
                ? { networkAccessEnabled: self.options.networkAccessEnabled }
                : {}),
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            const auditSessionsRoot = self.options.audit
              ? (self.options.audit.sessionsRoot
                || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'))
              : undefined;

            let retryFresh = false;

            attemptLoop: while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  if (isExplicitResumeFailure(message) && fixedRecovery) {
                    controller.enqueue(sseEvent('recovery_required', 'resume unavailable'));
                    controller.close();
                    return;
                  }
                  if (isExplicitResumeFailure(message) && !retryFresh) {
                    savedThreadId = undefined;
                    retryFresh = true;
                    continue;
                  }
                  throw err;
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              let candidateThreadId: string | undefined;
              try {
                const auditCheckpoint = auditSessionsRoot
                  ? captureCodexRolloutCheckpoint(auditSessionsRoot)
                  : undefined;
                const { events } = await thread.runStreamed(input);

                for await (const rawEvent of events) {
                  const event = rawEvent as ThreadEvent;
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      candidateThreadId = event.thread_id;
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      self.handleCompletedItem(controller, item);
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = candidateThreadId || savedThreadId;
                      if (threadId && self.options.audit && auditSessionsRoot && auditCheckpoint) {
                        try {
                          const workingDirectory = params.workingDirectory || process.cwd();
                          const association = associateCodexRollout(
                            auditSessionsRoot,
                            threadId,
                            params.prompt,
                            auditCheckpoint,
                          );
                          if (!association) throw new Error('rollout association unavailable');
                          const audited = buildAuditedCallEnvelope({
                            effectiveModel: association.effectiveModel,
                            sdkVersion: self.options.audit.sdkVersion || installedCodexSdkVersion(),
                            cliVersion: association.cliVersion,
                            threadId,
                            input: params.prompt,
                            conversationHistory: params.conversationHistory || [],
                            attachments: params.files || [],
                            workingDirectory,
                            repoInstructionSnapshotHash: hashRepositoryInstructionSnapshot(workingDirectory),
                            ...(self.options.sandboxMode ? { sandboxMode: self.options.sandboxMode } : {}),
                            approvalPolicy,
                            ...(self.options.networkAccessEnabled !== undefined
                              ? { networkAccessEnabled: self.options.networkAccessEnabled }
                              : {}),
                            instanceConfigHash: self.options.audit.instanceConfigHash,
                            rolloutAssociation: association,
                          });
                          persistCodexCallEnvelope(self.options.audit.runtimeDirectory, audited);
                          controller.enqueue(sseEvent('status', {
                            call_envelope_hash: audited.hash,
                            effective_model: association.effectiveModel,
                          }));
                        } catch {
                          console.warn('[codex-provider] Audit evidence unavailable for completed turn.');
                          controller.enqueue(sseEvent('status', { audit_status: 'unavailable' }));
                        }
                      }
                      if (threadId) {
                        self.threadIds.set(params.sessionId, threadId);
                        controller.enqueue(sseEvent('status', { session_id: threadId }));
                      }

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      break attemptLoop;
                    }

                    case 'turn.failed':
                    case 'error': {
                      const message = eventErrorMessage(event);
                      if (savedThreadId && isExplicitResumeFailure(message || '')) {
                        if (fixedRecovery) {
                          controller.enqueue(sseEvent('recovery_required', 'resume unavailable'));
                          controller.close();
                          return;
                        }
                        if (!retryFresh) {
                          savedThreadId = undefined;
                          retryFresh = true;
                          continue attemptLoop;
                        }
                      }
                      controller.enqueue(sseEvent(
                        'error',
                        sanitizedCodexError(message, event.type === 'turn.failed' ? 'Turn failed' : 'Thread error'),
                      ));
                      break attemptLoop;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && fixedRecovery && isExplicitResumeFailure(message)) {
                  controller.enqueue(sseEvent('recovery_required', 'resume unavailable'));
                  controller.close();
                  return;
                }
                if (savedThreadId && !retryFresh && !sawAnyEvent && isExplicitResumeFailure(message)) {
                  console.warn('[codex-provider] Resume state unavailable; retrying with a fresh thread');
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const safeMessage = sanitizedCodexError(message, 'Codex request failed.');
            console.error('[codex-provider] Error:', safeMessage);
            try {
              controller.enqueue(sseEvent('error', safeMessage));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
