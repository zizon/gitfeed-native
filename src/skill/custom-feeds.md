---
name: custom-feeds
description: Use when something the user wants to follow has no RSS or Atom feed — a research publication list, an API endpoint, a page built by hand — or when an existing subscription reports "response is not an XML feed" or Add feed said "no RSS/Atom feed found on that page". Authors a gitfeed custom feed script, checks it against the live page, and subscribes it.
whenToUse: The user asks to follow a page or API that has no feed, or a subscription is red with "not an XML feed".
---

# Authoring a gitfeed custom feed

A **custom feed** is a script in the user's data repository (`~/gitfeed/sources/`)
whose default export returns a *pseudo feed*. Everything after that is the
normal feed path — ids, dates, de-duplication, retention, the archive, the rail,
the agent tool — so the script only has to produce entries.

The `gitfeed_custom_feed` tool drives the whole loop:

| action | what it does |
| --- | --- |
| `list` | the declared custom feeds, each with its item count and last error |
| `scaffold` | writes a commented skeleton to `sources/<name>.mjs` |
| `check` | runs a script against its URL and reports what it returned — writes nothing |
| `subscribe` | declares the feed and fetches it into the reader |

## The loop

1. **Look first.** If the site has an RSS or Atom feed, stop: a plain
   subscription is better than a script. Check the page's
   `<link rel="alternate" type="application/rss+xml">`, and try the obvious
   `/feed`, `/rss`, `/rss.xml`, `/blog/feed` paths. Only when there is none:
2. **Read the page.** `curl` it, or `web_fetch`. Decide what one item is and
   what marker starts it, and where its title, link, date, author, and body
   are. Prefer a page rendered server-side; note whether it is JSON.
3. **Scaffold.** `gitfeed_custom_feed { action: "scaffold", name: "arxiv-ml" }`
   → `sources/arxiv-ml.mjs`. Read it: the interface is in its header.
4. **Write it.** Keep it small and boring. One request, one split, one loop.
5. **Check it.** `gitfeed_custom_feed { action: "check", script:
   "sources/arxiv-ml.mjs", url: "<the page>" }`. It reports the item count, how
   many carried a date, and the first five rows. Iterate until the count is
   what the page shows.
6. **Subscribe.** `{ action: "subscribe", script, url, title, folder }`.
   Then `action: "list"` to confirm its count and that `error` is null.

Do not subscribe before `check` returns items: a subscription with a broken
script is a red row in the user's rail.

## The interface

```js
export default async function (input) {
  // input.id, input.url, input.title   the subscription
  // input.options                      the entry's "options", untouched
  // input.meta                         { etag, lastModified } from the last run
  // input.fetch                        use this, not the global fetch
  // input.signal                       aborted at fetch.timeoutMs; pass it on
  return {
    title: '…',        // the feed's name in the rail; optional
    siteUrl: '…',      // optional
    etag: '…',         // optional; omit to keep the last one, null to forget it
    lastModified: '…', // optional
    items: [{ id, title, link, date, author, summary }], // all optional but link
  }
}
```

- `id` is the archive key — use a stable one (a URL, a slug, an API id). Without
  it the fetcher keys on `link`, then on `title|date`.
- `date` may be ISO 8601, a Unix timestamp (seconds or milliseconds), or a
  `Date`. Leave it empty and the item is stamped with the moment it was first
  sighted, cascading one minute per position, so the **first item returned is
  the newest and stays so**.
- `summary` may be HTML; `title` and `author` are stripped to text.
- Strings, numbers, `Date`s, arrays, and `{name}`/`{rendered}`/`{url}` wrappers
  are all read, so an API's own objects can often be passed straight through.

## Rules that matter

- **Throw when the page stops looking like it used to** (`no publication cards
  on the page`). That is what colours the row red. Returning no items means
  "nothing new", which is a different statement — never use it to hide a
  mismatch.
- **Pass `input.signal`** to every request, or a stalled site ignores the
  deadline.
- **Request headers are yours**: set a `user-agent`, and an `accept` the API
  wants. Some sites block a non-browser one; some block everything (Meta's
  `ai.meta.com` answers "Sorry, this content isn't available right now") — fall
  back to a public index such as OpenAlex for papers by affiliation rather than
  fighting the wall.
- **Keep the script inside `sources/`**: the fetcher resolves the path and
  refuses anything outside the data root. Never import from the plugin package.
- **Several pages cost several requests.** Cap the paging (`PAGES = 3`), because
  the script runs on every refresh.
- The plugin re-imports a changed script, so editing and pressing Refresh is
  enough; no restart.

## Worked example

`examples/google-research.mjs` in the plugin repository reads the Google
Research publication list — a page of `<div class="row-card">` cards with no
feed — and returns fifteen items with titles, canonical links, and first
authors. The live data repository has five more: Microsoft Research's paged
index, Amazon Science, Anthropic's research listing, OpenAI's news feed
filtered to its research categories, and Meta's papers through OpenAlex. Read
one of those before writing a new one; they are all about forty lines.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `check` says 0 items, page unchanged | the split marker no longer occurs, or field patterns mismatch; print the first match in the script while iterating |
| `check` throws `HTTP 403` | the site blocks this network or user agent; look for a JSON endpoint or a public index |
| items are right but the rail shows nothing | subscribe was skipped, or the script returned items without `link`/`id` |
| one item, repeated | the split matched once; anchor it on the element each item starts with |
| `resolves outside` | the script must live under the data root, e.g. `sources/x.mjs` |
