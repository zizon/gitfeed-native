// The agent-facing face of the reader. Every action calls the same Host
// methods the native page uses, so both callers share one implementation.

import type { GitfeedService } from './service.js'
import type { PluginContext, Tools } from './types.js'

interface GitfeedToolArgs {
  action?: string
  id?: string
  ids?: string[]
  url?: string
  folder?: string
  query?: string
  feed?: string
  unreadOnly?: boolean
  starredOnly?: boolean
  limit?: number
  read?: boolean
  starred?: boolean
}

const ACTIONS = [
  'status',
  'list',
  'get',
  'mark',
  'star',
  'refresh',
  'subscribe',
  'unsubscribe',
  'pull',
  'sync',
]

const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS, description: 'Operation to run.' },
    id: { type: 'string', description: 'Item id for get, or feed id for unsubscribe.' },
    ids: { type: 'array', items: { type: 'string' }, description: 'Item ids for mark and star.' },
    url: { type: 'string', description: 'Feed or site URL for subscribe.' },
    folder: { type: 'string', description: 'Folder for subscribe; defaults to Uncategorized.' },
    query: { type: 'string', description: 'Case-insensitive text filter for list.' },
    feed: { type: 'string', description: 'Feed id filter for list.' },
    unreadOnly: { type: 'boolean', description: 'Only unread items for list.' },
    starredOnly: { type: 'boolean', description: 'Only starred items for list.' },
    limit: { type: 'number', description: 'Maximum list rows, 1-100; defaults to 30.' },
    read: { type: 'boolean', description: 'Target read state for mark; defaults to true.' },
    starred: { type: 'boolean', description: 'Target star state for star; defaults to true.' },
  },
  required: ['action'],
  additionalProperties: false,
}

const DESCRIPTION =
  "Read and manage the user's git-backed gitfeed RSS reader. Actions: status (counts, git and refresh state), " +
  "list (filter items by query, feed, unread, starred), get (one item's text by id), mark (read/unread), " +
  'star, refresh (fetch feeds into the local cache), subscribe (URL, folder), unsubscribe (feed id), pull, sync. ' +
  "Use status or list before acting, and prefer get to read an article's text."

async function run(service: GitfeedService, args: unknown) {
  const input = (args || {}) as GitfeedToolArgs
  switch (input.action) {
    case 'status':
      return service.statusForTool()
    case 'list':
      return service.listForTool(input)
    case 'get':
      if (!input.id) throw new Error('id is required for get')
      return service.getForTool(input.id)
    case 'mark':
      if (!Array.isArray(input.ids) || input.ids.length === 0) throw new Error('ids are required for mark')
      return service.mark(input.ids, input.read !== false)
    case 'star':
      if (!Array.isArray(input.ids) || input.ids.length === 0) throw new Error('ids are required for star')
      return service.star(input.ids, input.starred !== false)
    case 'refresh': {
      const result = await service.runLocalFetch()
      return {
        ok: result.code === 0,
        summary: result.summary,
        fresh: result.fresh,
        unchanged: result.unchanged,
        failed: result.failed,
      }
    }
    case 'subscribe':
      if (!input.url) throw new Error('url is required for subscribe')
      return { ok: true, feed: await service.addFeed({ url: input.url, folder: input.folder }) }
    case 'unsubscribe':
      if (!input.id) throw new Error('id is required for unsubscribe')
      return service.removeFeed(input.id)
    case 'pull':
      return service.pull()
    case 'sync':
      return service.sync()
    default:
      throw new Error('unknown action ' + JSON.stringify(input.action))
  }
}

/**
 * Register the single `gitfeed` tool on a context that has the Tool registry.
 * @param {object} ctx context or child context with `tools`.
 * @param {object} service Host reader.
 * @returns {() => void} disposer.
 */
export function registerTool(ctx: PluginContext & { tools: Tools }, service: GitfeedService): () => void {
  return ctx.tools.register({
    name: 'gitfeed',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (_args: unknown, value: unknown) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute: function (args: unknown) {
      return run(service, args)
    },
  })
}
