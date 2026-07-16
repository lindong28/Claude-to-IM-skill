import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type { ApprovalMode, SandboxMode } from '@openai/codex-sdk';

import { atomicWritePrivateFile, ensurePrivateDirectory } from './private-files.js';

export interface CodexRolloutAssociation {
  effectiveModel: string;
  cliVersion: string;
  turnOrdinal: number;
  rolloutSha256: string;
}

export interface CodexRolloutCheckpoint {
  fileSizes: Record<string, number>;
  fileIdentities?: Record<string, string>;
}

interface AuditedAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  contentSha256: string;
  filePath?: string;
}

interface AuditedToolFileInput {
  type: 'local_image';
  contentSha256: string;
  sourceFilePath?: string;
}

export interface CodexCallEnvelope {
  effectiveModel: string;
  sdkVersion: string;
  cliVersion: string;
  threadId: string;
  input: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  attachments: AuditedAttachment[];
  toolFileInputs: AuditedToolFileInput[];
  workingDirectory: string;
  repoInstructionSnapshotHash: string;
  sandboxMode?: SandboxMode;
  approvalPolicy: ApprovalMode;
  networkAccessEnabled?: boolean;
  instanceConfigHash: string;
  rolloutAssociation: CodexRolloutAssociation;
  serverContext: 'unobservable';
}

type EnvelopeInput = Omit<CodexCallEnvelope, 'attachments' | 'toolFileInputs' | 'serverContext'> & {
  attachments?: Array<FileAttachment | AuditedAttachment>;
  toolFileInputs?: AuditedToolFileInput[];
  serverContext?: 'unobservable';
};

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function auditAttachment(file: FileAttachment | AuditedAttachment): AuditedAttachment {
  if ('contentSha256' in file) return { ...file };
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    contentSha256: sha256(Buffer.from(file.data, 'base64')),
    ...(file.filePath ? { filePath: file.filePath } : {}),
  };
}

export function buildAuditedCallEnvelope(input: EnvelopeInput): {
  envelope: CodexCallEnvelope;
  hash: string;
} {
  const attachments = (input.attachments || []).map(auditAttachment);
  const envelope: CodexCallEnvelope = {
    effectiveModel: input.effectiveModel,
    sdkVersion: input.sdkVersion,
    cliVersion: input.cliVersion,
    threadId: input.threadId,
    input: input.input,
    conversationHistory: input.conversationHistory,
    attachments,
    toolFileInputs: input.toolFileInputs || attachments
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({
        type: 'local_image' as const,
        contentSha256: file.contentSha256,
        ...(file.filePath ? { sourceFilePath: file.filePath } : {}),
      })),
    workingDirectory: input.workingDirectory,
    repoInstructionSnapshotHash: input.repoInstructionSnapshotHash,
    ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
    approvalPolicy: input.approvalPolicy,
    ...(input.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: input.networkAccessEnabled }
      : {}),
    instanceConfigHash: input.instanceConfigHash,
    rolloutAssociation: input.rolloutAssociation,
    serverContext: 'unobservable',
  };
  const { rolloutAssociation: _associationEvidence, serverContext: _serverContext, ...callInputs } = envelope;
  return { envelope, hash: sha256(canonicalJson(callInputs)) };
}

function repositoryRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export function hashRepositoryInstructionSnapshot(workingDirectory: string): string {
  const root = repositoryRoot(workingDirectory);
  const cwd = path.resolve(workingDirectory);
  const directories: string[] = [];
  let current = cwd;
  while (current.startsWith(`${root}${path.sep}`) || current === root) {
    directories.push(current);
    if (current === root) break;
    current = path.dirname(current);
  }
  directories.reverse();

  const files: Array<{ path: string; content: string }> = [];
  for (const directory of directories) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(directory, name);
      try {
        if (fs.statSync(file).isFile()) {
          files.push({ path: path.relative(root, file) || name, content: fs.readFileSync(file, 'utf8') });
        }
      } catch { /* absent or unreadable candidates are not observable */ }
    }
  }
  return sha256(canonicalJson(files));
}

function listJsonlFiles(root: string): string[] {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(target);
    }
  }
  return output.sort();
}

