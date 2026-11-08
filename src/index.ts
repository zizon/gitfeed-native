/**
 * gitfeed as a native Harness Host plugin.
 *
 * The package's Host half owns the data root, the adaptive scheduler (feed
 * refresh and read-state sync), git actions, and the `gitfeed` agent tool.
 * Its Client half renders the reader inside the Web app: a right-Sidebar page
 * beside the file browser, plus a full main-panel page.
 *
 * The package is code only. The data it reads lives in a separate data
 * repository (by convention cloned to `~/gitfeed`), so installing or updating
 * the plugin never touches subscriptions, items, or read state. When that root
 * is missing or empty, activation writes a starter one: an empty
 * `feeds.json`, default `config.json`, the empty `data/` tree, and the
 * stand-alone CLI bundle with the workflow its scheduled fetch runs.
 *
 * Settings arrive as the Host row's `config:` object in the profile patch, or
 * from the environment. The plugin exports no Config schema, so the bundle is
 * pure TypeScript output with no vendored libraries; Plugin Manager therefore
 * shows no settings form and unknown keys pass through untouched.
 */

import { createHandler } from './host/http.js'
import { scaffoldData } from './host/scaffold.js'
import { resolveRoot } from './host/settings.js'
import { createGitfeed } from './host/service.js'
import { registerTool } from './host/tool.js'
import type { GitfeedConfig, PluginContext } from './host/types.js'

export const name = 'gitfeed'
/** The web server for the API, and the timer service the scheduler runs on. */
export const inject = ['webServer', 'timer']

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function envBool(name: string, fallback: boolean | undefined): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const text = raw.toLowerCase()
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false
  return fallback
}

/**
 * Mount the reader on the Harness web server and schedule refreshes.
 * @param {import('@deepseek-ai/cordis').Context} ctx owning plugin context.
 * @param {object} config validated plugin config.
 */
export function apply(ctx: PluginContext, config?: GitfeedConfig) {
  const settings: GitfeedConfig = config || {}
  const root = resolveRoot(settings.repo)
  try {
    const seeded = scaffoldData(root)
    if (seeded.seeded) {
      ctx.logger.info(`gitfeed: created a starter data root at ${root}`)
    } else if (seeded.reason === 'not-empty') {
      ctx.logger.warn(`gitfeed: ${root} has no feeds.json and is not empty; leaving it untouched`)
    }
  } catch (err) {
    ctx.logger.warn(`gitfeed: could not scaffold ${root}: ${String((err as Error).message || err)}`)
  }
  const configuredRefresh = settings.refreshMinutes === undefined ? 5 : settings.refreshMinutes
  const refreshMinutes = Math.max(0, envNumber('GITFEED_LOCAL_FETCH_MIN', configuredRefresh || 0))
  const idleMinutes = Math.max(1, Number(settings.idleMinutes) || 15)
  const adaptive = envBool('GITFEED_FETCH_ADAPTIVE',  settings.adaptive)
  const configuredMax = settings.maxIntervalMinutes === undefined ? 1440 : settings.maxIntervalMinutes
  const maxIntervalMinutes = Math.max(1, envNumber('GITFEED_FETCH_MAX_MIN', Number.isFinite(configuredMax) ? configuredMax : 1440))
  const configuredSync = settings.syncMinutes === undefined ? 10 : settings.syncMinutes
  const syncMinutes = Math.max(0, envNumber('GITFEED_SYNC_MIN', Number.isFinite(configuredSync) ? configuredSync : 10))
  const configuredSyncMax = settings.syncMaxMinutes === undefined ? 60 : settings.syncMaxMinutes
  const syncMaxMinutes = Math.max(1, envNumber('GITFEED_SYNC_MAX_MIN', Number.isFinite(configuredSyncMax) ? configuredSyncMax : 60))
  const allowGit = envBool('GITFEED_ALLOW_GIT',  settings.allowGit)
  const tool =  settings.tool
  const service = createGitfeed({
    root: root,
    // Read the mixin at call time, so every job's wake-up registers on *this*
    // plugin's fiber: a reload cancels whatever is pending with the plugin.
    timers: {
      timeout: function (callback, delayMs) { return ctx.timeout(callback, delayMs) },
    },
    refreshMinutes: refreshMinutes,
    idleMinutes: idleMinutes,
    adaptive: adaptive,
    maxIntervalMinutes: maxIntervalMinutes,
    syncMinutes: syncMinutes,
    syncMaxMinutes: syncMaxMinutes,
    allowGit: allowGit,
    logger: ctx.logger,
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/gitfeed/api',
      handler: createHandler(service),
    }),
    'gitfeed: web API',
  )

  ctx.effect(
    () => {
      const stop = service.schedule()
      return () => {
        stop()
        service.dispose()
      }
    },
    'gitfeed: adaptive schedule',
  )

  if (tool) {
    ctx.inject(['tools'], (scope) => {
      scope.effect(() => registerTool(scope, service), 'gitfeed: agent tool')
    })
  }

  const fetchDetail = adaptive
    ? ` (per-feed adaptive intervals, capped at ${maxIntervalMinutes} min)`
    : ' (all feeds each run)'
  const fetchText = refreshMinutes > 0
    ? `refreshing into .local/ every ${refreshMinutes} min${fetchDetail}`
    : 'scheduled refresh disabled'
  const syncText = allowGit === false
    ? 'git actions disabled'
    : syncMinutes > 0
      ? `auto-syncing read state every ${syncMinutes} min (backoff to ${syncMaxMinutes} min)`
      : 'auto-sync disabled'
  ctx.logger.info(`gitfeed: ${root} — ${fetchText}; ${syncText}`)
}
