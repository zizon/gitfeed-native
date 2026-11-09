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
 * The route is mounted by the plugin, but who may open it is not this module's
 * question: the caller passes the same admission check the rest of the app uses,
 * so a stream request is as authenticated as any other.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StreamFrame } from '../shared/stream.js'

/** What the handler needs from the reader: attach a surface, receive frames. */
export interface StreamSource {
  /**
   * Attach one surface at the revision it holds, sending the frames that bring
   * it current.
   * @param rev - the revision the surface last saw; 0 when it holds none.
   * @param send - receives every frame from then on, in order.
   * @returns detaches this surface; the caller runs it when the response ends.
   */
  attach(rev: number, send: (frame: StreamFrame) => void): Promise<() => void>
}

/** Keeps the connection warm across a proxy that idles quiet sockets out. */
const HEARTBEAT_MS = 20000
/**
 * How much a surface may leave unread — frames waiting behind it plus whatever
 * the response is still holding — before its connection is dropped, so one
 * stalled tab cannot hold the whole process's memory.
 *
 * This is the bound, not the mechanism: the mechanism is the response's own
 * backpressure signal. `res.write` answers whether it wants more *right now*;
 * a false answer is the contract to stop writing until 'drain'. Honouring it is
 * what keeps a slow surface's backlog inside this process, and this number is
 * what stops a surface that never drains. Dropping one is safe because the
 * revision it reconnects with describes exactly what it holds. The number has
 * to clear the largest single frame — the whole archive on a first connection —
 * which is why it is tens of megabytes today.
 */
const MAX_QUEUED = 64 * 1024 * 1024

/**
 * Create the request handler for the event stream route.
 * @param source - the reader's stream surface.
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
    res.write(`retry: ${HEARTBEAT_MS}\n\n`)
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    // One object, not two locals: the close handler assigns them from outside
    // this function, which a control-flow narrowing of a plain `let` would miss.
    const life: { closed: boolean; detach: (() => void) | null; blocked: boolean } = {
      closed: false,
      detach: null,
      blocked: false,
    }
    /** Frames the response has not accepted yet, in order. */
    const queue: string[] = []
    let queued = 0
    let heartbeat: ReturnType<typeof setInterval> | null = null
    const stopHeartbeat = function (): void {
      if (heartbeat === null) return
      clearInterval(heartbeat)
      heartbeat = null
    }

    /** Keep writing while the response accepts bytes; a false answer means stop. */
    const drainQueue = function (): void {
      while (!life.closed && !life.blocked && queue.length > 0) {
        const chunk = queue.shift()
        if (chunk === undefined) return
        queued -= chunk.length
        if (!res.write(chunk)) life.blocked = true
      }
    }
    /**
     * Offer one chunk to the response, respecting what it says about its own
     * backlog. `res.write` returning false is the contract to stop and wait for
     * 'drain'; writing anyway is what lets a stalled reader grow the process.
     */
    const write = function (chunk: string): void {
      if (life.closed) return
      if (!life.blocked && queue.length === 0) {
        if (!res.write(chunk)) life.blocked = true
        return
      }
      queue.push(chunk)
      queued += chunk.length
      if (queued + res.writableLength > MAX_QUEUED) {
        // A whole archive's worth of frames is waiting behind this surface: it
        // is not reading. Dropping the connection loses nothing — it reconnects
        // asking from the revision it holds.
        life.closed = true
        queue.length = 0
        queued = 0
        stopHeartbeat()
        res.destroy()
      }
    }
    res.on('drain', function () {
      if (life.closed) return
      life.blocked = false
      drainQueue()
    })
    const send = function (frame: StreamFrame): void {
      write(`event: ${frame.t}\ndata: ${JSON.stringify(frame)}\n\n`)
    }
    heartbeat = setInterval(function () {
      write(': ping\n\n')
    }, HEARTBEAT_MS)
    const end = function (): void {
      stopHeartbeat()
      if (life.closed) return
      life.closed = true
      const running = life.detach
      life.detach = null
      if (running) {
        try {
          running()
        } catch (err) {
          console.error('gitfeed: stream detach failed', err)
        }
      }
      res.end()
    }
    req.on('close', end)
    res.on('error', end)
    try {
      life.detach = await source.attach(rev, send)
      if (life.closed) {
        const running = life.detach
        life.detach = null
        running()
      }
    } catch (err) {
      send({ t: 'error', protocol: 1, message: err instanceof Error ? err.message : String(err) })
      end()
    }
  }
}
