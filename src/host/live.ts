/**
 * The Host's live copy of the reader's state, and the deltas it produces.
 *
 * The service reads the data root the same way it always did; this module
 * answers a different question: given the state it read a moment ago and the
 * state it just read, what actually changed? A surface holds the rest. That is
 * what keeps a refresh from costing every open reader the whole archive: a
 * fetch that lands seventeen rows ships seventeen rows, and a mark that lands
 * ships two ids.
 *
 * Revisions are the protocol's cursor. Each observable change gets the next
 * number, the last {@link HISTORY} of them are kept so a reconnecting surface
 * can be caught up, and anything the kept window cannot explain is answered
 * with the whole state instead. Nothing here touches disk, a timer, or a
 * socket: the diffs are pure values, tested against the same snapshots the
 * service builds.
 */

import type { Feed, GitInfo, Item, ReaderPrefs, ScheduleJobInfo } from '../shared/types.js'
import { HISTORY, PROTOCOL } from '../shared/stream.js'
import type { ItemDelta, MarkDelta, StreamDelta, StreamFrame, StreamWelcome } from '../shared/stream.js'

/** One complete read of the data root, as the service builds it. */
export interface LiveSnapshot {
  version: string
  itemsVersion: string
  items: readonly Item[]
  read: readonly string[]
  starred: readonly string[]
  feeds: Feed[]
  reader: ReaderPrefs
  git: GitInfo | null
  schedule: ScheduleJobInfo[]
  repo: string
  allowGit: boolean
}

/** What a surface needs to know about the copy the Host holds. */
export interface LiveInfo {
  rev: number
  version: string
  itemsVersion: string
}

/** The live copy: the current state, its revision, and the deltas after it. */
export interface LiveState {
  /** What the current copy is, or null before the first read. */
  info(): LiveInfo | null
  /** The whole state as a frame, for a surface that holds no revision. */
  welcome(): StreamWelcome | null
  /**
   * Take a freshly read snapshot and answer what changed since the copy held.
   * @param next - the state just read from disk.
   * @returns the delta to broadcast, or null when nothing a surface can see moved.
   */
  apply(next: LiveSnapshot): StreamDelta | null
  /** Note one local mark this process wrote, without re-reading the state. */
  mark(ids: readonly string[], read: boolean): StreamDelta | null
  /** Note one local star change this process wrote. */
  star(ids: readonly string[], on: boolean): StreamDelta | null
  /**
   * The frames that bring a surface holding `rev` up to date.
   * @param rev - the revision the surface last saw; 0 when it has none.
   * @returns the whole state when the revision cannot be extended, otherwise
   *   the deltas after it, in order.
   */
  framesAfter(rev: number): StreamFrame[]
}

/** Item rows the delta history may hold; past it, a reconnect gets the state. */
const MAX_LOG_ROWS = 4000

/** A signature per collection that is small to compare and cheap to build. */
interface Signatures {
  feeds: string
  reader: string
  git: string
  schedule: string
}

interface Held {
  version: string
  itemsVersion: string
  items: readonly Item[]
  byId: Map<string, Item>
  read: Set<string>
  starred: Set<string>
  feeds: Feed[]
  reader: ReaderPrefs
  git: GitInfo | null
  schedule: ScheduleJobInfo[]
  repo: string
  allowGit: boolean
  signatures: Signatures
}

function feedSignature(feeds: readonly Feed[]): string {
  return feeds.map(function (feed) {
    return [feed.id, feed.title, feed.folder, feed.siteUrl, feed.url, feed.error, feed.checkedAt].join('\u0000')
  }).join('\u0001')
}

function prefsSignature(reader: ReaderPrefs): string {
  return `${reader.hideEmptyFeeds}:${reader.markReadOnScroll}:${reader.groupBy}`
}

function gitSignature(git: GitInfo | null): string {
  if (!git) return ''
  return [
    git.repo ? '1' : '0',
    git.branch || '',
    git.dirty ? '1' : '0',
    String(git.ahead ?? 0),
    String(git.behind ?? 0),
    (git.remotes || []).join(','),
    git.error || '',
  ].join('\u0000')
}

