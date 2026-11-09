// The one HTTP surface the native Client page talks to. It runs on the
// Harness web server under /gitfeed/api; no separate port or process.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GitfeedService } from './service.js'
import { InputError, messageOf } from '../shared/errors.js'

interface ApiBody {
  ids?: string[]
  /** Text one search asks about. */
  query?: string
  read?: boolean
  star?: boolean
  url?: string
  folder?: string
  id?: string
  title?: string
  type?: string
  script?: string
  options?: unknown
}

const PREFIX = '/gitfeed/api'
const MAX_BODY = 1024 * 1024

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-gitfeed': 'native',
  })
  res.end(body)
}

function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void {
  res.writeHead(status, Object.assign({ 'cache-control': 'no-store' }, headers))
  res.end()
}

export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage): Promise<ApiBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY) throw new InputError('request body too large')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApiBody
  } catch {
    throw new InputError('invalid JSON body')
  }
}

/**
 * A signal that fires when the response is over — sent, or the client gone.
 *
 * Only reads take it. A build nobody is waiting for should stop; a write must
 * finish, because its side effect is the point and a half-done fetch is worse
 * than a fetch nobody watched.
 * @param res - the response the work is being done for.
 * @returns an abort signal tied to that response's lifetime.
 */
function responseSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.on('close', function () { controller.abort() })
  return controller.signal
}

/**
 * Create the Node request handler mounted at the web server prefix.
 * @param {object} service Host reader created by `createGitfeed`.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createHandler(service: GitfeedService) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      const url = new URL(req.url || '/', 'http://gitfeed.local')
      if (url.pathname !== PREFIX && url.pathname.indexOf(`${PREFIX}/`) !== 0) {
        sendJson(res, 404, { ok: false, error: 'no such endpoint' })
        return
      }
      const route = url.pathname.slice(PREFIX.length) || '/'
      const method = req.method || 'GET'
      const known = new Set(['/state', '/search', '/item', '/mark', '/star', '/feeds', '/feeds/remove', '/feeds/folder', '/fetch', '/pull', '/sync'])
      if (!known.has(route)) {
        sendJson(res, 404, { ok: false, error: 'no such endpoint' })
        return
      }

      if (route === '/state' && (method === 'GET' || method === 'HEAD')) {
        const known = url.searchParams.get('version') || undefined
        const knownItems = url.searchParams.get('itemsVersion') || undefined
        const state = await service.getState(known, knownItems, responseSignal(res))
        if (method === 'HEAD') {
          sendEmpty(res, 200)
          return
        }
        sendJson(res, 200, state)
        return
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      const input = await readBody(req)

      if (route === '/search') {
        const result = await service.search(input.query, responseSignal(res))
        sendJson(res, 200, { ok: true, ids: result.ids })
        return
      }
      if (route === '/item') {
        // The body an open article shows: the one row the digest was cut from.
        const item = await service.itemBody(input.id)
        if (!item) {
          sendJson(res, 404, { ok: false, error: 'no such item' })
          return
        }
        sendJson(res, 200, { ok: true, item: item })
        return
      }
      if (route === '/mark') {
        const result = await service.mark(input.ids, input.read !== false)
        sendJson(res, 200, result)
        return
      }
      if (route === '/star') {
        const result = await service.star(input.ids, input.star !== false)
        sendJson(res, 200, result)
        return
      }
      if (route === '/feeds') {
        const feed = await service.addFeed({
          url: input.url, folder: input.folder, title: input.title,
          type: input.type, script: input.script, options: input.options,
        })
        sendJson(res, 200, { ok: true, feed: feed })
        return
      }
      if (route === '/feeds/remove') {
        const result = await service.removeFeed(input.id)
        sendJson(res, 200, result)
        return
      }
      if (route === '/feeds/folder') {
        const feed = await service.setFeedFolder(input.id, input.folder)
        sendJson(res, 200, { ok: true, feed: feed })
        return
      }
      if (route === '/fetch') {
        const result = await service.runLocalFetch()
        sendJson(res, 200, {
          ok: result.code === 0,
          action: 'fetch',
          output: result.summary,
          error: result.code === 0 ? undefined : result.summary,
          fresh: result.fresh,
          failed: result.failed,
          logs: result.logs.slice(-8),
        })
        return
      }
      if (route === '/pull') {
        const result = await service.pull()
        sendJson(res, 200, result)
        return
      }
      if (route === '/sync') {
        const result = await service.sync()
        sendJson(res, 200, result)
        return
      }

      sendJson(res, 404, { ok: false, error: 'no such endpoint' })
    } catch (err) {
      // A client that went away is not an error to report to it; the response
      // is already unreachable.
      if (res.destroyed) return
      // A request the caller got wrong is 400; anything else is the Host's.
      // Decided on the type, so a reworded message cannot change the status.
      const status = err instanceof InputError ? 400 : 500
      if (!res.headersSent) sendJson(res, status, { ok: false, error: messageOf(err) })
      else res.end()
    }
  }
}
