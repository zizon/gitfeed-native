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
/**
 * A request the Host cannot carry out because of what the caller asked for: a
 * missing field, an id that names nothing, a URL with no feed behind it. It is
 * not a fault of the Host's, so the HTTP surface answers 400 for it.
 *
 * A type, not a wording: the status used to be chosen by matching the message
 * against a regular expression, so rewording a sentence silently changed the
 * status code, and a new message always answered 500.
 */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

export function messageOf(err: unknown): string {
  if (typeof err === 'string') return err.trim() || 'unknown error'
  if (err instanceof Error) return err.message.trim() || 'unknown error'
  const failure = err as { message?: unknown } | null
  return typeof failure?.message === 'string' && failure.message.trim() ? failure.message.trim() : 'unknown error'
}