function scheduleSignature(schedule: readonly ScheduleJobInfo[]): string {
  // The schedule is two jobs with small records; the status line shows every
  // field of them, so a change anywhere in it is worth one frame.
  return JSON.stringify(schedule)
}

function signaturesOf(snapshot: LiveSnapshot): Signatures {
  return {
    feeds: feedSignature(snapshot.feeds),
    reader: prefsSignature(snapshot.reader),
    git: gitSignature(snapshot.git),
    schedule: scheduleSignature(snapshot.schedule),
  }
}

function markDelta(previous: ReadonlySet<string>, next: readonly string[]): MarkDelta | null {
  const added: string[] = []
  const removed: string[] = []
  const kept = new Set(next)
  for (const id of kept) if (!previous.has(id)) added.push(id)
  for (const id of previous) if (!kept.has(id)) removed.push(id)
  return added.length || removed.length ? { add: added, remove: removed } : null
}

function itemDelta(previous: Held, next: LiveSnapshot, nextById: Map<string, Item>): ItemDelta | null {
  const added: Item[] = []
  const updated: Item[] = []
  const removed: string[] = []
  for (const [id, item] of nextById) {
    const held = previous.byId.get(id)
    if (held === undefined) {
      added.push(item)
      continue
    }
    // A repaired body is the only field the archive rewrites in place; comparing
    // the text keeps a title-only edit from being missed.
    if (held.summary !== item.summary || held.title !== item.title || held.link !== item.link
      || held.date !== item.date || held.author !== item.author || held.feed !== item.feed) {
      updated.push(item)
    }
  }
  for (const id of previous.byId.keys()) if (!nextById.has(id)) removed.push(id)
  return added.length || updated.length || removed.length ? { added, updated, removed } : null
}

/**
 * Create the live copy. It starts empty; the first {@link LiveState.apply}
 * installs the state and the service answers that connection with a welcome.
 * @returns the live copy the transport broadcasts from.
 */
