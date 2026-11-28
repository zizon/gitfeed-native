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
  /** An OPML document uploaded from the reader, and whether it replaces the list. */
  opml?: string
  replace?: boolean
  /** The attention act: `open` or `star`, its row, and its source. */
  kind?: unknown
  item?: unknown
  feed?: unknown
}

const PREFIX = '/gitfeed/api'
// A feed export is a text document, not a request: a 1,000-subscription OPML
// from Inoreader is around 250 KB of XML once JSON-encoded, and a browser can
// send the whole library. Still bounded, because every other route shares it.
const MAX_BODY = 4 * 1024 * 1024

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

const ROUTES = new Set([
  '/state', '/search', '/item', '/mark', '/star', '/attention', '/feeds', '/feeds/remove', '/feeds/folder',
  '/import-opml', '/export-opml', '/fetch', '/pull', '/sync',
])

/**
 * Create the Node request handler mounted at the web server prefix.
 * @param {object} service Host reader created by `createGitfeed`.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createHandler(service: GitfeedService) {
  return function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return route(service, req, res)
  }
}

/**
 * One request: the fence, the route, and the answer for it. Each part is a named
 * step below, so the dispatch reads as the API's shape rather than a body of
 * inline branches.
 */
async function route(service: GitfeedService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!sameOrigin(req)) {
      refuse(res, 403, 'cross-origin request refused')
      return
    }
    const url = new URL(req.url || '/', 'http://gitfeed.local')
    const name = routeOf(url.pathname)
    if (name === null) {
      refuse(res, 404, 'no such endpoint')
      return
    }
    const method = req.method || 'GET'
    if (method === 'GET' || method === 'HEAD') {
      if (await readRoute(service, res, name, url, method)) return
      refuse(res, 405, 'method not allowed')
      return
    }
    if (method !== 'POST') {
      refuse(res, 405, 'method not allowed')
      return
    }
    if (await writeRoute(service, res, name, await readBody(req))) return
    refuse(res, 404, 'no such endpoint')
  } catch (err) {
    respondError(res, err)
  }
}

/** The route this path names, or null when the path is not ours or not known. */
function routeOf(pathname: string): string | null {
  if (pathname !== PREFIX && pathname.indexOf(`${PREFIX}/`) !== 0) return null
  const name = pathname.slice(PREFIX.length) || '/'
  return ROUTES.has(name) ? name : null
}

/** Routes that answer with a document rather than take a request. */
async function readRoute(
  service: GitfeedService, res: ServerResponse, route: string, url: URL, method: string,
): Promise<boolean> {
  if (route === '/state') {
    const version = url.searchParams.get('version') || undefined
    const itemsVersion = url.searchParams.get('itemsVersion') || undefined
    const state = await service.getState(version, itemsVersion, responseSignal(res))
    if (method === 'HEAD') {
      sendEmpty(res, 200)
      return true
    }
    sendJson(res, 200, state)
    return true
  }
  if (route === '/export-opml' && method === 'GET') {
    // A download, not JSON: the reader hands the document to the browser's own
    // save, so the file is the Host's answer as it stands.
    const document = await service.exportOpml()
    res.writeHead(200, {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': 'attachment; filename="gitfeed-subscriptions.opml"',
      'cache-control': 'no-store',
      'x-gitfeed': 'native',
    })
    res.end(document)
    return true
  }
  return false
}

/** Routes that take a request and answer with JSON. */
async function writeRoute(service: GitfeedService, res: ServerResponse, route: string, input: ApiBody): Promise<boolean> {
  switch (route) {
    case '/search': {
      const result = await service.search(input.query, responseSignal(res))
      sendJson(res, 200, { ok: true, ids: result.ids })
      return true
    }
    case '/item': {
      // The body an open article shows: the one row the digest was cut from.
      const item = await service.itemBody(input.id)
      if (!item) {
        sendJson(res, 404, { ok: false, error: 'no such item' })
        return true
      }
      sendJson(res, 200, { ok: true, item: item })
      return true
    }
    case '/mark': {
      sendJson(res, 200, await service.mark(input.ids, input.read !== false))
      return true
    }
    case '/star': {
      sendJson(res, 200, await service.star(input.ids, input.star !== false))
      return true
    }
    case '/attention': {
      // Attention, not a mark: answered ok even when the log already held the
      // act, because the reader's hand does not need to be told twice.
      sendJson(res, 200, await service.attention(input.kind, input.item, input.feed))
      return true
    }
    case '/feeds': {
      const feed = await service.addFeed({
        url: input.url, folder: input.folder, title: input.title,
        type: input.type, script: input.script, options: input.options,
      })
      sendJson(res, 200, { ok: true, feed: feed })
      return true
    }
    case '/feeds/remove': {
      sendJson(res, 200, await service.removeFeed(input.id))
      return true
    }
    case '/import-opml': {
      sendJson(res, 200, { ok: true, summary: await service.importOpml(input.opml || '', input.replace === true) })
      return true
    }
    case '/feeds/folder': {
      sendJson(res, 200, { ok: true, feed: await service.setFeedFolder(input.id, input.folder) })
      return true
    }
    case '/fetch': {
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
      return true
    }
    case '/pull': {
      sendJson(res, 200, await service.pull())
      return true
    }
    case '/sync': {
      sendJson(res, 200, await service.sync())
      return true
    }
    default:
      return false
  }
}

function refuse(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { ok: false, error: error })
}

/** A failure the caller can read, or the Host's own. */
function respondError(res: ServerResponse, err: unknown): void {
  // A client that went away is not an error to report to it; the response is
  // already unreachable.
  if (res.destroyed) return
  // A request the caller got wrong is 400; anything else is the Host's.
  // Decided on the type, so a reworded message cannot change the status.
  const status = err instanceof InputError ? 400 : 500
  if (!res.headersSent) sendJson(res, status, { ok: false, error: messageOf(err) })
  else res.end()
}
