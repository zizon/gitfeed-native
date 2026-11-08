/** Deterministic data roots for the suites: no network, no user data. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** The shard a dated item belongs in, the way the fetcher names them. */
export function shardOf(isoDate) {
  return isoDate.slice(0, 7)
}

/**
 * Create a scratch data root.
 * @param {object} [options]
 * @param {Array<object>} [options.feeds] subscription entries.
 * @param {Array<object>} [options.items] item rows, sharded by month.
 * @param {string[]} [options.read] ids marked read.
 * @param {string[]} [options.starred] ids starred.
 * @returns {string} absolute root, to be removed with {@link removeRoot}.
 */
export function makeDataRoot(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gitfeed-test-'))
  mkdirSync(path.join(root, 'data', 'items'), { recursive: true })
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({}, null, 2) + '\n')
  writeFileSync(path.join(root, 'feeds.json'), JSON.stringify({ feeds: options.feeds || [] }, null, 2) + '\n')
  writeFileSync(path.join(root, 'data', 'read.ndjson'), ndjson(options.read || []))
  writeFileSync(path.join(root, 'data', 'starred.ndjson'), ndjson(options.starred || []))
  writeFileSync(path.join(root, 'data', 'meta.json'), '{}\n')
  for (const item of options.items || []) {
    appendItem(path.join(root, 'data', 'items'), item)
  }
  return root
}

/** Write one item row into its shard, creating the shard when new. */
export function appendItem(itemsDir, item) {
  mkdirSync(itemsDir, { recursive: true })
  const file = path.join(itemsDir, `${shardOf(item.date)}.ndjson`)
  writeFileSync(file, `${JSON.stringify(item)}\n`, { flag: 'a' })
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true })
}

/**
 * A small, deterministic library: two feeds, tied timestamps, no network.
 * @param {number} [count] items per feed.
 * @returns {{feeds: Array<object>, items: Array<object>}}
 */
export function sampleLibrary(count = 32) {
  const feeds = [
    { id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha Notes', folder: 'Daily' },
    { id: 'feed-b', url: 'https://example.com/b.xml', title: 'Beta Notes', folder: 'Weekly' },
  ]
  const items = []
  for (const feed of feeds) {
    for (let i = 0; i < count; i++) {
      // Every fourth item shares its timestamp with the next one, so the id
      // tie-break is exercised rather than assumed.
      const minute = (count - i) - ((count - i) % 4)
      const date = new Date(Date.UTC(2026, 0, 20, 12, minute, 0)).toISOString()
      items.push({
        id: `${feed.id}-${String(i).padStart(3, '0')}`,
        feed: feed.id,
        title: `${feed.title} item ${i}`,
        link: `https://example.com/${feed.id}/${i}`,
        date: date,
        author: 'Author',
        summary: `<p>${'summary text for ' + feed.id + ' item ' + i + '; '.repeat(12)}</p>`,
      })
    }
  }
  return { feeds, items }
}

function ndjson(ids) {
  return ids.map(function (id) { return `${JSON.stringify({ id })}\n` }).join('')
}
