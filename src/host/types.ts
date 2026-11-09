/** Structural types for the Harness services this Host plugin uses. */

import type { ReaderPrefs } from '../shared/types.js'

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
}

export interface WebServer {
  register(route: WebRoute): () => void
}

export interface ToolOutputDefinition {
  schema: Record<string, unknown>
  render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: ToolOutputDefinition
  execute(args: unknown): Promise<unknown>
}

export interface Tools {
  register(definition: ToolDefinition): () => void
}

/** A skill this Host half contributes to the Harness catalog. */
export interface SkillRegistration {
  name: string
  description: string
  whenToUse?: string
  content: string
}

export interface Skills {
  register(skill: SkillRegistration): () => void
}

/** One ordered section of the assembled system prompt. */
export interface PromptSection {
  name: string
  order: number
  text: string
}

export interface SystemPrompt {
  section(section: PromptSection): () => void
}

/** The services a Host half can ask for, keyed by the name `inject` takes. */
export interface ServiceMap {
  tools: Tools
  skills: Skills
  systemPrompt: SystemPrompt
}

export interface PluginContext {
  logger: Logger
  webServer: WebServer
  /**
   * A service read by name at call time. Optional services that may load after
   * this plugin are read this way instead of declared in `inject`.
   */
  get?(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): () => void
  inject<K extends keyof ServiceMap>(services: K[], callback: (ctx: PluginContext & Pick<ServiceMap, K>) => void): void
  /**
   * The Host timer service (`ctx.timer`), forwarded by the Cordis context: the
   * disposer it returns belongs to this plugin's fiber.
   */
  timeout(callback: () => void, delayMs: number): () => void
}

export interface GitfeedConfig {
  repo?: string
  refreshMinutes?: number
  idleMinutes?: number
  adaptive?: boolean
  maxIntervalMinutes?: number
  syncMinutes?: number
  syncMaxMinutes?: number
  allowGit?: boolean
  tool?: boolean
  skill?: boolean
  brief?: boolean
}

export interface RepoConfig {
  fetch: {
    concurrency: number
    timeoutMs: number
    keepMonths: number
    maxSummaryChars: number
  }
  reader: ReaderPrefs
}

export interface FeedDefinition {
  id: string
  url: string
  title: string | null
  folder: string | null
  /** `custom` reads the entry through a script; absent means an RSS/Atom feed. */
  type?: string
  /** The script's file name under the data root's `sources/`. */
  script?: string
  /** Handed to the script untouched. */
  options?: unknown
}

export interface FetchFeedOutcome {
  added: number
  failed: boolean
  notModified: boolean
}

export interface FetchResult {
  code: number
  logs: string[]
  summary: string
  feeds: number
  fresh: number
  unchanged: number
  expired: number
  failed: number
  /** Archived items whose body a feed re-served longer than we had it. */
  repaired: number
  perFeed: Record<string, FetchFeedOutcome>
}

export interface GitActionResult {
  ok: boolean
  action: string
  output?: string
  error?: string
  committed?: boolean
}

export interface ReaderStateData {
  items: import('../shared/types.js').Item[]
  read: string[]
  starred: string[]
  feeds: import('../shared/types.js').Feed[]
  reader: ReaderPrefs
  repo: string
  allowGit: boolean
}

export interface ReadyState extends ReaderStateData {
  version: string
  unchanged?: boolean
  /** Fingerprint of the item shards alone; read and star marks do not move it. */
  itemsVersion?: string
  /** The caller holds `itemsVersion`, so this payload carries no item rows. */
  itemsUnchanged?: boolean
  git: import('../shared/types.js').GitInfo | null
  schedule: import('../shared/types.js').ScheduleJobInfo[]
  generatedAt: string
  error?: string
}
