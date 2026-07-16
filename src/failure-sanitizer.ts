export type FailureKind = 'unhandledRejection' | 'uncaughtException' | 'fatal';

/**
 * Return a stable diagnostic category without copying attacker-controlled error
 * messages, stacks, names, or constructors into status files and daemon logs.
 */
export function safeFailureSummary(kind: FailureKind, failure: unknown): string {
  const valueType = failure instanceof Error ? 'Error' : typeof failure;
  return `${kind}: ${valueType}`;
}
