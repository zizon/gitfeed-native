/** Fixed-height virtualized item list with group headers and read-on-scroll. */

import { h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js'
import type { ReactNode } from '../react.js'
import {
  Button,
  IconChevronDownOutlineRegular,
  Menu,
  MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Item } from '../../shared/types.js'
import { GROUP_H, ROW_H, ROW_H_PLAIN } from '../constants.js'
import { lowerBound } from '../hooks.js'
import { tf } from '../locales.js'
import type { ItemListProps, MarkScope } from '../types.js'
import { fmtTime } from '../util.js'
import { IconStar } from '../icons.js'
import { EmptyState, IconButton } from './Controls.js'

interface Group {
  key: string
  label: string
  items: Item[]
}

interface RowEntry {
  kind: 'row'
  key: string
  item: Item
  h: number
}

interface GroupEntry {
  kind: 'group'
  key: string
  group: Group
  h: number
}

type Entry = RowEntry | GroupEntry

/** One menu row: the scope label on the left and what it would touch on the right. */
function scopeLabel(label: string, n: number) {
  return h('span', { className: 'gf-menu-row' },
    h('span', null, label),
    h('span', { className: 'gf-menu-count' }, String(n)))
}

export function ItemList({ state, controller, t, wide }: ItemListProps) {
  const list = controller.getList()
  const groupBy = state.groupBy || state.reader.groupBy || 'none'
  const markOnScroll = state.markOnScroll === null ? state.reader.markReadOnScroll : state.markOnScroll
  const showDigest = state.showDigest === null ? true : state.showDigest
  const rowH = showDigest ? ROW_H : ROW_H_PLAIN
  const viewportRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 24 })
  const rangeRef = useRef(range)
  rangeRef.current = range
  const raf = useRef(0)
  const lastKey = useRef('')
  const lastSelected = useRef<string | null>(null)
  /** Scroll offset the previous compute saw, to know what the viewport passed. */
  const lastTop = useRef(0)
  /** Scroll offset this surface moved to on its own, which must not mark anything. */
  const programmatic = useRef<number | null>(null)
  /**
   * The entry at the viewport top and how far into it the viewport sits. When a
   * refresh inserts rows above, the list is put back on this entry, so the
   * reader keeps looking at the same rows instead of at whatever slid down.
   */
  const scrollAnchor = useRef<{ key: string; delta: number } | null>(null)
  /** The scope menu for marking read; it shows its counts before acting. */
  const [markOpen, setMarkOpen] = useState(false)
  /** Only the whole-library entry needs a second, differently placed click. */
  const [markArmed, setMarkArmed] = useState(false)
  /** The feed whose section header is asking before unsubscribing. */
  const [pendingUnsub, setPendingUnsub] = useState<string | null>(null)
  /** Where the viewport sits: at the top, or inside a row/section. */
  const [anchor, setAnchor] = useState({ atTop: true, index: 0 })
  function closeMark() {
    setMarkOpen(false)
    setMarkArmed(false)
  }

  /** Counts for the mark menu; recomputed when the list or the read set moves. */
  const counts = useMemo(function () {
    return controller.markCounts()
  }, [state.items, state.read, state.version, state.listEpoch, state.feedId, state.query, state.filter, controller])

  const entries = useMemo<Entry[]>(function () {
    if (groupBy === 'none') {
      return list.map(function (item) { return { kind: 'row', key: item.id, item: item, h: rowH } })
    }
    const groups = new Map<string, Group>()
    for (const item of list) {
      const key = groupBy === 'feed' ? item.feed : controller.feedFolder(item.feed)
      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          label: groupBy === 'feed' ? controller.feedTitle(item.feed) : key,
          items: [],
        })
      }
      const bucket = groups.get(key)
      if (bucket) bucket.items.push(item)
    }
    // Sections hold one order: by name, the way the rail lists folders and
    // feeds. Ordering by size re-ranked every section whenever a fetch landed,
    // so the section being read could move somewhere else under the pointer.
    const ordered = Array.from(groups.values()).sort(function (a, b) {
      return a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
    })
    const out: Entry[] = []
    for (const group of ordered) {
      out.push({ kind: 'group', key: `group:${group.key}`, group: group, h: GROUP_H })
      for (const item of group.items) out.push({ kind: 'row', key: item.id, item: item, h: rowH })
    }
    return out
  }, [list, groupBy, controller, state.feedMap, rowH])

  const offsets = useMemo(function () {
    const out = new Array<number>(entries.length + 1)
    out[0] = 0
    for (let i = 0; i < entries.length; i++) out[i + 1] = out[i] + entries[i].h
    return out
  }, [entries])

  /** Which group entry covers each entry, so a section header can stay mounted. */
  const groupFloor = useMemo(function () {
    const out = new Array<number>(entries.length)
    let owner = -1
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.kind === 'group') owner = i
      out[i] = owner
    }
    return out
  }, [entries])

  const itemIndex = useMemo(function () {
    const map = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.kind === 'row') map.set(entry.item.id, i)
    }
    return map
  }, [entries])

  /** Every entry key to its row offset, for putting the viewport back in place. */
  const keyIndex = useMemo(function () {
    const map = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) map.set(entries[i].key, i)
    return map
  }, [entries])

  const total = offsets[entries.length] || 0

  // Scroll position this surface wrote itself (a filter reset, revealing the
  // selected item) must not count as the reader scrolling past those rows.
  function scrollTo(el: HTMLDivElement, value: number) {
    el.scrollTop = value
    programmatic.current = el.scrollTop
  }

  const compute = useCallback(function () {
    const el = viewportRef.current
    if (!el) return
    const top = el.scrollTop
    const prevTop = lastTop.current
    lastTop.current = top
    const height = el.clientHeight || 600
    const visibleStart = lowerBound(offsets, top)
    const visibleEnd = Math.min(entries.length, lowerBound(offsets, top + height) + 1)
    let start = Math.max(0, visibleStart - 4)
    const index = Math.min(entries.length - 1, lowerBound(offsets, top + 1))
    // Keep the header of the section under the viewport edge in the tree, so
    // the sticky rule can hold it at the top instead of scrolling it away.
    const floor = groupBy === 'none' ? -1 : groupFloor[index] ?? -1
    if (floor > -1 && floor < start) start = floor
    const end = Math.min(entries.length, visibleEnd + 4)
    setRange(function (current) {
      return current.start === start && current.end === end ? current : { start: start, end: end }
    })
    const atTop = top <= 12
    setAnchor(function (current) {
      return current.atTop === atTop && current.index === index ? current : { atTop: atTop, index: index }
    })
    // At the very top new rows should simply appear; anywhere else the entry
    // under the viewport edge is the landmark that must not move.
    const anchorIndex = Math.min(entries.length - 1, lowerBound(offsets, top))
    const anchorEntry = atTop ? undefined : entries[anchorIndex]
    scrollAnchor.current = anchorEntry
      ? { key: anchorEntry.key, delta: Math.max(0, top - offsets[anchorIndex]) }
      : null
    let jumped = false
    if (programmatic.current !== null) {
      jumped = Math.abs(programmatic.current - top) < 1
      programmatic.current = null
    }
    if (!markOnScroll || jumped) return
    // Rows the viewport top passed on the way down are read, including the
    // ones a scrollbar drag skipped over without ever rendering them.
    if (top <= prevTop) return
    const from = lowerBound(offsets, prevTop)
    const to = lowerBound(offsets, top)
    const markIds: string[] = []
    for (let i = from; i < to; i++) {
      const entry = entries[i]
      if (entry.kind === 'row' && !state.read.has(entry.item.id)) markIds.push(entry.item.id)
    }
    if (markIds.length) controller.mark(markIds, true)
  }, [offsets, entries, groupFloor, groupBy, markOnScroll, state.read, controller])

  const onScroll = useCallback(function () {
    if (raf.current) return
    raf.current = requestAnimationFrame(function () {
      raf.current = 0
      compute()
    })
  }, [compute])

  /** The entry list the scroll anchor was captured against. */
  const anchoredFor = useRef<Entry[] | null>(null)
  // The rows were rebuilt under a live scroll position: put the entry that was
  // under the viewport edge back where it was, before the browser paints.
  useLayoutEffect(function () {
    const el = viewportRef.current
    const previous = anchoredFor.current
    anchoredFor.current = entries
    const held = scrollAnchor.current
    if (!el || !held || !previous || previous === entries) return
    const index = keyIndex.get(held.key)
    if (index === undefined) return
    const target = Math.max(0, (offsets[index] || 0) + held.delta)
    if (Math.abs(target - el.scrollTop) < 1) return
    scrollTo(el, target)
    lastTop.current = el.scrollTop
  }, [entries, offsets, keyIndex])

  useEffect(function () {
    const key = `${groupBy}\u0000${state.query}\u0000${state.feedId || ''}`
    if (lastKey.current !== key) {
      lastKey.current = key
      const el = viewportRef.current
      if (el) scrollTo(el, 0)
    }
    compute()
  }, [compute, groupBy, state.query, state.feedId, state.version])

  useEffect(function () {
    const el = viewportRef.current
    if (!el) return
    let alive = true
    const observer = new ResizeObserver(function () { if (alive) compute() })
    observer.observe(el)
    return function () {
      alive = false
      observer.disconnect()
    }
  }, [compute])

  // Reveal a newly selected item, but never move the viewport because the
  // background refresh rebuilt the entries: the user may be reading elsewhere
  // in the list while new items land.
  useEffect(function () {
    const id = state.current
    if (!id) {
      lastSelected.current = null
      return
    }
    if (lastSelected.current === id) return
    lastSelected.current = id
    const index = itemIndex.get(id)
    if (index === undefined) return
    const currentRange = rangeRef.current
    if (index >= currentRange.start && index < currentRange.end) return
    const el = viewportRef.current
    if (el) scrollTo(el, Math.max(0, offsets[index] - 32))
  }, [state.current, itemIndex, offsets])

  const slice = entries.slice(range.start, range.end)
  const top = offsets[range.start] || 0
  const bottom = Math.max(0, total - (offsets[range.end] || total))

  const listRows = slice.map(function (entry) {
    if (entry.kind === 'group') {
      const groupUnread = entry.group.items.filter(function (item) { return !state.read.has(item.id) }).length
      // A section grouped by source is the source's own row, so it carries the
      // source's actions too: mark the section read, and unsubscribe from it.
      const feedId = groupBy === 'feed' ? entry.group.key : ''
      const confirming = feedId !== '' && pendingUnsub === feedId
      return h('div', { key: entry.key, className: `gf-group${confirming ? ' confirming' : ''}` },
        h('span', { className: 'gf-group-name' }, confirming ? t('confirm.unsubscribe') : entry.group.label),
        h('span', { className: 'gf-group-count' }, String(entry.group.items.length)),
        h('div', { className: 'gf-group-actions' },
          confirming
            ? [
              h(Button, {
                key: 'cancel',
                variant: 'ghost',
                size: 'sm',
                className: 'gf-group-read',
                onClick: function () { setPendingUnsub(null) },
              }, t('action.cancel')),
              h(Button, {
                key: 'remove',
                variant: 'ghost',
                size: 'sm',
                className: 'gf-group-read gf-danger',
                disabled: state.busy.remove,
                title: t('confirm.unsubscribeHint'),
                onClick: function () {
                  setPendingUnsub(null)
                  void controller.removeFeed(feedId)
                },
              }, t('action.remove')),
            ]
            : [
              feedId
                ? h(Button, {
                  key: 'unsub',
                  variant: 'ghost',
                  size: 'sm',
                  className: 'gf-group-unsub',
                  title: t('confirm.unsubscribeHint'),
                  onClick: function () { setPendingUnsub(feedId) },
                }, t('action.remove'))
                : null,
              h(Button, {
                key: 'mark',
                variant: 'ghost',
                size: 'sm',
                className: 'gf-group-read',
                disabled: !groupUnread,
                title: t('action.markGroup'),
                onClick: function () { controller.markGroup(entry.group.key) },
              }, groupUnread ? tf(t, 'action.markGroupCount', { n: groupUnread }) : t('action.markGroup')),
            ]))
    }
    const item = entry.item
    const unread = !state.read.has(item.id)
    const starred = state.starred.has(item.id)
    const digest = showDigest ? controller.digest(item) : ''
    return h('div', {
      key: entry.key,
      className: `gf-row${unread ? ' unread' : ''}${state.current === item.id ? ' active' : ''}${state.fresh.has(item.id) ? ' gf-row-in' : ''}`,
      role: 'button',
      tabIndex: -1,
      'aria-current': state.current === item.id ? 'true' : undefined,
      onClick: function () { controller.select(item.id) },
    },
    h('div', { className: 'gf-row-title' },
      unread ? h('span', { className: 'gf-dot', 'aria-hidden': true }) : null,
      h('span', { className: 't' }, item.title || '(untitled)'),
      starred ? h('span', { className: 'gf-star', title: t('action.unstar') }, h(IconStar, { filled: true, size: 12 })) : null),
    h('div', { className: 'gf-row-meta' },
      h('span', { className: 'feed-name' }, controller.feedTitle(item.feed)),
      h('span', { className: 'when' }, fmtTime(item.date))),
    digest ? h('div', { className: 'gf-row-digest' }, digest) : null)
  })

  const count = list.length
  const paneClass = `gf-listpane${wide ? ' wide' : ''}${showDigest ? '' : ' rows-plain'}`

  // The bar follows the viewport, but the scope is picked from the strongest
  // scope that is actually in effect: a search, then a selected source, then
  // the group under the edge. A source always wins over grouping, so a folder
  // that reaches past the current source can never be marked from inside it,
  // and with neither grouping nor a source the label stays put instead of
  // flipping with every row.
  const scope = useMemo(function (): MarkScope | null {
    if (!count) return null
    const searching = !!state.query.trim()
    if (searching) return { kind: 'results', label: t('action.markResults'), n: counts.results }
    if (state.feedId) {
      return {
        kind: 'source',
        label: tf(t, 'action.markNamed', { name: controller.feedTitle(state.feedId) }),
        n: counts.source,
        feed: state.feedId,
      }
    }
    if (!anchor.atTop && groupBy !== 'none') {
      for (let i = Math.min(anchor.index, entries.length - 1); i >= 0; i--) {
        const found = entries[i]
        if (found.kind !== 'group') continue
        const unread = found.group.items.filter(function (item) { return !state.read.has(item.id) }).length
        const name = groupBy === 'feed' ? controller.feedTitle(found.group.key) : found.group.key
        return { kind: 'group', label: tf(t, 'action.markNamed', { name: name }), n: unread, group: found.group.key }
      }
    }
    return { kind: 'all', label: t('action.markAll'), n: counts.all }
  }, [count, anchor, groupBy, state.query, state.feedId, state.read, counts, entries, controller, t])

  function runScope() {
    if (!scope || !scope.n) return
    if (scope.kind === 'all') controller.markEverything()
    else if (scope.kind === 'source') controller.markFeed(scope.feed as string)
    else if (scope.kind === 'group' && scope.group) controller.markGroup(scope.group)
    else controller.markAll()
  }

  // Every scope names its own count, so the biggest action is never a
  // neighbour that looks like the smallest one.
  const markRows: ReactNode[] = []
  if (counts.results > 0 || count > 0) {
    markRows.push(h(MenuItemButton, {
      key: 'results',
      disabled: !counts.results,
      onSelect: function () { closeMark(); controller.markAll() },
    }, scopeLabel(t('action.markResults'), counts.results)))
  }
  if (state.feedId && counts.source > 0) {
    markRows.push(h(MenuItemButton, {
      key: 'source',
      onSelect: function () { closeMark(); controller.markFeed(state.feedId as string) },
    }, scopeLabel(t('action.markSource'), counts.source)))
  }
  if (state.feedId && counts.folderName && counts.folder > counts.source) {
    markRows.push(h(MenuItemButton, {
      key: 'folder',
      onSelect: function () {
        closeMark()
        if (counts.folderName) controller.markFolder(counts.folderName)
      },
    }, scopeLabel(t('action.markFolder'), counts.folder)))
  }
  if (counts.all > 0 && counts.all !== counts.results) {
    markRows.push(h(MenuItemButton, {
      key: 'everything',
      danger: true,
      separatorBefore: true,
      onSelect: function () {
        if (!markArmed) {
          setMarkArmed(true)
          return
        }
        closeMark()
        controller.markEverything()
      },
    }, scopeLabel(markArmed ? tf(t, 'action.markAllConfirm', { n: counts.all }) : t('action.markEverything'), counts.all)))
  }

  const header = h('div', { className: 'gf-listbar' },
    h('span', { className: 'gf-count-label' }, tf(t, 'items.count', { n: count })))

  const markBar = h('div', { className: `gf-markfloat${scope && scope.n ? '' : ' off'}` },
    h(Button, {
      variant: 'ghost',
      size: 'sm',
      className: 'gf-markfloat-main',
      disabled: !scope || !scope.n,
      title: scope ? scope.label : t('action.markMenu'),
      onClick: runScope,
    },
    h('span', { className: 'gf-markfloat-label' }, scope ? scope.label : t('action.markMenu')),
    h('span', { className: 'gf-markfloat-count' }, scope ? String(scope.n) : '')),
    h(Menu, {
      open: markOpen,
      side: 'top',
      align: 'end',
      onClose: closeMark,
      className: 'gf-markfloat-more',
      anchor: h(IconButton, {
        icon: h(IconChevronDownOutlineRegular, { size: 14 }),
        label: t('action.markPick'),
        small: true,
        hasPopup: 'menu',
        expanded: markOpen,
        onClick: function () {
          if (markOpen) closeMark()
          else { setMarkOpen(true); setMarkArmed(false) }
        },
      }),
      children: markRows,
    }))

  if (state.status === 'loading' && !state.items.length) {
    return h('div', { className: paneClass }, header,
      h(EmptyState, { className: 'compact', hint: t('status.loading') }))
  }
  if (state.status === 'error' && !state.items.length) {
    return h('div', { className: paneClass }, header,
      h(EmptyState, { className: 'compact', hint: state.error || t('status.error') }))
  }
  if (!count) {
    return h('div', { className: paneClass }, header,
      h(EmptyState, { className: 'compact', hint: state.items.length ? t('empty.nothing') : t('empty.noItems') }))
  }

  return h('div', { className: paneClass },
    header,
    h('div', { className: 'gf-scroll', ref: viewportRef, onScroll: onScroll },
      h('div', { style: { height: top } }),
      listRows,
      h('div', { style: { height: bottom } })),
    markBar)
}
