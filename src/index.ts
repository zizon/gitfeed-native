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
 * `feeds.json`, default `config.json`, and the empty `data/` tree.
 *
 * Settings arrive as the Host row's `config:` object in the profile patch, or
 * from the environment. The plugin exports no Config schema, so the bundle is
 * pure TypeScript output with no vendored libraries; Plugin Manager therefore
 * shows no settings form and unknown keys pass through untouched.
 */

import { registerBrief } from './host/brief.js'
import { createEventsHandler, streamAdmission } from './host/events.js'
import type { StreamConnection } from './host/events.js'
import { createHandler } from './host/http.js'
import { scaffoldData } from './host/scaffold.js'
import { resolveRoot } from './host/settings.js'
import { createGitfeed } from './host/service.js'
import type { GitfeedService } from './host/service.js'
import { registerSkill } from './host/skill.js'
import { registerCustomFeedTool, registerTool } from './host/tool.js'
import type { GitfeedConfig, PluginContext } from './host/types.js'
import type { JobTimers } from './host/runner.js'
import { STREAM_PATH } from './shared/stream.js'

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
 *
 * The lines are the unit's life: open the data root, resolve the switches, build
 * the service, register what it serves, and report the schedule. Each is a named
 * step below, so this reads as the plugin's shape rather than its body.
 * @param {import('@deepseek-ai/cordis').Context} ctx owning plugin context.
 * @param {object} config validated plugin config.
 */
export function apply(ctx: PluginContext, config?: GitfeedConfig) {
  const settings: GitfeedConfig = config || {}
  const root = openRoot(ctx, settings)
  const limits = limitsOf(settings)
  const service = createGitfeed(Object.assign({ root: root, timers: timersFor(ctx), logger: ctx.logger }, limits))

  registerApi(ctx, service)
  registerStream(ctx, service)
  // The scheduler armed its jobs when they were registered, on this plugin's
  // fiber; disposing the fiber cancels those timers. This effect only makes an
  // already-running pass inert and drops the caches keyed on data files.
  ctx.effect(function () {
    return function () { service.dispose() }
  }, 'gitfeed: reader')

  registerTools(ctx, service, settings.tool === true)
  const skill = settings.skill !== false
  registerSkills(ctx, skill)
  registerPromptBrief(ctx, root, skill, settings.brief !== false)
  logSchedule(ctx, root, limits)
}

/**
 * The data root, seeded with a starter one when it is missing or empty.
 * @param ctx - the plugin context, for the log.
 * @param settings - the plugin row.
 * @returns the absolute data root.
 */
function openRoot(ctx: PluginContext, settings: GitfeedConfig): string {
  const root = resolveRoot(settings.repo)
  try {
    const seeded = scaffoldData(root)
    if (seeded.seeded) {
      const repo = seeded.repo ? ' (git repository on main)' : ''
      ctx.logger.info(`gitfeed: created a starter data root at ${root}${repo}`)
    } else if (seeded.reason === 'not-empty') {
      ctx.logger.warn(`gitfeed: ${root} has no feeds.json and is not empty; leaving it untouched`)
    }
  } catch (err) {
    ctx.logger.warn(`gitfeed: could not scaffold ${root}: ${String((err as Error).message || err)}`)
  }
  return root
}

/** The switches the service runs on, resolved from the row and the environment. */
interface Limits {
  refreshMinutes: number
  idleMinutes: number
  adaptive: boolean | undefined
  maxIntervalMinutes: number
  syncMinutes: number
  syncMaxMinutes: number
  allowGit: boolean | undefined
}

function limitsOf(settings: GitfeedConfig): Limits {
  const configuredRefresh = settings.refreshMinutes === undefined ? 5 : settings.refreshMinutes
  const configuredMax = settings.maxIntervalMinutes === undefined ? 1440 : settings.maxIntervalMinutes
  const configuredSync = settings.syncMinutes === undefined ? 10 : settings.syncMinutes
  const configuredSyncMax = settings.syncMaxMinutes === undefined ? 60 : settings.syncMaxMinutes
  return {
    refreshMinutes: Math.max(0, envNumber('GITFEED_LOCAL_FETCH_MIN', configuredRefresh || 0)),
    idleMinutes: Math.max(1, Number(settings.idleMinutes) || 15),
    adaptive: envBool('GITFEED_FETCH_ADAPTIVE', settings.adaptive),
    maxIntervalMinutes: Math.max(1, envNumber('GITFEED_FETCH_MAX_MIN', Number.isFinite(configuredMax) ? configuredMax : 1440)),
    syncMinutes: Math.max(0, envNumber('GITFEED_SYNC_MIN', Number.isFinite(configuredSync) ? configuredSync : 10)),
    syncMaxMinutes: Math.max(1, envNumber('GITFEED_SYNC_MAX_MIN', Number.isFinite(configuredSyncMax) ? configuredSyncMax : 60)),
    allowGit: envBool('GITFEED_ALLOW_GIT', settings.allowGit),
  }
}

