/**
 * The event stream: one held-open HTTP response per reader surface.
 *
 * Server-sent events rather than a WebSocket, on purpose. The push is one-way
 * (the surface still answers over the JSON routes, which already reply with a
 * result), the transport is a browser primitive an EventSource reconnect owns,
 * and the Host needs no framing library: the plugin ships as code only, and a
 * socket server would have meant a runtime dependency for a channel whose whole
 * job is to write ``event:``/``data:`` lines.
 *
 * The handler pulls. It asks the reader for the next frame, writes it, and only
 * then asks for another, so a surface that is slow to read stops the producer at
 * the source instead of filling a queue here. What that leaves is a revision
 * cursor: a surface that stops asking simply stops advancing, and the reader's
 * bounded history decides whether it catches up by delta or gets a whole state.
 * There is no buffer in this file and no size to tune.
 *
 * The route is mounted by the plugin, but who may open it is not this module's
 * question: the caller passes the same admission check the rest of the app uses,
 * so a stream request is as authenticated as any other.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from './types.js'
import type { StreamFrame } from '../shared/stream.js'
import { PROTOCOL } from '../shared/stream.js'
import { messageOf } from '../shared/errors.js'

/** What the handler needs from the reader: a pull of frames from a revision. */
export interface StreamSource {
  /**
   * Pull the frames that bring a surface at `rev` current, then every change
   * after it. A consumer that stops asking stops the producer; the reader's
   * history is what it falls back behind.
   * @param rev - the revision the surface holds; 0 when it has none.
   * @param signal - cancels the pull; the response's close aborts it.
   */
  frames(rev: number, signal: AbortSignal): AsyncIterable<StreamFrame>
}

/** Keeps the connection warm across a proxy that idles quiet sockets out. */
const HEARTBEAT_MS = 20000

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    const timer = setTimeout(resolve, ms)
    // The handler owns this timer only for its own wait; a process that is
    // otherwise idle must not be held open by it.
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(function (resolve) {
    signal.addEventListener('abort', function () { resolve() }, { once: true })
  })
}

/**
 * How one chunk's write ended. Not a boolean: a surface hanging up and a socket
 * that failed are both reasons to stop writing, and flattening them into `false`
 * is how a broken connection came to look exactly like a reader closing its tab.
 */
type WriteOutcome =
  | { ok: true }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; error: unknown }

/**
 * Write one chunk and answer when the response has taken it. The callback is
 * the contract: it runs when the chunk reached the socket, so a peer that is not
 * reading keeps this promise pending — which is exactly the pause the pull loop
 * needs. The abort resolves it too, so a closed socket cannot wedge the loop.
 *
 * This promise never rejects, on purpose, and that is not the same as swallowing
 * the error: the failure is carried out in the value, where the caller has to
 * look at it, instead of escaping as a rejection whose only reader would be the
 * route, long after the response that could explain it is gone. A response that
 * throws synchronously (write-after-end does) is folded into the same outcome
 * for the same reason.
 * @param res - the held-open response.
 * @param text - one complete SSE chunk.
 * @param signal - the surface's cancellation.
 * @returns how the write ended, and the error when it failed.
 */
function writeChunk(res: ServerResponse, text: string, signal: AbortSignal): Promise<WriteOutcome> {
  return new Promise(function (resolve) {
    let settled = false
    const finish = function (outcome: WriteOutcome): void {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      resolve(outcome)
    }
    const cancel = function (): void { finish({ ok: false, reason: 'cancelled' }) }
    if (signal.aborted) {
      resolve({ ok: false, reason: 'cancelled' })
      return
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      res.write(text, function (error?: Error | null) {
        finish(error === undefined || error === null
          ? { ok: true }
          : { ok: false, reason: 'error', error: error })
      })
    } catch (error) {
      finish({ ok: false, reason: 'error', error: error })
    }
  })
}

/**
 * Create the request handler for the event stream route.
 * @param source - the reader's frame source.
 * @param reject - the app's admission check: 401/403 to refuse, undefined to serve.
 * @param log - where a stream that broke off says why, and at which revision.
 * @returns the route handler.
 */
