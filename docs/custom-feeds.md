# Custom feeds

A subscription is normally an RSS or Atom URL. Some things worth reading have
no feed: a research site's publication list, an API endpoint, a page built by
hand, a lookup that takes two requests. For those, an entry may declare itself
`"type": "custom"` and name a **script** — the user's own code, in the user's own
data repository — which returns a **pseudo feed**.

That is the whole feature, and the boundary is deliberate:

```
                    ┌────────────────────────────┐
   feeds.json ────► │ script → pseudo feed       │  the user's part
                    └─────────────┬──────────────┘
                                  │ { title, siteUrl, items }
                    ┌─────────────▼──────────────┐
                    │ ids · dates · dedupe ·      │  the feed path
                    │ retention · archive · rail  │  (unchanged)
                    └────────────────────────────┘
```

Everything after the pseudo feed is the code an RSS feed runs through. The
reader cannot tell the difference, which is why a custom source needs no change
anywhere else — and why it is extensible: a new source is a new script, not a
new shape for the plugin to learn.

## Where the script lives

In the data repository, next to the subscriptions it serves — conventionally
under `sources/`:

```
~/gitfeed/
  feeds.json
  config.json
  sources/google-research.mjs      a custom feed script
  sources/hn-newest.mjs            another one
  data/                            the archive
```

A script is a `.mjs` file whose **default export is an async function**, and
`script` in `feeds.json` is its path relative to the data root. Two rules:

- the file must exist, and its **resolved** path must stay inside the data root
  (a symlink out of it is refused, the way a written `../` would be);
- it must be `.mjs`, because a data repository generally has no `package.json`
  to declare its modules.

The bound is not decoration: a data repository is cloned from remotes, and
whoever can change a subscription should not be able to make the reader run code
they did not write. Read that as what it is — a data repository with a custom
feed script means running that repository's code, the way a git hook does.

## The declaration

```json
{
  "id": "research-google-pubs",
  "url": "https://research.google/pubs/",
  "title": "Google Research — Publications",
  "folder": "Papers",
  "type": "custom",
  "script": "sources/google-research.mjs",
  "options": { "limit": 30 }
}
```

| key | meaning |
| --- | --- |
| `type` | `custom` reads the entry through a script; absent or `rss` is a feed |
| `script` | the `.mjs` file, relative to the data root |
| `options` | handed to the script untouched; the script defines its shape |

`url` is still required: it is the entry's identity in the rail and the value
handed to the script. Whether the script requests it is its own business.

A declaration is validated before the script runs — on a fetch, and before the
subscription is created — so a typo is one feed's red row with a message naming
the field, never a failed run. An entry that declares `script` without
`type: "custom"` is refused rather than silently ignored.

## The interface

The script is called with one object:

| input | |
| --- | --- |
| `id` | the subscription's id, as `feeds.json` or the fetcher resolved it |
| `url` | the subscription's URL |
| `title` | the subscription's configured title, or `null` |
| `options` | the entry's `options`, untouched |
| `meta` | `{ etag, lastModified }` — what the last run stored, either may be `null` |
| `fetch` | the fetcher's own `fetch`, so a proxy or a test double applies |
| `signal` | an `AbortSignal` aborted at `fetch.timeoutMs`: pass it to every request |

It returns a **pseudo feed**:

| return | |
| --- | --- |
| `title` | the feed's display name; falls back to the entry's title |
| `siteUrl` | the site the item links belong to; the rail's site link |
| `etag`, `lastModified` | validators for the next run; **omit to keep the stored ones**, `null` forgets them |
| `items` | the entries — an empty array is a quiet run, not a failure |

…where each item is:

| item | |
| --- | --- |
| `id` | stable key for the archive; `link` is used when it is absent |
| `title` | display title; markup is stripped |
| `link` | the item's URL |
| `date` | ISO 8601, a Unix timestamp (seconds or milliseconds), or a `Date` |
| `author` | display author; markup is stripped |
| `summary` | the body, kept as given — markup included |

Strings, numbers, `Date`s, arrays (joined with `", "`), and the usual wrappers
(`{name}`, `{rendered}`, `{url}`, …) are all read, so a script can hand back the
API's own objects instead of mapping every field.

**Throwing is how a script reports a failure**: the row goes red with the
message, and the other feeds carry on. Returning `items: []` is the opposite — a
quiet run, counted as no new items.

The fetcher then applies the feed rules to the returned items:

- **Identity.** `id` is `sha1(feedId + "|" + key)`, where `key` is the item's
  `id`, else its `link`, else `title|date`. Re-running a script whose links do
  not change adds nothing.
- **Dates.** An item without a usable date is stamped with the moment it was
  first sighted, cascaded one minute per position down the list — so the first
  item a script returns is the newest, and stays that.
- **Retention and bodies.** `fetch.keepMonths` and `fetch.maxSummaryChars`
  apply exactly as they do to a feed.

