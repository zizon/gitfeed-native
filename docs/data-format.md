# Data format

What the data repository holds and how the two item stores are merged. The
reader's settings are in the README's [Configuration](../README.md#configuration)
section; a custom feed's declaration and script are covered in
[`custom-feeds.md`](custom-feeds.md).

`data/items/2026-11.ndjson`, one item per line:

```json
{"id":"b77b13687363294f","feed":"simonwillison","title":"Quoting Kyle Kingsbury","link":"https://simonwillison.net/2026/Nov/1/kyle-kingsbury/","date":"2026-11-01T16:49:04.000Z","author":"","summary":"<blockquote>..."}
```

`id` is `sha1(feedId + "|" + guid-or-link)` truncated to 16 hex chars, so the
same entry is never imported twice, even if a feed reorders or re-publishes it.
`summary` is the item HTML as the feed ships it. `fetch.maxSummaryChars` caps it when
set to a positive number; the default of 0 keeps the body whole.

`data/meta.json` holds per-feed ETag / Last-Modified so re-fetching a quiet feed
is a 304, plus the last error per feed, which the feed rail surfaces in red.

## Two item stores

Items live in two places, and the reader merges them on every model rebuild:

| store | written by | committed |
| --- | --- | --- |
| `data/items/*.ndjson` | the CLI; `Sync` commits what it wrote, and retention prunes old shards | yes |
| `.local/items/*.ndjson` | the plugin's own refresh, with the same retention | no — gitignored |

`data/` is listed first, then `.local/`; the first sighting of an id wins, with
one exception: when both hold the same id, the longer summary wins, because a
repair only ever lengthens a body. Neither store is swept when a subscription
leaves: the digest draws only the sources that are followed, so the rows of a
source that stopped being followed stay put — and come back if it is followed
again. A fetch counts **both** stores as already archived, so re-reading a feed
does not copy the committed archive into the cache, and `.local/` can be deleted
at any time — everything in it is either a row the committed store also holds or
a body the next fetch re-reads. Marks always go to `data/read.ndjson` and
`data/starred.ndjson`, whichever store the item came from.

The same rule orders the two `meta.json` files (`.local/meta.json` is the
cache's): the entry whose `checkedAt` is newer describes the feed, and a changed
title or site URL therefore reaches the sidebar without a CLI run.

Read and star state are append-only id sets with `merge=union`:

```
data/read.ndjson merge=union
data/starred.ndjson merge=union
data/interest.ndjson merge=union
data/items/*.ndjson merge=union
```

A fetch only ever appends item shards, and the reader only ever appends read/star
state and attention; unsubscribing is the one operation that rewrites a shard in place, which
is why `Sync` stages `data/items/`.
