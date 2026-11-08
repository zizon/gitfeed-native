/** Formatting and the untrusted-HTML sanitizer. */

import { DIGEST_CHARS } from './constants.js'

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function messageOf(err: unknown): string {
  if (typeof err === 'string') return err.trim() || 'unknown error'
  if (err instanceof Error) return err.message.trim() || 'unknown error'
  const failure = err as { message?: unknown } | null
  return typeof failure?.message === 'string' && failure.message.trim() ? failure.message.trim() : 'unknown error'
}

export function fmtTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  const minute = 60000
  const hour = 3600000
  const day = 86400000
  if (diff < minute) return 'now'
  if (diff < hour) return `${Math.floor(diff / minute)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`
  return new Date(iso).toISOString().slice(0, 10)
}

export function fmtIn(iso: string): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const diff = time - Date.now()
  if (diff <= 0) return 'now'
  const hour = 3600000
  const day = 86400000
  if (diff < hour) return `${Math.max(1, Math.round(diff / 60000))}m`
  if (diff < day) return `${Math.round(diff / hour)}h`
  return `${Math.round(diff / day)}d`
}

export function fmtDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

const OK_TAGS = new Set([
  'A', 'P', 'BR', 'DIV', 'SPAN', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
  'EM', 'STRONG', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'FIGURE', 'FIGCAPTION', 'IMG', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR',
  'TD', 'TH', 'SUP', 'SUB', 'SMALL', 'MARK', 'DL', 'DT', 'DD', 'VIDEO', 'AUDIO',
  'PICTURE', 'SOURCE', 'CITE',
])

const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON',
  'LINK', 'META', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'BASE', 'CANVAS',
])

function safeUrl(raw: string | null | undefined, base?: string | null): string | null {
  if (!raw) return null
  let url
  try {
    url = new URL(raw.trim(), base || window.location.href)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return url.href
  return null
}

function cleanTree(el: Element): void {
  const kids = Array.from(el.children)
  for (const child of kids) {
    if (DROP_TAGS.has(child.tagName)) {
      child.remove()
      continue
    }
    if (child.tagName === 'IMG' && !child.getAttribute('src')) {
      const lazy = child.getAttribute('data-src') || child.getAttribute('data-original')
      if (lazy) child.setAttribute('src', lazy)
    }
    cleanTree(child)
    if (!OK_TAGS.has(child.tagName)) {
      const fragment = document.createDocumentFragment()
      while (child.firstChild) fragment.appendChild(child.firstChild)
      child.replaceWith(fragment)
      continue
    }
    const attrs = Array.from(child.attributes)
    for (const attr of attrs) {
      const name = attr.name.toLowerCase()
      if (name === 'href' || name === 'src' || name === 'alt' || name === 'title') continue
      child.removeAttribute(attr.name)
    }
  }
}

export function sanitize(html: string | null | undefined, base?: string | null): string {
  const doc = new DOMParser().parseFromString(`<div id='sandbox'>${html || ''}</div>`, 'text/html')
  const root = doc.getElementById('sandbox')
  if (!root) return ''
  cleanTree(root)
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = safeUrl(anchor.getAttribute('href'), base)
    if (!href) {
      anchor.removeAttribute('href')
      continue
    }
    anchor.setAttribute('href', href)
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer')
  }
  for (const img of root.querySelectorAll('img')) {
    const src = safeUrl(img.getAttribute('src'), base)
    if (!src) {
      img.remove()
      continue
    }
    img.setAttribute('src', src)
    img.setAttribute('loading', 'lazy')
  }
  for (const media of root.querySelectorAll('video, audio, source')) {
    const src = safeUrl(media.getAttribute('src'), base)
    if (!src) media.remove()
    else media.setAttribute('src', src)
  }
  return root.innerHTML
}

export function plainFromHtml(html: string | null | undefined): string {
  if (!html) return ''
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/**
 * A one-line digest of a feed entry's summary: its plain text, cut at a word
 * boundary so a list row can show it without wrapping.
 * @param {string} html entry summary, usually feed HTML.
 * @param {number} [max] most characters kept before the ellipsis.
 * @returns {string} digest text, empty when the entry has no summary.
 */
export function digestText(html: string | null | undefined, max = DIGEST_CHARS): string {
  const text = plainFromHtml(html)
  // Link labels such as "Comments" or "Read on" are not a summary worth a row.
  if (text.length < 16) return ''
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return `${(at > max * 0.55 ? cut.slice(0, at) : cut).trimEnd()}…`
}
