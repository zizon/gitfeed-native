// Dependency-free RSS 2.0 / Atom / RSS 1.0 extraction.
//
// This is deliberately not a general XML parser. It pulls out the handful of
// elements a reader needs and shrugs at the malformed markup that real feeds
// ship with. Anything it cannot find simply comes back empty.

const NAMED: Record<string, string | undefined> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  middot: '\u00b7', bull: '\u2022', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  deg: '\u00b0', times: '\u00d7', laquo: '\u00ab', raquo: '\u00bb',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', sect: '\u00a7', para: '\u00b6',
}

export function decodeEntities(input: string | null | undefined): string {
  const s = input == null ? '' : input
  if (s.indexOf('&') === -1) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (all: string, body: string) {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all
      try {
        return String.fromCodePoint(code)
      } catch {
        return all
      }
    }
    const named = NAMED[body.toLowerCase()]
    return named === undefined ? all : named
  })
}

export function stripCdata(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

// Raw element body -> display string. CDATA is literal (already HTML), plain
// text is entity-decoded; in a body that mixes the two, only the text outside
// the CDATA sections is decoded.
export function unwrap(raw: string | null | undefined): string {
  if (raw == null) return ''
  const s = raw.trim()
  if (s.indexOf('<![CDATA[') === -1) return decodeEntities(s).trim()
  return s
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map(function (part) {
      if (part.startsWith('<![CDATA[')) return part.slice(9, -3)
      return decodeEntities(part)
    })
    .join('')
    .trim()
}

// Raw element body -> plain text with markup removed. The strip comes first:
// decoding first would turn escaped markup such as `&lt;b&gt;` into a tag, and
// the strip would then delete it together with the text it wrapped.
export function textOf(raw: string | null | undefined): string {
  if (raw == null) return ''
  const s = stripCdata(raw).replace(/<[^>]*>/g, ' ')
  return decodeEntities(s).replace(/\s+/g, ' ').trim()
}

export interface Tag {
  inner: string
  attrs: string
  selfClosing: boolean
}

export function attr(attrs: string | null | undefined, name: string): string | null {
  if (!attrs) return null
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const m = re.exec(attrs)
  if (!m) return null
  const groups: Array<string | undefined> = m
  const value = groups[2] ?? groups[3]
  return decodeEntities(value).trim()
}

export function findTag(xml: string | null | undefined, name: string): Tag | null {
  if (!xml) return null
  const open = new RegExp(`<${name}(?=[\\s/>])[^>]*>`, 'i')
  const m = open.exec(xml)
  if (!m) return null
  const tag = m[0]
  const selfClosing = /\/>\s*$/.test(tag)
  const attrs = tag.slice(name.length + 1, selfClosing ? tag.length - 2 : tag.length - 1)
  if (selfClosing) return { inner: '', attrs: attrs, selfClosing: true }
  const start = m.index + tag.length
  const close = new RegExp(`</${name}\\s*>`, 'i').exec(xml.slice(start))
  if (!close) return null
  return { inner: xml.slice(start, start + close.index), attrs: attrs, selfClosing: false }
}

function tagText(xml: string, names: string[]): string {
  for (let i = 0; i < names.length; i++) {
    const t = findTag(xml, names[i])
    if (!t || t.selfClosing) continue
    const value = textOf(t.inner)
    if (value) return value
  }
  return ''
}

function tagRaw(xml: string, names: string[]): string {
  for (let i = 0; i < names.length; i++) {
    const t = findTag(xml, names[i])
    if (!t || t.selfClosing) continue
    const value = unwrap(t.inner)
    if (value) return value
  }
  return ''
}

function linkOf(xml: string): string | null {
  const textLink = findTag(xml, 'link')
  if (textLink && !textLink.selfClosing) {
    const value = unwrap(textLink.inner).trim()
    if (value) return value
  }
  const re = /<link\b([^>]*)>/gi
  let fallback = null
  let m
  while ((m = re.exec(xml))) {
    const href = attr(m[1], 'href')
    if (!href) continue
    const rel = (attr(m[1], 'rel') || 'alternate').toLowerCase()
    if (rel === 'alternate') return href
    if (!fallback) fallback = href
  }
  return fallback
}

export interface ParsedItem {
  guid: string
  link: string
  title: string
  date: string
  author: string
  summary: string
}

export interface ParsedFeed {
  title: string | null
  siteUrl: string | null
  items: ParsedItem[]
}

export function parseFeed(xml: string): ParsedFeed {
  const channel = findTag(xml, 'channel') || findTag(xml, 'feed')
  const feedXml = channel && !channel.selfClosing ? channel.inner : xml
  // Everything before the first item carries the feed-level metadata.
  const head = feedXml.split(/<(?:item|entry)(?=[\s>])/i)[0]

  const result: ParsedFeed = {
    title: textOf(findTag(head, 'title')?.inner) || null,
    siteUrl: linkOf(head),
    items: [],
  }

  const blocks = /<(item|entry)(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi
  let m
  while ((m = blocks.exec(xml))) {
    const block = m[0]
    const openAttrs = m[2] || ''
    // Strip bodies that are prose so an inline <link> or <title> in the HTML
    // cannot be mistaken for the entry's own link.
    const linkBlock = block.replace(/<(description|summary|content|content:encoded)\b[\s\S]*?<\/\1\s*>/gi, '')

    const guid = tagText(block, ['guid', 'id']) || attr(openAttrs, 'rdf:about') || ''
    const link = linkOf(linkBlock) || ''
    if (!guid && !link) continue

    result.items.push({
      guid: guid,
      link: link,
      title: tagText(block, ['title']),
      date: tagText(block, ['published', 'pubDate', 'updated', 'dc:date', 'date', 'created']),
      author: tagText(block, ['dc:creator', 'creator', 'author', 'name']),
      summary: tagRaw(block, ['content:encoded', 'content', 'description', 'summary', 'media:description', 'excerpt']),
    })
  }

  return result
}
