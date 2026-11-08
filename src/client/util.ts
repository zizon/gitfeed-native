/** Formatting, storage, and the untrusted-HTML sanitizer. */

import { LS } from "./constants.js";

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function messageOf(err) {
  return String((err && err.message) || err || 'unknown error').trim() || 'unknown error'
}

export function fmtTime(iso) {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  const minute = 60000
  const hour = 3600000
  const day = 86400000
  if (diff < minute) return 'now'
  if (diff < hour) return Math.floor(diff / minute) + 'm'
  if (diff < day) return Math.floor(diff / hour) + 'h'
  if (diff < 7 * day) return Math.floor(diff / day) + 'd'
  return new Date(iso).toISOString().slice(0, 10)
}

export function fmtDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch (err) {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

const OK_TAGS = new Set([
  'A', 'P', 'BR', 'DIV', 'SPAN', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
  'EM', 'STRONG', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'FIGURE', 'FIGCAPTION', 'IMG', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR',
  'TD', 'TH', 'SUP', 'SUB', 'SMALL', 'MARK', 'DL', 'DT', 'DD', 'VIDEO', 'AUDIO',
  'PICTURE', 'SOURCE', 'CITE'
])

const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON',
  'LINK', 'META', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'BASE', 'CANVAS'
])

export function safeUrl(raw, base) {
  if (!raw) return null
  let url
  try {
    url = new URL(String(raw).trim(), base || window.location.href)
  } catch (err) {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return url.href
  return null
}

export function cleanTree(el) {
  const kids = Array.prototype.slice.call(el.children)
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
    const attrs = Array.prototype.slice.call(child.attributes)
    for (const attr of attrs) {
      const name = attr.name.toLowerCase()
      if (name === 'href' || name === 'src' || name === 'alt' || name === 'title') continue
      child.removeAttribute(attr.name)
    }
  }
}

export function sanitize(html, base) {
  const doc = new DOMParser().parseFromString("<div id='sandbox'>" + String(html || '') + '</div>', 'text/html')
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

export function plainFromHtml(html) {
  if (!html) return ''
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html')
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
  } catch (err) {
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
export function digestText(html, max = 240) {
  const text = plainFromHtml(html)
  // Link labels such as "Comments" or "Read on" are not a summary worth a row.
  if (text.length < 16) return ''
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return (at > max * 0.55 ? cut.slice(0, at) : cut).trimEnd() + '…'
}

export function readStorage(key) {
  try {
    return localStorage.getItem(key)
  } catch (err) {
    return null
  }
}

export function writeStorage(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, String(value))
  } catch (err) {
    // Private mode and quota failures leave the in-memory value usable.
  }
}

export function storedBool(key) {
  const raw = readStorage(key)
  return raw === null ? null : raw !== '0'
}

export function storedNumber(key, fallback) {
  const value = Number(readStorage(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function storedFolders(): Record<string, boolean> {
  try {
    const value = JSON.parse(readStorage(LS.folders) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch (err) {
    return {}
  }
}
