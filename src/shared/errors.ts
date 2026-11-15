/**
 * The one way this package turns a caught value into a line of text. Both
 * halves and the CLI report failures the same way, so a message that reaches a
 * toast, a tool result, or a log line reads the same wherever it was caught.
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

/**
 * The failure modes that mean "the network was not there", as opposed to "the
 * thing I asked for is broken": no DNS answer, no route, a connection that
 * never opened, a request its own deadline aborted, or `git` failing before it
 * reached the remote.
 *
 * The distinction is what a period without a connection needs. A feed that
 * answers `HTTP 404` is broken and should be left alone for a day; a feed that
 * never answered has not been judged at all, and the reader should look again
 * at its base cadence rather than back off until the next morning.
 */
const UNREACHABLE = new RegExp([
  // Node's fetch and undici: the wrapper message, plus the socket codes that
  // arrive from a resolver or a TCP connect.
  'fetch failed',
  'aborted',
  'timed? ?out',
  'timeout',
  'socket hang up',
  'getaddrinfo',
  'E(NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH|CONNREFUSED|CONNRESET|TIMEDOUT)',
  // `git` says the same things in its own words.
  'could not resolve host',
  'failed to connect',
  'connection (refused|reset|timed out|closed)',
  'network is unreachable',
  'no route to host',
].join('|'), 'i')

/**
 * Whether a failure says the network, not the thing that was asked, was
 * unreachable.
 * @param message - a caught error's message, as `messageOf` reports it.
 * @returns whether the failure is a connection failure.
 */
export function looksUnreachable(message: string): boolean {
  return UNREACHABLE.test(message)
}
