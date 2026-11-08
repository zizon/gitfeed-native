// The stand-alone CLI entry. esbuild packs this file and everything it imports
// into `lib/gitfeed.mjs`; `gitfeed ci` copies that bundle into a data
// repository, so the repository's scheduled job runs the fetcher without a
// checkout of this package.

import { main } from './cli.js'

const code = await main(process.argv.slice(2))
process.exitCode = code