/**
 * The timer service the scheduler wakes on: read from the mixin at call time, so
 * every job's wake-up registers on *this* plugin's fiber and a reload cancels
 * whatever is pending with the plugin.
 * @param ctx - the plugin context.
 * @returns the timers the service arms.
 */
function timersFor(ctx: PluginContext): JobTimers {
  return {
    // The Host timer ignores a callback's return value; a fake timer in the
    // suites uses it to await the pass a deadline starts.
    timeout: function (callback, delayMs) {
      return ctx.timeout(function () { void callback() }, delayMs)
    },
  }
}

/** The JSON API under `/gitfeed/api`. */
function registerApi(ctx: PluginContext, service: GitfeedService): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/gitfeed/api',
      handler: createHandler(service),
    }),
    'gitfeed: web API',
  )
}

/** The event stream the reader page opens. */
function registerStream(ctx: PluginContext, service: GitfeedService): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STREAM_PATH,
      handler: createEventsHandler(service, admitStreamFor(ctx), ctx.logger),
    }),
    'gitfeed: event stream',
  )
}

/**
 * The stream's admission: the Connection service's browser check when it is
 * present, and the origin fence at minimum. The service is read per request, so
 * a profile that loads Connection after this plugin still gets its check.
 * @param ctx - the plugin context.
 * @returns the admission the stream handler asks per request.
 */
function admitStreamFor(ctx: PluginContext): (req: import('node:http').IncomingMessage) => 401 | 403 | undefined {
  return function admit(req: import('node:http').IncomingMessage): 401 | 403 | undefined {
    // A profile may load Connection after this plugin, so the service is read
    // per request; which checks it offers is the Harness generation's business.
    const connection = typeof ctx.get === 'function'
      ? ctx.get('connection') as StreamConnection | undefined
      : undefined
    return streamAdmission(connection, req)
  }
}

/** The agent's tools, when the row asks for them. */
function registerTools(ctx: PluginContext, service: GitfeedService, enabled: boolean): void {
  if (!enabled) return
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => registerTool(scope, service), 'gitfeed: agent tool')
    scope.effect(() => registerCustomFeedTool(scope, service), 'gitfeed: custom feed tool')
  })
}

/**
 * The custom-feed skill: the guide the authoring tool's description points at.
 * Default on, so a profile patch written before this key existed keeps it.
 */
function registerSkills(ctx: PluginContext, enabled: boolean): void {
  if (!enabled) return
  ctx.inject(['skills'], (scope) => {
    scope.effect(() => registerSkill(scope), 'gitfeed: custom feed skill')
  })
}

/**
 * The invariants an agent needs before it asks go in the prompt itself: the data
 * root, what is committed, what needs a restart, and where the guide is.
 */
function registerPromptBrief(ctx: PluginContext, root: string, skill: boolean, enabled: boolean): void {
  if (!enabled) return
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => registerBrief(scope, { root: root, skill: skill }), 'gitfeed: prompt brief')
  })
}

/** The one line that says what this row will actually do. */
function logSchedule(ctx: PluginContext, root: string, limits: Limits): void {
  const fetchDetail = limits.adaptive
    ? ` (per-feed adaptive intervals, capped at ${limits.maxIntervalMinutes} min)`
    : ' (all feeds each run)'
  const fetchText = limits.refreshMinutes > 0
    ? `refreshing into .local/ every ${limits.refreshMinutes} min${fetchDetail}`
    : 'scheduled refresh disabled'
  const syncText = limits.allowGit === false
    ? 'git actions disabled'
    : limits.syncMinutes > 0
      ? `auto-syncing read state every ${limits.syncMinutes} min (backoff to ${limits.syncMaxMinutes} min)`
      : 'auto-sync disabled'
  ctx.logger.info(`gitfeed: ${root} — ${fetchText}; ${syncText}`)
}
