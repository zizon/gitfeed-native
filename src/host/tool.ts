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
  'folder',
  'pull',
  'sync',
]

const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS, description: 'Operation to run.' },
    id: { type: 'string', description: 'Item id for get, or feed id for unsubscribe and folder.' },
    ids: { type: 'array', items: { type: 'string' }, description: 'Item ids for mark and star.' },
    url: { type: 'string', description: 'Feed or site URL for subscribe.' },
    folder: { type: 'string', description: 'Folder for subscribe, or the folder to move a feed to; defaults to Uncategorized.' },
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
  "Read and manage the user's git-backed gitfeed RSS reader. Actions: status (counts, folders, git and scheduler state), list (filter items by query, feed, unread, starred), get (one item's text by id), mark (read/unread), star (ids), refresh (fetch feeds into the local cache), subscribe (URL, folder), unsubscribe (feed id), folder (move feed id to folder), pull, sync. Use status or list before acting, and prefer get to read an article's text."

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
    case 'folder':
      if (!input.id) throw new Error('id is required for folder')
      return { ok: true, feed: await service.setFeedFolder(input.id, input.folder) }
    case 'pull':
      return service.pull()
    case 'sync':
      return service.sync()
    default:
      throw new Error(`unknown action ${JSON.stringify(input.action)}`)
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

interface CustomFeedToolArgs {
  action?: string
  name?: string
  script?: string
  url?: string
  title?: string
  folder?: string
  options?: unknown
}

const CUSTOM_ACTIONS = ['list', 'scaffold', 'check', 'subscribe']

const CUSTOM_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: CUSTOM_ACTIONS, description: 'Operation to run.' },
    name: {
      type: 'string',
      description: 'scaffold: the script\'s name, e.g. "arxiv-ml"; writes sources/arxiv-ml.mjs.',
    },
    script: {
      type: 'string',
      description: 'check or subscribe: the path feeds.json writes, e.g. "sources/arxiv-ml.mjs".',
    },
    url: { type: 'string', description: 'The page or API the script reads.' },
    title: { type: 'string', description: 'subscribe: the feed title the reader shows.' },
    folder: { type: 'string', description: 'subscribe: folder for the feed, e.g. "Papers".' },
    options: { type: 'object', description: 'check or subscribe: handed to the script as input.options.' },
  },
  required: ['action'],
  additionalProperties: false,
}

const CUSTOM_DESCRIPTION =
  'Author a gitfeed custom feed: a script in the data root\'s sources/ that turns a page or an API with no RSS into a pseudo feed. Actions: list (declared custom feeds, their items and errors), scaffold (write a commented skeleton to sources/<name>.mjs), check (run a script against its URL and report what it returned; writes nothing), subscribe (declare the feed and fetch it). Workflow: scaffold, write the script, check until it returns items, subscribe. The script\'s default export receives { id, url, title, options, meta, fetch, signal } and returns { title?, siteUrl?, etag?, lastModified?, items }, each item { id?, title?, link?, date?, author?, summary? }. Load the custom-feeds skill before writing one.'

async function runCustomFeed(service: GitfeedService, args: unknown) {
  const input = (args || {}) as CustomFeedToolArgs
  switch (input.action) {
    case 'list':
      return service.customFeeds()
    case 'scaffold':
      if (!input.name) throw new Error('name is required for scaffold')
      return service.scaffoldCustomFeed({ name: input.name })
    case 'check':
      if (!input.script) throw new Error('script is required for check')
      return service.checkCustomFeed({ script: input.script, url: input.url, options: input.options })
    case 'subscribe':
      if (!input.script) throw new Error('script is required for subscribe')
      if (!input.url) throw new Error('url is required for subscribe')
      return {
        ok: true,
        feed: await service.addFeed({
          url: input.url,
          title: input.title,
          folder: input.folder,
          type: 'custom',
          script: input.script,
          options: input.options,
        }),
      }
    default:
      throw new Error(`unknown action ${JSON.stringify(input.action)}`)
  }
}

/**
 * Register the `gitfeed_custom_feed` tool, the authoring face of the reader.
 * @param {object} ctx context or child context with `tools`.
 * @param {object} service Host reader.
 * @returns {() => void} disposer.
 */
export function registerCustomFeedTool(ctx: PluginContext & { tools: Tools }, service: GitfeedService): () => void {
  return ctx.tools.register({
    name: 'gitfeed_custom_feed',
    description: CUSTOM_DESCRIPTION,
    parameters: CUSTOM_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (_args: unknown, value: unknown) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute: function (args: unknown) {
      return runCustomFeed(service, args)
    },
  })
}