export function createLiveState(): LiveState {
  let held: Held | null = null
  let rev = 0
  const log: StreamDelta[] = []
  let logRows = 0

  function info(): LiveInfo | null {
    if (!held) return null
    return { rev: rev, version: held.version, itemsVersion: held.itemsVersion }
  }

  function welcome(): StreamWelcome | null {
    if (!held) return null
    return {
      t: 'welcome',
      protocol: PROTOCOL,
      rev: rev,
      version: held.version,
      itemsVersion: held.itemsVersion,
      items: held.items.slice(),
      read: Array.from(held.read),
      starred: Array.from(held.starred),
      feeds: held.feeds,
      reader: held.reader,
      git: held.git,
      schedule: held.schedule,
      repo: held.repo,
      allowGit: held.allowGit,
    }
  }

  function install(snapshot: LiveSnapshot): Held {
    const byId = new Map<string, Item>()
    for (const item of snapshot.items) byId.set(item.id, item)
    return Object.assign({}, snapshot, {
      byId: byId,
      read: new Set(snapshot.read),
      starred: new Set(snapshot.starred),
      signatures: signaturesOf(snapshot),
    })
  }

  /** Record one delta: the next revision, the history, and the held copy. */
  function record(change: Omit<StreamDelta, 't' | 'protocol' | 'rev' | 'version' | 'itemsVersion'>, next?: Held): StreamDelta {
    if (next) held = next
    if (!held) throw new Error('live: a delta without a state')
    rev += 1
    const frame: StreamDelta = Object.assign({
      t: 'delta' as const,
      protocol: PROTOCOL,
      rev: rev,
      version: held.version,
      itemsVersion: held.itemsVersion,
    }, change)
    log.push(frame)
    if (change.items) logRows += change.items.added.length + change.items.updated.length
    // Two bounds: a surface that fell behind by more than a few hundred changes
    // asks for the whole state, and a log that would hold a whole feed's worth
    // of rows is not worth its memory — a reconnect there gets a welcome too.
    while (log.length > HISTORY) {
      const dropped = log.shift()
      if (dropped?.items) logRows -= dropped.items.added.length + dropped.items.updated.length
    }
    while (logRows > MAX_LOG_ROWS && log.length > 1) {
      const dropped = log.shift()
      if (dropped?.items) logRows -= dropped.items.added.length + dropped.items.updated.length
    }
    return frame
  }

  function apply(next: LiveSnapshot): StreamDelta | null {
    const previous = held
    if (!previous) {
      // The state a surface receives as its first frame is revision one: a
      // surface that reconnects holding it is only sent what came after.
      held = install(next)
      rev = 1
      return null
    }
    const nextById = new Map<string, Item>()
    for (const item of next.items) nextById.set(item.id, item)
    const signatures = signaturesOf(next)
    const items = previous.itemsVersion === next.itemsVersion ? null : itemDelta(previous, next, nextById)
    const read = markDelta(previous.read, next.read)
    const starred = markDelta(previous.starred, next.starred)
    const feeds = signatures.feeds === previous.signatures.feeds ? undefined : next.feeds
    const reader = signatures.reader === previous.signatures.reader ? undefined : next.reader
    const git = signatures.git === previous.signatures.git ? undefined : next.git
    const schedule = signatures.schedule === previous.signatures.schedule ? undefined : next.schedule
    const repo = previous.repo === next.repo ? undefined : next.repo
    const allowGit = previous.allowGit === next.allowGit ? undefined : next.allowGit
    const changed = items !== null || read !== null || starred !== null
      || feeds !== undefined || reader !== undefined || git !== undefined || schedule !== undefined
      || repo !== undefined || allowGit !== undefined
    const after = Object.assign({}, previous, {
      version: next.version,
      itemsVersion: next.itemsVersion,
      items: next.items,
      byId: nextById,
      read: new Set(next.read),
      starred: new Set(next.starred),
      feeds: next.feeds,
      reader: next.reader,
      git: next.git,
      schedule: next.schedule,
      repo: next.repo,
      allowGit: next.allowGit,
      signatures: signatures,
    })
    if (!changed) {
      // The root moved but nothing a surface draws did — a meta write, a
      // schedule tick. Hold the new versions so the next probe is quiet.
      held = after
      return null
    }
    const change: Omit<StreamDelta, 't' | 'protocol' | 'rev' | 'version' | 'itemsVersion'> = {}
    if (items) change.items = items
    if (read) change.read = read
    if (starred) change.starred = starred
    if (feeds !== undefined) change.feeds = feeds
    if (reader !== undefined) change.reader = reader
    if (git !== undefined) change.git = git
    if (schedule !== undefined) change.schedule = schedule
    if (repo !== undefined) change.repo = repo
    if (allowGit !== undefined) change.allowGit = allowGit
    return record(change, after)
  }

  function mark(ids: readonly string[], read: boolean): StreamDelta | null {
    if (!held) return null
    const add: string[] = []
    const remove: string[] = []
    for (const id of ids) {
      if (!id) continue
      if (read) {
        if (held.read.has(id)) continue
        held.read.add(id)
        add.push(id)
      } else {
        if (!held.read.delete(id)) continue
        remove.push(id)
      }
    }
    if (!add.length && !remove.length) return null
    return record({ read: { add: add, remove: remove } })
  }

  function star(ids: readonly string[], on: boolean): StreamDelta | null {
    if (!held) return null
    const add: string[] = []
    const remove: string[] = []
    for (const id of ids) {
      if (!id) continue
      if (on) {
        if (held.starred.has(id)) continue
        held.starred.add(id)
        add.push(id)
      } else {
        if (!held.starred.delete(id)) continue
        remove.push(id)
      }
    }
    if (!add.length && !remove.length) return null
    return record({ starred: { add: add, remove: remove } })
  }

  function framesAfter(since: number): StreamFrame[] {
    if (!held) return []
    const full = welcome()
    if (!full) return []
    // The log keeps only what it can explain: a gap, a future revision, or a
    // revision the row budget trimmed away all mean the whole state.
    const first = log.length ? log[0] : undefined
    const gap = first !== undefined && since < first.rev - 1
    if (since <= 0 || since > rev || gap || rev - since > log.length) return [full]
    return log.filter(function (frame) { return frame.rev > since })
  }

  return {
    info: info,
    welcome: welcome,
    apply: apply,
    mark: mark,
    star: star,
    framesAfter: framesAfter,
  }
}
