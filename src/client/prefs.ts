/**
 * Reader display preferences: one persisted snapshot behind every surface that
 * reads them. These values are per browser and never touch the checkout —
 * `config.json` in the data root holds the defaults the Host half resolves.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GroupBy } from '../shared/types.js'
import { DEFAULT_LIST, DEFAULT_RAIL } from './constants.js'

/** The display preferences the reader keeps between visits. */
export interface Prefs {
  /** Null means no explicit choice; the checkout's `config.json` answers. */
  groupBy: GroupBy | null
  hideEmpty: boolean | null
  markOnScroll: boolean | null
  showDigest: boolean | null
  /** Folder disclosure by name: a folder the reader opened or closed by hand. */
  folderOpen: Record<string, boolean>
  railW: number
  listW: number
}

/** The one local-storage entry this snapshot persists under. */
const KEY = 'gitfeed.prefs'

/** The per-key entries the reader wrote before it kept one snapshot. */
const LEGACY = {
  groupBy: 'gitfeed.groupBy',
  hideEmpty: 'gitfeed.hideEmpty',
  markOnScroll: 'gitfeed.markOnScroll',
  showDigest: 'gitfeed.showDigest',
  folderOpen: 'gitfeed.folders',
  railW: 'gitfeed.railW',
  listW: 'gitfeed.listW',
} as const

function defaults(): Prefs {
  return {
    groupBy: null,
    hideEmpty: null,
    markOnScroll: null,
    showDigest: null,
    folderOpen: {},
    railW: DEFAULT_RAIL,
    listW: DEFAULT_LIST,
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // Private mode and a disabled store leave the built-in defaults in place.
    return null
  }
}

/** `'1'`/`'0'` and nothing else: an absent entry stays "no explicit choice". */
function asBool(raw: string | null): boolean | null {
  return raw === null ? null : raw !== '0'
}

function asGroupBy(raw: string | null): GroupBy | null {
  return raw === 'none' || raw === 'folder' || raw === 'feed' ? raw : null
}

function asWidth(raw: string | null, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function asFolders(raw: string | null): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(raw === null ? '{}' : raw)
    return value && typeof value === 'object' ? value as Record<string, boolean> : {}
  } catch {
    return {}
  }
}

/**
 * Read the entries a browser wrote before this snapshot existed.
 * @returns the seeded preferences and the keys to clear, or null when the
 * browser never stored any.
 */
function legacy(): { prefs: Prefs; keys: string[] } | null {
  const written = Object.values(LEGACY).filter(function (key) { return read(key) !== null })
  if (written.length === 0) return null
  return {
    prefs: {
      groupBy: asGroupBy(read(LEGACY.groupBy)),
      hideEmpty: asBool(read(LEGACY.hideEmpty)),
      markOnScroll: asBool(read(LEGACY.markOnScroll)),
      showDigest: asBool(read(LEGACY.showDigest)),
      folderOpen: asFolders(read(LEGACY.folderOpen)),
      railW: asWidth(read(LEGACY.railW), DEFAULT_RAIL),
      listW: asWidth(read(LEGACY.listW), DEFAULT_LIST),
    },
    keys: written,
  }
}

/** The preferences source the controller reads at start and writes on change. */
export type PrefsStore = ReturnType<typeof createPrefs>

/**
 * Open the persisted preferences, seeding them from the pre-snapshot entries
 * the first time so an existing reader keeps the display it had.
 * @returns the live preferences snapshot.
 */
export function createPrefs(): ReturnType<typeof createSnapshotStore<Prefs>> {
  const seeded = legacy()
  const store = createSnapshotStore<Prefs>(
    seeded === null ? defaults() : seeded.prefs,
    { persist: { name: KEY } },
  )
  if (seeded !== null) {
    // The store persists from its change notification, which fires only when the
    // snapshot identity moves: commit the seed as a new object, before the
    // legacy entries go, or a reload reads defaults.
    store.set(Object.assign({}, store.getSnapshot()))
    for (const key of seeded.keys) {
      try {
        localStorage.removeItem(key)
      } catch {
        // The seeded values are already in the snapshot; a stale entry is inert.
      }
    }
  }
  return store
}