## Worked example: Google Research publications

The publication list has no feed and no API: one page of cards.
[`examples/google-research.mjs`](../examples/google-research.mjs) is the whole
script — copy it into `~/gitfeed/sources/`, declare the entry above, Refresh.

```js
export default async function (input) {
  const answer = await input.fetch(input.url, { signal: input.signal })
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`)
  const html = await answer.text()

  const cards = html
    .split('<div class="row-card">')
    .slice(1)
    .map(function (chunk) {
      const title = /<a class="row-card__heading[^>]*>([\s\S]*?)<\/a>/.exec(chunk)
      const href = /<a class="row-card__heading[^>]*href=("[^"]*"|[^\s>]+)/.exec(chunk)
      const author = /<div class="row-card__subheading__item small-text">([\s\S]*?)<\/div>/.exec(chunk)
      if (!title || !href) return null
      return {
        title: text(title[1]),
        link: new URL(href[1].replace(/^"|"$/g, ''), input.url).href,
        author: author ? text(author[1]) : '',
      }
    })
    .filter(Boolean)

  if (cards.length === 0) throw new Error('no publication cards on the page')
  return { title: 'Google Research — Publications', siteUrl: 'https://research.google/pubs/', items: cards }
}

function text(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
```

Fifteen papers per fetch — the page's current list — each with its title, canonical
link, and first author.
The cards carry no date, so items are dated by first sighting.

## A JSON API, and being polite about it

```js
export default async function (input) {
  const headers = { accept: 'application/json' }
  if (input.meta.etag) headers['if-none-match'] = input.meta.etag
  const answer = await input.fetch(input.url, { headers, signal: input.signal })
  if (answer.status === 304) return { items: [] }
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`)
  const body = await answer.json()
  return {
    title: 'Hacker News, newest',
    // Stored and handed back next run as input.meta.etag.
    etag: answer.headers.get('etag') || null,
    items: body.hits.map((row) => ({
      id: row.objectID,
      title: row.title,
      link: row.url || `https://news.ycombinator.com/item?id=${row.objectID}`,
      date: row.created_at,
      author: row.author,
      summary: row.story_text || '',
    })),
  }
}
```

A `304` returns no items — a quiet run — and because `etag` is omitted, the
stored validator survives for the next round.

## Authoring with an agent

A script is code, and writing one by hand means guessing at a page's markup until
it parses. The plugin gives an agent three steps instead, through
`gitfeed_custom_feed`:

| action | what it returns |
| --- | --- |
| `scaffold` `{ name }` | writes `sources/<name>.mjs` — the interface as comments, and the one check a scraper must make |
| `check` `{ script, url, options }` | runs the script exactly as the fetcher would, with the same deadline, and reports the item count, how many items carried a date, and five sample rows; writes nothing |
| `subscribe` `{ script, url, title, folder, options }` | declares the entry, validates the script, and fetches it |

`list` reports every declared custom feed with its item count and last error, so
an agent can see a broken one without opening the rail.

The `custom-feeds` skill (registered with the plugin; `skill: false` turns it
off) is the guide an agent loads before writing one: the loop, the interface, the
rules that matter — throw on a mismatch, pass `signal`, keep the script inside
`data root` — and the failure modes. It points at the worked examples in
`examples/`, which are the same forty-line shape.

The point of `check` running outside a subscription is that a wrong script never
becomes a red row: the feedback is one tool call, with the script's own error
message and a sample of what it produced.

## Adding one

By hand, which is the durable way:

1. Write the script in `<data root>/sources/`.
2. Add the entry to `feeds.json` with `type`, `script`, and `options` if the
   script wants any.
3. Refresh in the reader, or run `gitfeed fetch` — the log says `ok` with the
   item count, or `err` with the script's complaint.
4. Commit the script, the subscription, and whatever `data/` the fetch wrote.

Through the API, which is the same code path:

```bash
curl -sS http://127.0.0.1:3080/gitfeed/api/feeds \
  -H 'content-type: application/json' \
  -d '{"url":"https://research.google/pubs/","title":"Google Research — Publications",
       "folder":"Papers","type":"custom","script":"sources/google-research.mjs"}'
```

The script is resolved against the data root before the subscription is written,
so a wrong path is a rejected add rather than a red row to unsubscribe from.

## Troubleshooting

| symptom | cause |
| --- | --- |
| `no script at …` | `script` is relative to the data root, and the file is not there |
| `… resolves outside …` | a symlink (or a `../` path) leaves the data root |
| `exports no default function` | the script must `export default async function (input) { … }` |
| `returned no "items" array` | the return value is not a pseudo feed |
| the row is red with the page still up | the script threw; the reader shows its message |
| the feed is quiet but you expected items | the script returned none, or a `304` path did |
| every item is the same link | the script's `link` repeats; make it per item |

The plugin re-imports a script whose file changed, so editing one and pressing
Refresh is enough — no restart.
