// Reading a URL as a document: what the request says it is, what came back,
// and the one classifier that answers "is this a feed?".
//
// Both readers of a URL share this layer and differ above it. `resolveFeed`
// (feeds.ts) is the add-time resolver: a site page is normal there, so it
// discovers the feed behind it and rejects a bad add with a message a form can
// show. `fetchRss` (fetch.ts) is the poller: the URL is known to be a feed, the
// request is conditional, and a 304 is an answer rather than an error. The
// request itself, the user agent, the accepts, and the "is it a feed" rule are
// not two questions, so they live here.

/** What every request this package makes says it is. */
export const USER_AGENT = 'gitfeed/2.0 (+https://github.com; personal RSS reader)'

/** The accept a request for a known feed sends. */
export const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5'

/** The accept a request that may land on a site page sends. */
export const PAGE_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5'

/** One response, body read, with the URL redirects landed on. */
interface DocumentResponse {
  status: number
  headers: Headers
  body: string
  finalUrl: string
}

/**
 * Request a URL and read it as text.
 *
 * The status is the caller's to judge: a resolver rejects a non-2xx with the
 * message its form shows, while a poller treats 304 as an answer and records
 * anything else per feed. Redirects are followed either way, and `finalUrl` is
 * where the document actually came from.
 * @param url - absolute http(s) URL.
 * @param options - headers to send and the clock that stops the read.
 * @returns the response.
 */
export async function readDocument(url: string, options: {
  headers: Record<string, string>
  signal: AbortSignal
}): Promise<DocumentResponse> {
  const res = await fetch(url, { headers: options.headers, redirect: 'follow', signal: options.signal })
  return {
    status: res.status,
    headers: res.headers,
    // A 304 carries no body; reading it is still correct, and keeps one shape.
    body: await res.text(),
    finalUrl: res.url || url,
  }
}

/** What a response body is, as far as a feed reader is concerned. */
type DocumentKind = 'feed' | 'page' | 'other'

/**
 * Whether a response is a feed, a site page, or neither.
 *
 * The content-type alone is not enough in either direction. Sites serve XHTML as
 * `application/xhtml+xml`, which an /xml/ test accepts and then parses as an
 * empty feed; feeds are served as `text/plain`, or as a generic
 * `application/xml`. So the body opens the question — after the BOM, the XML
 * prolog, and a leading comment, every one of which a real feed may carry — and
 * the content-type only answers when the body does not.
 *
 * The match is anchored on the document's first markup on purpose: an HTML page
 * may legally contain a `<channel>` element, and scanning for one is how a page
 * gets mistaken for a feed.
 * @param contentType - the response's content-type, or null.
 * @param body - the body as text.
 * @returns the kind.
 */
export function classifyDocument(contentType: string | null, body: string): DocumentKind {
  const head = body
    .slice(0, 4000)
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
    .replace(/^\s*<!--[\s\S]*?-->\s*/, '')
    .trimStart()
  if (/^<(rss|feed|rdf)(?=[\s:>])/i.test(head)) return 'feed'
  if (/^<(!doctype\s+html|html)(?=[\s>])/i.test(head)) return 'page'
  if (/(rss|atom)\+xml/i.test(contentType || '')) return 'feed'
  return 'other'
}
