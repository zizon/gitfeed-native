// Google Research — Publications, as a custom gitfeed feed.
//
// The publication list has no feed and no API: it is one page of cards. Copy
// this file into `<data root>/sources/`, declare it in feeds.json, and Refresh:
//
//   {
//     "id": "research-google-pubs",
//     "url": "https://research.google/pubs/",
//     "title": "Google Research — Publications",
//     "folder": "Papers",
//     "type": "custom",
//     "script": "sources/google-research.mjs"
//   }
//
// A custom feed script is the default export of a `.mjs` file in the data
// repository. It is called with the subscription and returns a pseudo feed; the
// fetcher then treats it exactly like an RSS feed. docs/custom-feeds.md has the
// whole interface.

export default async function (input) {
  const answer = await input.fetch(input.url, {
    headers: { 'user-agent': 'gitfeed/3 (+https://github.com/zizon/gitfeed-native)' },
    redirect: 'follow',
    signal: input.signal,
  })
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

  // An empty list is a redesign far more often than it is an empty year, and a
  // thrown error is what puts the feed's row in the reader's error colour.
  if (cards.length === 0) throw new Error('no publication cards on the page')

  // The cards carry no date, so the fetcher stamps each with the moment it was
  // first seen, in page order: the first card is the newest and stays so.
  return {
    title: 'Google Research — Publications',
    siteUrl: 'https://research.google/pubs/',
    items: cards,
  }
}

function text(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
