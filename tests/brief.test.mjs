// The prompt brief: the only statement about this plugin that reaches every
// session in the profile without being asked for. It has to fit this shape —
// the data root, the two stores, the restart boundary, the diagnosis entry
// point, and a guide that exists — or an agent is back to guessing.

import { existsSync } from 'node:fs'
import { finish, lib, ok } from './harness.mjs'

const { briefText, registerBrief } = await import(lib('host', 'brief.js'))

const text = briefText({ root: '/home/someone/gitfeed', skill: true })
const lines = text.split('\n')
ok(text.includes('/home/someone/gitfeed'), 'the brief names the data root')
ok(/data\//.test(text) && /\.local\//.test(text), 'and tells the two stores apart')
ok(/never committed/.test(text), 'and which one is not committed', text)
ok(/needs the Host restarted/.test(text), 'and what needs a restart')
ok(/feeds\.json/.test(text) && /does not/.test(text), 'and what does not')
ok(/`status`/.test(text), 'and where to start diagnosing')
ok(/custom-feeds/.test(text) && /skill/.test(text), 'and names the authoring skill')

const named = text.match(/(\/[^\s`]*README\.md)/)
ok(!!named && existsSync(named[1]), 'the guide it points at exists', named && named[1])

const withoutSkill = briefText({ root: '/r', skill: false })
ok(!/custom-feeds/.test(withoutSkill), 'the skill is not named when it is switched off')
ok(lines.length <= 5, 'the brief stays a brief', lines.length)

const sections = []
const ctx = {
  systemPrompt: {
    section(section) {
      sections.push(section)
      return function () {}
    },
  },
}
const dispose = registerBrief(ctx, { root: '/r', skill: true })
ok(sections.length === 1 && sections[0].name === 'gitfeed:brief', 'one named section is registered', sections)
ok(Number.isFinite(sections[0].order), 'with a finite order', sections[0].order)
ok(sections[0].text.includes('/r'), 'carrying the data root it was given')
ok(typeof dispose === 'function', 'and it returns a disposer')

finish()
