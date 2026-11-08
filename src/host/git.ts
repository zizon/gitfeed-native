// Git operations for the reader: state, pull, and the commit/push sync.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function message(err) {
  if (!err) return "unknown error";
  const text = String(err.stderr || err.message || err).trim();
  return text.split("\n").slice(0, 6).join("\n");
}

/**
 * Run one git command in the checkout.
 * @param {string} root checkout directory.
 * @param {string[]} args git arguments.
 * @returns {Promise<string>} stdout.
 */
export async function runGit(root, args) {
  const result = await execFileAsync("git", args, {
    cwd: root,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024
  });
  return String(result.stdout || "");
}

/**
 * Branch, dirty state, remotes, and divergence for the status line.
 *
 * The check is `rev-parse --git-dir`, not a branch lookup: a freshly
 * `git init`-ed directory has no HEAD yet but is still a working tree the
 * reader may commit into.
 * @param {string} root checkout directory.
 * @returns {Promise<object>} repository facts.
 */
export async function readGitInfo(root) {
  try {
    await runGit(root, ["rev-parse", "--git-dir"]);
  } catch (err) {
    return { repo: false, error: message(err) };
  }
  try {
    let branch = "";
    try {
      branch = (await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (err) {
      // An empty repository has no commit to name.
    }
    const dirty = (await runGit(root, ["status", "--porcelain", "--", "data", "feeds.json", "config.json"])).trim().length > 0;
    const remotes = (await runGit(root, ["remote"])).trim().split("\n").filter(Boolean);
    let ahead = 0;
    let behind = 0;
    try {
      const counts = (await runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim().split(/\s+/);
      ahead = Number(counts[0] || 0);
      behind = Number(counts[1] || 0);
    } catch (err) {
      // no upstream configured
    }
    return { repo: true, branch: branch || null, dirty: dirty, remotes: remotes, ahead: ahead, behind: behind };
  } catch (err) {
    return { repo: false, error: message(err) };
  }
}

/**
 * Pull with a rebase, preserving uncommitted read state.
 * @param {string} root checkout directory.
 * @returns {Promise<{ok:boolean, action:string, output?:string, error?:string}>} settled result.
 */
export async function pull(root) {
  try {
    const output = await runGit(root, ["pull", "--rebase", "--autostash"]);
    return { ok: true, action: "pull", output: output.trim() };
  } catch (err) {
    return { ok: false, action: "pull", error: message(err) };
  }
}

/**
 * Commit the reader's state files, rebase on the remote, and push.
 *
 * A local copy that was attached to a repository in place (`git init`, then a
 * remote) may have no upstream yet and no merge history; the pull is therefore
 * best-effort and the push falls back to `-u origin HEAD`. A rejected push
 * still surfaces the remote's own error. The very first commit of such a
 * directory takes the whole seeded tree as the baseline, so the item shards it
 * copied from the bundle are tracked from then on.
 * @param {string} root checkout directory.
 * @returns {Promise<{ok:boolean, action:string, committed?:boolean, output?:string, error?:string}>} settled result.
 */
export async function sync(root) {
  try {
    let hasHead = true;
    try {
      await runGit(root, ["rev-parse", "--verify", "HEAD"]);
    } catch (err) {
      hasHead = false;
    }
    if (hasHead) {
      await runGit(root, ["add", "--", "data/read.ndjson", "data/starred.ndjson", "feeds.json", "config.json"]);
      for (const extra of [".gitattributes", ".gitignore"]) {
        if (existsSync(path.join(root, extra))) await runGit(root, ["add", "--", extra]);
      }
    } else {
      await runGit(root, ["add", "-A"]);
    }
    let staged = "";
    try {
      staged = await runGit(root, ["diff", "--cached", "--name-only"]);
    } catch (err) {
      staged = "";
    }
    let committed = false;
    if (staged.trim()) {
      await runGit(root, ["commit", "-m", "reader: sync state"]);
      committed = true;
    }
    try {
      await runGit(root, ["pull", "--rebase", "--autostash"]);
    } catch (err) {
      // No upstream yet (a fresh `git init` + remote) or a diverged history:
      // the push below is the authority on whether the result is on the remote.
    }
    try {
      await runGit(root, ["push"]);
    } catch (err) {
      await runGit(root, ["push", "-u", "origin", "HEAD"]);
    }
    return { ok: true, action: "sync", committed: committed, output: "read state pushed" };
  } catch (err) {
    return { ok: false, action: "sync", error: message(err) };
  }
}

export function gitErrorText(err) {
  return message(err);
}
