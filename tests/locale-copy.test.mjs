// The reader's copy contract with the shared locale service: the two baseline
// dictionaries agree key for key, every `{name}` placeholder is one the
// service's interpolator can fill, no component asks for a key neither
// dictionary carries, and no language beyond the baselines is registered — a
// missing language is the service's fallback chain, not a copy of English.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { finish, ok, repoRoot } from './harness.mjs'

const CLIENT_DIR = path.join(repoRoot, 'src', 'client')
const source = readFileSync(path.join(CLIENT_DIR, 'locales.ts'), 'utf8')

/** Split the module into its two dictionary literals. */
function dictBlock(startMarker, endMarker) {
  const from = source.indexOf(startMarker)
  const to = source.indexOf(endMarker)
  return from < 0 || to < from ? '' : source.slice(from, to)
}

/** `'key': 'text'` rows of one dictionary literal. */
function rows(block) {
  const out = new Map()
  for (const match of block.matchAll(/^\s+(?:'([^']+)'|([A-Za-z][\w]*)): '((?:[^'\\]|\\.)*)',$/gm)) {
    out.set(match[1] || match[2], match[3])
  }
  return out
}

const EN = rows(dictBlock('export const EN', 'export const ZH'))
const ZH = rows(dictBlock('export const ZH', 'export type Translate'))

ok(EN.size > 0 && ZH.size > 0, 'both baseline dictionaries parse', [EN.size, ZH.size])

const missingZh = [...EN.keys()].filter((key) => !ZH.has(key))
const missingEn = [...ZH.keys()].filter((key) => !EN.has(key))
ok(missingZh.length === 0, 'every English key has a Chinese row', missingZh)
ok(missingEn.length === 0, 'every Chinese key has an English row', missingEn)

// The service interpolates with /\{(\w+)\}/g, so any other brace form would
// reach the screen literally.
const PLACEHOLDER = /\{(\w+)\}/g
function placeholders(text) {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1])
}
const unformattable = []
for (const [dict, label] of [[EN, 'en'], [ZH, 'zh']]) {
  for (const [key, text] of dict) {
    if (text.replace(PLACEHOLDER, '').includes('{') || text.replace(PLACEHOLDER, '').includes('}')) {
      unformattable.push(`${label}:${key}`)
    }
  }
}
ok(unformattable.length === 0, 'every placeholder is a bare name the service can fill', unformattable)

const asymmetric = [...EN.keys()].filter((key) => {
  const en = placeholders(EN.get(key) || '').sort().join(',')
  const zh = placeholders(ZH.get(key) || '').sort().join(',')
  return en !== zh
})
ok(asymmetric.length === 0, 'both languages fill the same placeholders', asymmetric)

function clientFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...clientFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const asked = new Map()
for (const file of clientFiles(CLIENT_DIR)) {
  if (path.basename(file) === 'locales.ts') continue
  for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([^']+)'/g)) {
    if (!asked.has(match[1])) asked.set(match[1], path.relative(repoRoot, file))
  }
}
ok(asked.size > 0, 'components ask for keys through the translate seat', asked.size)

const unresolved = [...asked.keys()].filter((key) => !EN.has(key) || !ZH.has(key))
ok(unresolved.length === 0, 'every requested key resolves in both dictionaries', unresolved)

ok(
  /export const DICTS = \{ en: EN, zh: ZH \}/.test(source),
  'only the two baseline dictionaries are registered',
)
ok(
  !/export function tf\b/.test(source),
  'no hand-rolled interpolation helper',
)

finish()
