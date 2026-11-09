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
 * Above this much unflushed output the surface is not reading, and holding the
 * bytes for it costs the whole process. Dropping the stream is safe: the
 * surface reconnects and asks for the delta from the revision it holds.
 */
const MAX_BUFFERED = 4 * 1024 * 1024

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
    const life: { closed: boolean; detach: (() => void) | null } = { closed: false, detach: null }
    const write = function (chunk: string): void {
      if (life.closed) return
      res.write(chunk)
      if (res.writableLength > MAX_BUFFERED) {
        life.closed = true
        res.destroy()
      }
    }
    const send = function (frame: StreamFrame): void {
      write(`event: ${frame.t}\ndata: ${JSON.stringify(frame)}\n\n`)
    }
    const heartbeat = setInterval(function () {
      write(': ping\n\n')
    }, HEARTBEAT_MS)
    const end = function (): void {
      if (life.closed) return
      life.closed = true
      clearInterval(heartbeat)
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
