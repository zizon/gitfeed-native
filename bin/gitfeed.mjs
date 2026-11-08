#!/usr/bin/env node
// `gitfeed` entry point: `npx gitfeed fetch`, or `node bin/gitfeed.mjs …`.
// The implementation lives in the built Host tree so the CLI, the plugin, and
// the GitHub Actions job share one fetcher.

import { main } from "../lib/cli.js";

const code = await main(process.argv.slice(2));
process.exitCode = code;
