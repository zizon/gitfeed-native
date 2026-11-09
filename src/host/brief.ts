// What the plugin tells every session, once, without being asked.
//
// A README is a file: installing a package does not put it in front of an
// agent. The surfaces that are actually in context are the tool descriptions,
// the skill catalog, and a prompt section — so the invariants live here, and
// everything longer stays in README.md, because a prompt section is paid on
// every assembly of every session in the profile.

import { fileURLToPath } from 'node:url'
import type { PluginContext, SystemPrompt } from './types.js'

/** From `lib/host/` to the package root, where the manual is. */
const README = fileURLToPath(new URL('../../README.md', import.meta.url))

/**
 * The section's text: the facts an agent must not have to discover, and a
 * path to the rest.
 * @param input the data root, and whether the authoring skill is registered.
 * @returns five lines of context.
 */
export function briefText(input: { root: string; skill: boolean }): string {
  const lines = [
    `gitfeed is loaded: a git-backed RSS reader, with its data root at ${input.root}.`,
    '- `data/` is the archive to commit and the read/star state; `.local/` is a local refresh cache that is never committed.',
    "- Changing plugin config, an environment variable, or this package's code needs the Host restarted. Editing feeds.json, config.json, a custom feed script, or the data does not.",
    '- When the reader looks wrong, call `gitfeed` with action `status` first: it reports the repo, git state, the scheduler\'s last run and next due, and the feeds that are failing.',
    `- The full guide is ${README}.`,
  ]
  if (input.skill) {
    lines[lines.length - 1] += ' The `custom-feeds` skill covers authoring a feed for a page that has no feed.'
  }
  return lines.join('\n')
}

/**
 * The registry names no slot for a third-party brief, so this sits in the gap
 * after the tool sections; equal orders fall back to name order, so a second
 * plugin choosing the same number still assembles deterministically.
 */
const ORDER = 3001

/**
 * Register the brief on a context that has the SystemPrompt service.
 * @param {object} ctx context or child context with `systemPrompt`.
 * @param {object} input the data root, and whether the authoring skill is on.
 * @returns {() => void} disposer.
 */
export function registerBrief(
  ctx: PluginContext & { systemPrompt: SystemPrompt },
  input: { root: string; skill: boolean },
): () => void {
  return ctx.systemPrompt.section({ name: 'gitfeed:brief', order: ORDER, text: briefText(input) })
}
