/**
 * The one way this package turns a caught value into a line of text. Both
 * halves and the CLI report failures the same way, so a message that reaches a
 * toast, a tool result, or a log line reads the same wherever it was caught.
 */

/**
 * The message of anything thrown or rejected.
 * @param err - the caught value, of any shape.
 * @returns its message, trimmed; `unknown error` when it carries none.
 */
export function messageOf(err: unknown): string {
  if (typeof err === 'string') return err.trim() || 'unknown error'
  if (err instanceof Error) return err.message.trim() || 'unknown error'
  const failure = err as { message?: unknown } | null
  return typeof failure?.message === 'string' && failure.message.trim() ? failure.message.trim() : 'unknown error'
}
