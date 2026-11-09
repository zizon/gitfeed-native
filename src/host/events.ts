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
import type { StreamFrame } from '../shared/stream.js'
import { PROTOCOL } from '../shared/stream.js'

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
 * Write one chunk and answer when the response has taken it. The callback is
 * the contract: it runs when the chunk reached the socket, so a peer that is not
 * reading keeps this promise pending — which is exactly the pause the pull loop
 * needs. The abort resolves it too, so a closed socket cannot wedge the loop.
 * @param res - the held-open response.
 * @param text - one complete SSE chunk.
 * @param signal - the surface's cancellation.
 * @returns whether the write completed (false when it was cancelled).
 */
function writeChunk(res: ServerResponse, text: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(function (resolve) {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = function (): void {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    res.write(text, function (error?: Error | null) {
      signal.removeEventListener('abort', onAbort)
      resolve(error === undefined || error === null)
    })
  })
}

/**
 * Create the request handler for the event stream route.
 * @param source - the reader's frame source.
 * @param reject - the app's admission check: 401/403 to refuse, undefined to serve.
 * @returns the route handler.
 */
export function createEventsHandler(
  source: StreamSource,
  reject: (req: IncomingMessage) => 401 | 403 | undefined,
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
    req.on('close', function () { stop.abort() })
    res.on('error', function () { stop.abort() })

    // The retry hint is not a frame, and it comes first: a surface that hangs up
    // before its first frame should still know when to come back.
    if (!(await writeChunk(res, `retry: ${HEARTBEAT_MS}\n\n`, stop.signal))) {
      res.end()
      return
    }

    const iterator = source.frames(rev, stop.signal)[Symbol.asyncIterator]()
    let pending = iterator.next()
    try {
      while (!stop.signal.aborted) {
        const outcome = await Promise.race([
          pending.then(function (result) { return { kind: 'frame' as const, result: result } }),
          sleep(HEARTBEAT_MS).then(function () { return { kind: 'tick' as const } }),
          aborted(stop.signal).then(function () { return { kind: 'stop' as const } }),
        ])
        if (outcome.kind === 'stop') break
        if (outcome.kind === 'tick') {
          // Idle keep-alive. The pull is still pending; a comment is legal
          // between frames and the surface ignores it.
          if (!(await writeChunk(res, ': ping\n\n', stop.signal))) break
          continue
        }
        const result = outcome.result
        if (result.done) break
        pending = iterator.next()
        const frame = result.value
        const text = `event: ${frame.t}\ndata: ${JSON.stringify(frame)}\n\n`
        if (!(await writeChunk(res, text, stop.signal))) break
      }
    } catch (err) {
      // A pull that threw: tell the surface what happened while the response is
      // still open, then end it.
      const message = err instanceof Error ? err.message : String(err)
      await writeChunk(res, `event: error\ndata: ${JSON.stringify({ t: 'error', protocol: PROTOCOL, message: message })}\n\n`, stop.signal)
    } finally {
      // The response is over; the pull is told, not waited on. A source that
      // honours the signal unwinds on its own (the reader's does, between its
      // own awaits), and this handler must not hold the socket open for one
      // that does not.
      stop.abort()
      res.end()
      void iterator.return?.(undefined).catch(function () { })
    }
  }
}
