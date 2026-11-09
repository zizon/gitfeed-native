/**
 * The library the screenshots in this directory were taken with.
 *
 * A public README must not picture somebody's real subscriptions, items, or
 * reading history, so the captures are of the plugin running against this
 * fixture instead: injected as an init script, it answers the reader's own
 * `/gitfeed/api/state` route with a demo library and accepts every mutation
 * without writing anything. Nothing here talks to a real data root.
 *
 * To retake the images: open the plugin page with this file as the document's
 * init script, then open an item and the folder picker.
 */

/* eslint-disable */
;(function demoLibrary() {
  const HOUR = 3600 * 1000
  const now = Date.now()
  const at = function (hoursAgo) { return new Date(now - hoursAgo * HOUR).toISOString() }

  const feeds = [
    { id: 'lwn', title: 'LWN.net', folder: 'Engineering', siteUrl: 'https://lwn.net/', url: 'https://lwn.net/headlines/rss', error: null, checkedAt: at(0.02), kind: 'rss' },
    { id: 'changelog', title: 'The Changelog', folder: 'Engineering', siteUrl: 'https://changelog.com/', url: 'https://changelog.com/feed', error: null, checkedAt: at(0.1), kind: 'rss' },
    { id: 'jvns', title: 'Julia Evans', folder: 'Engineering', siteUrl: 'https://jvns.ca/', url: 'https://jvns.ca/atom.xml', error: null, checkedAt: at(0.3), kind: 'rss' },
    { id: 'papers', title: 'Papers We Love', folder: 'Research', siteUrl: 'https://paperswelove.org/', url: 'https://paperswelove.org/feed', error: null, checkedAt: at(0.4), kind: 'rss' },
    { id: 'transformer', title: 'Transformer Circuits', folder: 'Research', siteUrl: 'https://transformer-circuits.pub/', url: 'https://transformer-circuits.pub/feed.xml', error: null, checkedAt: at(0.5), kind: 'rss' },
    { id: 'google', title: 'Google Research — Publications', folder: 'Research', siteUrl: 'https://research.google/pubs/', url: 'https://research.google/pubs/', error: null, checkedAt: at(0.6), kind: 'custom' },
    { id: 'hn', title: 'Hacker News', folder: 'News', siteUrl: 'https://news.ycombinator.com/', url: 'https://news.ycombinator.com/rss', error: null, checkedAt: at(0.2), kind: 'rss' },
    { id: 'lobsters', title: 'Lobsters', folder: 'News', siteUrl: 'https://lobste.rs/', url: 'https://lobste.rs/rss', error: null, checkedAt: at(0.7), kind: 'rss' },
    { id: 'tinkering', title: 'Tinkering Notes', folder: null, url: 'https://tinkering.example/feed.xml', siteUrl: 'https://tinkering.example/', error: null, checkedAt: at(0.8), kind: 'rss' },
  ]

  /** [title, feed, hours ago, author, summary] */
  const rows = [
    ['A feed reader that commits: notes after a year', 'lwn', 0.05, 'Sam Reyes',
      '<p>Every item, every mark, and every subscription in this reader is a line in a git repository I own. A year in, the parts that turned out to matter were not the ones I expected — and the parts I worried about never bit.</p>'
      + '<p>The first surprise was how much the <strong>append-only</strong> read state changed my behaviour. Marking something read is a commit against a file that only grows, so nothing I do while reading can destroy history. The second was that a reader is mostly a scheduler: the interesting decisions are all about when to check, not what to show.</p>'
      + '<p>This note covers the storage split, the scheduler, and the three mistakes I would not repeat.</p>'],
    ['Linux 6.14: the scheduler changes worth knowing', 'lwn', 0.9, 'Rebecca Chen',
      '<p>A look at the deadline scheduling work that landed this cycle, what it means for latency-sensitive workloads, and the two benchmarks that do not agree.</p>'],
    ['Why we moved our feed reader into the sidebar', 'changelog', 1.4, 'The Changelog',
      '<p>A conversation about reading tools that live beside your work instead of in another tab, and what that changes about how often you actually read.</p>'],
    ['How big is a virtualized list, really', 'jvns', 2.1, 'Julia Evans',
      '<p>Fixed-height rows, an offset index, and a scroll anchor: a short walk through the arithmetic that keeps a ten-thousand-row list from re-rendering itself.</p>'],
    ['Bottom-Up AI Agent Security: a layered framework', 'google', 2.8, null,
      '<p>Publication: a threat model for tool-using agents, organized from the sandbox outward.</p>'],
    ['Show HN: I built a terminal RSS reader in 400 lines', 'hn', 3.2, 'hn-user',
      '<p>Comments discuss the storage format, the fetch schedule, and whether read state belongs in git at all.</p>'],
    ['The three-state checkbox that ate an afternoon', 'tinkering', 3.9, 'A. Developer',
      '<p>What looked like a rendering bug was an optimistic update racing a reload. The fix was a queue and a debounce, and the lesson was about who owns the truth.</p>'],
    ['Reading a paper a week: what actually stuck', 'papers', 4.5, 'Marta Silva',
      '<p>Notes from a year of one paper per week, with the four that changed how I write code and the twenty that did not.</p>'],
    ['A2A: agent-to-agent protocols in practice', 'google', 5.1, null,
      '<p>Publication: an evaluation of interoperability between independently hosted agents.</p>'],
    ['Lobsters: what does your feed reader do with a broken feed?', 'lobsters', 5.7, 'lobster',
      '<p>A thread about failure modes: silent skips, red rows, and the one that made everyone argue — retry budgets.</p>'],
    ['Circuit tracing: a walkthrough', 'transformer', 6.4, 'Transformer Circuits',
      '<p>How a small model represents a simple algorithm, traced feature by feature, with the code to reproduce it.</p>'],
    ['The cost of a status line', 'changelog', 7.2, 'The Changelog',
      '<p>Polling for repository state every minute sounded cheap until it was not. What we changed, and the numbers.</p>'],
    ['Zines about debugging', 'jvns', 8.0, 'Julia Evans',
      '<p>Print, staple, and debug: a small collection of illustrations about the parts of programming nobody documents.</p>'],
    ['Show HN: read state as NDJSON', 'hn', 8.8, 'hn-user',
      '<p>One object per line, merged with union, and never rewritten. Comments ask the obvious question: what about deletes?</p>'],
    ['Multi-modal alignment for robotic control', 'google', 9.6, null,
      '<p>Publication: aligning vision and language embeddings for manipulation policies.</p>'],
    ['A tiny scheduler with adaptive intervals', 'tinkering', 10.5, 'A. Developer',
      '<p>Per-feed clocks, a backoff that only grows, and a debounce for reads. The whole thing is one interface with four methods.</p>'],
    ['What we learned deleting a server-side job', 'changelog', 11.3, 'The Changelog',
      '<p>Two hundred lines of workflow replaced by a timer that dies with the process, and why nobody missed it.</p>'],
    ['The Go Blog: profiling without a profiler', 'hn', 12.1, 'hn-user',
      '<p>Counting allocations by hand is old advice that still works when the tooling is not available.</p>'],
    ['Papers We Love: distributed consensus, revisited', 'papers', 13.0, 'Marta Silva',
      '<p>Rereading the Raft paper after a decade of production systems, with the sections that aged well.</p>'],
    ['Sparse attention: what the numbers say', 'transformer', 14.2, 'Transformer Circuits',
      '<p>A comparison of sparse and dense attention on long-context tasks, with the evaluation that changed our mind.</p>'],
    ['Notes on writing a plugin that does nothing on its own', 'lwn', 15.1, 'Sam Reyes',
      '<p>A plugin that owns no data and starts no server has a much smaller surface: the root is somewhere else, and the code can be public.</p>'],
    ['Lobsters: how do you keep a reading list?', 'lobsters', 16.4, 'lobster',
      '<p>Bookmarks, stars, and folders, and the people who use none of them.</p>'],
    ['A year of small tools', 'tinkering', 17.8, 'A. Developer',
      '<p>Twelve scripts, four still used daily, and the one that survived because it wrote nothing down.</p>'],
    ['Show HN: git as a database for personal data', 'hn', 19.2, 'hn-user',
      '<p>The comments split evenly between "obviously" and "please stop".</p>'],
    ['Visualising a scroll anchor', 'jvns', 20.9, 'Julia Evans',
      '<p>What actually happens to the viewport when rows land above the band you are reading.</p>'],
    ['Publication: constrained decoding for small models', 'google', 22.4, null,
      '<p>Publication: a grammar-guided decoder that runs inside the sampling loop.</p>'],
    ['Steady state maintenance', 'papers', 24.0, 'Marta Silva',
      '<p>A short paper on why the hard part of software is the second year.</p>'],
    ['The archive is the product', 'lwn', 26.5, 'Rebecca Chen',
      '<p>Feeds come and go; a durable local archive is what makes a reader worth keeping.</p>'],
    ['Reading in a sidebar, six months later', 'changelog', 29.0, 'The Changelog',
      '<p>Follow-up on a popular episode: what changed, and the two numbers that moved.</p>'],
    ['A copy of every article, forever', 'tinkering', 31.5, 'A. Developer',
      '<p>Retention is a policy, not a storage limit: what six months of items costs on disk.</p>'],
    ['Show HN: an RSS reader with no server', 'hn', 34.0, 'hn-user',
      '<p>Everything runs where you read it, which means nothing to deploy and nothing to keep running.</p>'],
    ['The folder that should not exist', 'jvns', 37.0, 'Julia Evans',
      '<p>On naming conventions that outlive the code that needed them.</p>'],
    ['Publication: measuring tool-use reliability', 'google', 40.0, null,
      '<p>Publication: an evaluation harness for agent tool calls across twelve models.</p>'],
    ['Blogroll as a data structure', 'lobsters', 43.0, 'lobster',
      '<p>How people organize a hundred subscriptions, and why folders beat tags here.</p>'],
    ['Scheduling without a cron daemon', 'tinkering', 46.0, 'A. Developer',
      '<p>Deadlines, not intervals: a one-method timer interface and the arithmetic behind it.</p>'],
    ['Where does the read state live?', 'lwn', 49.0, 'Sam Reyes',
      '<p>Append-only, union-merged, and never sorted: the file format that survives being edited by three machines.</p>'],
    ['A feed that is a script', 'transformer', 52.0, 'Transformer Circuits',
      '<p>When a publication list has no RSS, the feed is whatever a short script returns.</p>'],
    ['Papers We Love: the second read', 'papers', 55.0, 'Marta Silva',
      '<p>Rereading is the whole trick, and nobody does it.</p>'],
    ['Nightly builds of a personal archive', 'changelog', 58.0, 'The Changelog',
      '<p>What breaks when you rebuild a year of items from cache, and how to check you did it right.</p>'],
  ]

  const items = rows.map(function (row, index) {
    return {
      id: 'demo-' + String(index).padStart(2, '0'),
      feed: row[1],
      title: row[0],
      link: 'https://example.com/read/' + index,
      date: at(row[2]),
      author: row[3] || '',
      summary: row[4],
    }
  })

  // A mix of read and unread, and two stars, so the captures show real state.
  const read = items.filter(function (item, index) { return index % 3 === 0 }).map(function (item) { return item.id })
  const starred = [items[1].id, items[4].id]

  const state = {
    version: 'demo-1',
    itemsVersion: 'demo-items-1',
    items: items,
    feeds: feeds,
    read: read,
    starred: starred,
    reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
    git: { repo: true, branch: 'main', dirty: false, remotes: ['origin'], ahead: 0, behind: 0 },
    schedule: [],
    repo: '~/gitfeed',
    allowGit: true,
  }

  const realFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.indexOf('/gitfeed/api/state') !== -1) {
      return Promise.resolve(new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    if (url.indexOf('/gitfeed/api/') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, version: 'demo-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return realFetch(input, init)
  }
})()
