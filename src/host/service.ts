// The reader's Host state machine: committed items plus the local refresh
// cache, read/star state, subscriptions, git actions, and the job runner.

import { loadRuntimeFeeds, runFetch } from './fetch.js'
import { createFetchJob, createSyncJob } from './jobs.js'
import { createJobRunner } from './runner.js'
import type { JobHandle, JobRunner } from './runner.js'
import { pathsFor } from './settings.js'
import { createLiveState } from './live.js'
import type { Item } from '../shared/types.js'


import { pull as pullRemote, sync as syncRemote } from './git.js'
import type { GitfeedOptions, ServiceRecord } from './service-core.js'
import {
  archivedLengths, disarmProbe, fileVersion, frames, getState, gitInfo, invalidate, invalidateGit,
  invalidateItems, itemBody, refresh, search, settings,
} from './service-snapshot.js'
import {
  addFeed, attention, checkCustomFeed, customFeeds, ensureLocalMeta, exportOpml, gitAction, importOpml,
  mark, removeFeed, runLocalFetch, scaffoldCustomFeed, setFeedFolder, star,
} from './service-commands.js'
import { getForTool, listForTool, statusForTool } from './service-tools.js'

export function createGitfeed(options: GitfeedOptions) {
  const root = options.root
  const record: ServiceRecord = {
    root: root,
    logger: options.logger || console,
    paths: pathsFor(root),
    refreshMinutes: Number.isFinite(Number(options.refreshMinutes)) ? Math.max(0, Number(options.refreshMinutes)) : 0,
    idleMinutes: Number(options.idleMinutes) > 0 ? Number(options.idleMinutes) : 15,
    allowGit: options.allowGit !== false,
    adaptive: options.adaptive !== false,
    maxIntervalMinutes: Number.isFinite(Number(options.maxIntervalMinutes))
      ? Math.max(1, Number(options.maxIntervalMinutes))
      : 1440,
    syncMinutes: Number.isFinite(Number(options.syncMinutes)) ? Math.max(0, Number(options.syncMinutes)) : 10,
    syncMaxMinutes: Number.isFinite(Number(options.syncMaxMinutes))
      ? Math.max(1, Number(options.syncMaxMinutes))
      : 60,
    timers: options.timers,
    itemsCache: { version: null, items: null },
    shardRows: new Map<string, { stamp: string; rows: Item[] }>(),
    gitCache: { at: 0, value: null },
    gitFacts: null,
    searchTexts: null,
    searchTitles: '',
    writeQueue: Promise.resolve(),
    disposed: false,
    stopping: new AbortController(),
    live: createLiveState(),
    attached: 0,
    probeWaker: null,
    runner: null as unknown as JobRunner,
    refreshJob: null as unknown as JobHandle,
    syncJob: null as unknown as JobHandle,
  }
  bootstrap(record)
  return apiOf(record)
}

function apiOf(rec: ServiceRecord) {
  return {
    root: rec.root,
    getState: getState.bind(null, rec),
    mark: mark.bind(null, rec),
    star: star.bind(null, rec),
    attention: attention.bind(null, rec),
    addFeed: addFeed.bind(null, rec),
    importOpml: importOpml.bind(null, rec),
    exportOpml: exportOpml.bind(null, rec),
    removeFeed: removeFeed.bind(null, rec),
    setFeedFolder: setFeedFolder.bind(null, rec),
    runLocalFetch: runLocalFetch.bind(null, rec),
    scaffoldCustomFeed: scaffoldCustomFeed.bind(null, rec),
    checkCustomFeed: checkCustomFeed.bind(null, rec),
    customFeeds: customFeeds.bind(null, rec),
    pull: function () { return gitAction(rec, 'pull') },
    sync: function () { return gitAction(rec, 'sync') },
    settings: settings.bind(null, rec),
    listForTool: listForTool.bind(null, rec),
    getForTool: getForTool.bind(null, rec),
    statusForTool: statusForTool.bind(null, rec),
    search: search.bind(null, rec),
    itemBody: itemBody.bind(null, rec),
    frames: frames.bind(null, rec),
    /** Re-read the data root and announce what changed (the stream's probe, by hand). */
    refresh: refresh.bind(null, rec),
    dispose: dispose.bind(null, rec),
  }
}

function bootstrap(rec: ServiceRecord): void {
  // The runner owns every periodic run: the fetch job's per-feed clocks
  // and the sync job's push/pull debounce both live here, not in a timer.
  rec.runner = createJobRunner({
    root: rec.root,
    logger: rec.logger,
    idleMinutes: rec.idleMinutes,
    timers: rec.timers,
    // A run wrote something: drop the caches keyed on those files and let the
    // stream read once and announce what the run actually changed. A refresh
    // run only writes the ignored local cache, so it does not invalidate what
    // git reports.
    onRun: function (id) {
      invalidateItems(rec)
      if (id !== 'fetch') invalidateGit(rec)
      void refresh(rec, { force: true, git: id !== 'fetch' })
    },
  })

  rec.refreshJob = rec.runner.add(createFetchJob({
    refreshMinutes: rec.refreshMinutes,
    maxIntervalMinutes: rec.maxIntervalMinutes,
    adaptive: rec.adaptive,
    idleMinutes: rec.idleMinutes,
    loadFeeds: function () { return loadRuntimeFeeds(rec.root) },
    fetch: async function (scope) {
      if (rec.disposed) throw new Error('gitfeed is unloading')
      await ensureLocalMeta(rec)
      return runFetch({
        root: rec.root,
        dataDir: '.local',
        only: scope.only,
        feeds: scope.feeds,
        // The merged model is already in memory; the run does not read the
        // archive again to learn which ids it holds.
        known: await archivedLengths(rec),
        signal: rec.stopping.signal,
      })
    },
  }))

  rec.syncJob = rec.runner.add(createSyncJob({
    allowGit: rec.allowGit,
    syncMinutes: rec.syncMinutes,
    maxIntervalMinutes: rec.syncMaxMinutes,
    gitInfo: gitInfo.bind(null, rec),
    pull: function () { return pullRemote(rec.root) },
    sync: function () { return syncRemote(rec.root) },
    version: fileVersion.bind(null, rec),
  }))
}

function dispose(rec: ServiceRecord): void {
  rec.disposed = true
  // Before the runner: a run it is about to forget should stop asking the
  // network for feeds.
  rec.stopping.abort()
  disarmProbe(rec)
  rec.live.wake()
  rec.attached = 0
  rec.runner.dispose()
  invalidate(rec)
}

export type GitfeedService = ReturnType<typeof createGitfeed>
