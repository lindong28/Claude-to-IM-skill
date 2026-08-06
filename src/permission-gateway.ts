import type { AskQuestion } from 'claude-to-im/src/lib/bridge/host.js';

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: {
    questions: AskQuestion[];
    answers: Record<string, string>;
  };
}

export interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;
}

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer?: NodeJS.Timeout;
  }>();
  private timeoutMs = 5 * 60 * 1000; // 5 minutes

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseID);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(toolUseID, { resolve, timer });
    });
  }

  waitForQuestion(toolUseID: string): Promise<PermissionResult> {
    // QuestionBroker owns the single question wait deadline so its durable
    // state, visible fallback, and provider-side release happen atomically.
    return new Promise((resolve) => {
      this.pending.set(toolUseID, { resolve });
    });
  }

  resolveQuestion(
    questionRequestId: string,
    updatedInput: {
      questions: AskQuestion[];
      answers: Record<string, string>;
    },
  ): boolean {
    const entry = this.pending.get(questionRequestId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve({ behavior: 'allow', updatedInput });
    this.pending.delete(questionRequestId);
    return true;
  }

  resolve(permissionRequestId: string, resolution: PermissionResolution): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    if (resolution.behavior === 'allow') {
      entry.resolve({ behavior: 'allow' });
    } else {
      entry.resolve({ behavior: 'deny', message: resolution.message || 'Denied by user' });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
