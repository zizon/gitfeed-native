// The skill a custom feed author is given: the workflow, the interface, and the
// failure modes. The body is markdown in `src/skill/`, copied beside the built
// Host half by `build.mjs`, so the guide stays readable in the repository and
// ships with the package instead of being a string literal in code.

import { readFileSync } from 'node:fs'
import type { PluginContext, SkillRegistration, Skills } from './types.js'

/** The markdown, next to this module once `lib/skill/` is copied. */
const FILE = new URL('../skill/custom-feeds.md', import.meta.url)

/**
 * Split a skill's frontmatter from its body.
 *
 * Only the flat `key: value` lines this package writes are understood: a real
 * YAML parser would be a dependency for three keys.
 * @param raw the markdown file.
 * @returns the registration the Harness catalog takes.
 */
export function parseSkill(raw: string): SkillRegistration {
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('gitfeed skill: the file has no frontmatter')
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at === -1) continue
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  if (!fields.name || !fields.description) {
    throw new Error('gitfeed skill: the frontmatter needs a name and a description')
  }
  const skill: SkillRegistration = {
    name: fields.name,
    description: fields.description,
    content: match[2].trim(),
  }
  if (fields.whenToUse) skill.whenToUse = fields.whenToUse
  return skill
}

/**
 * Register the custom feed skill on a context that has the Skill registry.
 * @param {object} ctx context or child context with `skills`.
 * @returns {() => void} disposer.
 */
export function registerSkill(ctx: PluginContext & { skills: Skills }): () => void {
  return ctx.skills.register(parseSkill(readFileSync(FILE, 'utf8')))
}