export function captureCodexRolloutCheckpoint(sessionsRoot: string): CodexRolloutCheckpoint {
  const fileSizes: Record<string, number> = {};
  const fileIdentities: Record<string, string> = {};
  for (const file of listJsonlFiles(sessionsRoot)) {
    try {
      const stat = fs.statSync(file);
      fileSizes[file] = stat.size;
      fileIdentities[file] = `${stat.dev}:${stat.ino}`;
    } catch { /* a racing file cannot be part of the pre-call checkpoint */ }
  }
  return { fileSizes, fileIdentities };
}

function parseJsonlStrict(content: Buffer): Array<Record<string, unknown>> | undefined {
  if (content.length === 0) return [];
  if (content[content.length - 1] !== 0x0a) return undefined;
  const records: Array<Record<string, unknown>> = [];
  for (const line of content.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      records.push(value as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }
  return records;
}

export function associateCodexRollout(
  sessionsRoot: string,
  threadId: string,
  exactInput: string,
  checkpoint: CodexRolloutCheckpoint,
): CodexRolloutAssociation | undefined {
  const allFiles = listJsonlFiles(sessionsRoot);
  const namedCandidates = allFiles.filter((file) => path.basename(file).includes(threadId));
  const matches: CodexRolloutAssociation[] = [];
  for (const file of namedCandidates.length > 0 ? namedCandidates : allFiles) {
    let content: Buffer;
    try { content = fs.readFileSync(file); } catch { continue; }
    const previousSize = checkpoint.fileSizes[file] ?? 0;
    if (previousSize > content.length) continue;
    if (previousSize > 0 && content[previousSize - 1] !== 0x0a) continue;
    const previousIdentity = checkpoint.fileIdentities?.[file];
    if (previousIdentity) {
      let currentIdentity: string;
      try {
        const stat = fs.statSync(file);
        currentIdentity = `${stat.dev}:${stat.ino}`;
      } catch { continue; }
      if (currentIdentity !== previousIdentity) continue;
    }

    const records = parseJsonlStrict(content);
    const appended = parseJsonlStrict(content.subarray(previousSize));
    if (!records || !appended || appended.length === 0) continue;
    const session = records.find((record) => {
      const payload = record.payload as Record<string, unknown> | undefined;
      return record.type === 'session_meta' && payload?.id === threadId;
    });
    if (!session) continue;

    const sessionPayload = session.payload as Record<string, unknown>;
    const priorRecords = parseJsonlStrict(content.subarray(0, previousSize));
    if (!priorRecords) continue;
    const priorTurnCount = priorRecords.filter((record) => record.type === 'turn_context').length;
    const newTurnContexts = appended.filter((record) => record.type === 'turn_context');
    if (newTurnContexts.length !== 1) continue;
    const turnContextIndex = appended.indexOf(newTurnContexts[0]);
    const turnPayload = newTurnContexts[0].payload as Record<string, unknown> | undefined;
    if (typeof turnPayload?.model !== 'string' || !turnPayload.model) continue;

    const newUserMessages: Array<{ index: number; message: unknown }> = [];
    for (let index = 0; index < appended.length; index += 1) {
      const record = appended[index];
      const payload = record.payload as Record<string, unknown> | undefined;
      if (record.type === 'event_msg' && payload?.type === 'user_message') {
        newUserMessages.push({ index, message: payload.message });
      }
    }
    if (newUserMessages.length !== 1
      || newUserMessages[0].index <= turnContextIndex
      || newUserMessages[0].message !== exactInput) continue;

    matches.push({
      effectiveModel: turnPayload.model,
      cliVersion: typeof sessionPayload.cli_version === 'string' ? sessionPayload.cli_version : 'unknown',
      turnOrdinal: priorTurnCount + 1,
      rolloutSha256: sha256(content),
    });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function persistCodexCallEnvelope(
  runtimeDirectory: string,
  audited: { envelope: CodexCallEnvelope; hash: string },
): string {
  const directory = path.join(runtimeDirectory, 'codex-call-envelopes');
  ensurePrivateDirectory(directory);
  const associationRef = sha256(canonicalJson(audited.envelope.rolloutAssociation)).slice(0, 16);
  const target = path.join(directory, `${audited.hash}-${associationRef}.json`);
  atomicWritePrivateFile(target, `${JSON.stringify({ hash: audited.hash, ...audited.envelope }, null, 2)}\n`);
  return target;
}