export function createEventsHandler(
  source: StreamSource,
  reject: (req: IncomingMessage) => 401 | 403 | undefined,
  log: Logger,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rejection = reject(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    const url = new URL(req.url || '/', 'http://gitfeed.local')
    const rev = Math.max(0, Number(url.searchParams.get('rev')) || 0)
    // The data root may answer with an error frame, so the headers go first: a
    // surface that cannot get a stream should still learn why.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // The response outlives every ordinary request, so the idle timeout the
    // server would apply to a request socket must not apply to this one.
    req.setTimeout(0)
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    // One signal for the surface: the request closing, the response failing,
    // and this handler finishing all end the same pull.
    const stop = new AbortController()
    // One line per stream, for the first thing that went wrong with the
    // connection. A surface hanging up is ordinary and says nothing; a socket
    // that failed is the one fact nobody could see after this handler returned.
    let reported = false
    const report = function (error: unknown): void {
      if (reported) return
      reported = true
      log.warn(`gitfeed: the event stream broke off at rev ${rev}: ${messageOf(error)}`)
    }
    const send = async function (text: string): Promise<boolean> {
      const outcome = await writeChunk(res, text, stop.signal)
      if (outcome.ok) return true
      if (outcome.reason === 'error') report(outcome.error)
      return false
    }
    req.on('close', function () { stop.abort() })
    res.on('error', function (error: Error) {
      // The response's own failure event, which a write callback does not
      // always report (a destroy during a write, for one).
      report(error)
      stop.abort()
    })

    // The retry hint is not a frame, and it comes first: a surface that hangs up
    // before its first frame should still know when to come back.
    if (!(await send(`retry: ${HEARTBEAT_MS}\n\n`))) {
      endQuietly(res)
      return
    }

    // Inside the try: a source whose `frames` throws on the way in is a failure
    // to report like any other, not an escape past the finally that closes the
    // response.
    let iterator: AsyncIterator<StreamFrame> | undefined
    try {
      iterator = source.frames(rev, stop.signal)[Symbol.asyncIterator]()
      let pending = iterator.next()
      // One stop promise for the life of the stream. Created inside the loop it
      // would add an abort listener per frame — a stream that delivered a dozen
      // frames would trip Node's max-listeners warning and never release them.
      const stopped = aborted(stop.signal).then(function () { return { kind: 'stop' as const } })
      while (!stop.signal.aborted) {
        const outcome = await Promise.race([
          pending.then(function (result) { return { kind: 'frame' as const, result: result } }),
          sleep(HEARTBEAT_MS).then(function () { return { kind: 'tick' as const } }),
          stopped,
        ])
        if (outcome.kind === 'stop') break
        if (outcome.kind === 'tick') {
          // Idle keep-alive. The pull is still pending; a comment is legal
          // between frames and the surface ignores it.
          if (!(await send(': ping\n\n'))) break
          continue
        }
        const result = outcome.result
        if (result.done) break
        pending = iterator.next()
        const frame = result.value
        const text = `event: ${frame.t}\ndata: ${JSON.stringify(frame)}\n\n`
        if (!(await send(text))) break
      }
    } catch (err) {
      // A pull that threw: the reader itself failed, which is a fault of ours
      // rather than of the surface, so it is logged even when the frame that
      // carries it to the surface gets written.
      const message = messageOf(err)
      log.warn(`gitfeed: the event stream failed at rev ${rev}: ${message}`)
      await send(`event: error\ndata: ${JSON.stringify({ t: 'error', protocol: PROTOCOL, message: message })}\n\n`)
    } finally {
      // The response is over; the pull is told, not waited on. A source that
      // honours the signal unwinds on its own (the reader's does, between its
      // own awaits), and this handler must not hold the socket open for one
      // that does not.
      stop.abort()
      endQuietly(res)
      // The unwind's own failure is not news: the stream is already over, and
      // the source was handed a signal that told it so.
      void iterator?.return?.(undefined).catch(function () { })
    }
  }
}

/**
 * End the response when it may already be gone. A socket the peer destroyed is
 * the ordinary way this handler finishes, and `end` on it is not a failure to
 * pass on.
 * @param res - the held-open response.
 */
function endQuietly(res: ServerResponse): void {
  try {
    res.end()
  } catch {
    // Already closed; there is nothing left to close.
  }
}
