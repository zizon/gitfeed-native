// Stopping a run: a reader that unloads mid-fetch must not keep the network
// busy, and the feeds it did not get to must not be judged — an interrupted read
// says nothing about whether a source is broken. The stop is the run's own
// signal, checked before each feed and combined with the per-feed deadline, so
// the read in flight ends too.
import http from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { makeDataRoot, removeRoot } from './fixtures.mjs'
import { finish, lib, nodeTimers, ok } from './harness.mjs'

const { runFetch } = await import(lib('host', 'fetch.js'))
const { createGitfeed } = await import(lib('host', 'service.js'))

let requests = 0
/** Resolves when a read starts; the test waits for the read before stopping it. */
let started = null
const pending = new Set()
const server = http.createServer(function (req, res) {
  requests += 1
  if (req.url === '/feed') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Fast</title>'
      + '<item><title>One</title><link>https://example.com/1</link><guid>1</guid>'
      + '<pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate><description>a body</description></item>'
      + '</channel></rss>')
    return
  }
  // Deliberately never ends: the run is stopped while this read is open.
  pending.add(res)
  res.on('error', function () { /* the client went away */ })
  res.on('close', function () { pending.delete(res) })
  if (started) {
    const notify = started
    started = null
    notify()
  }
})
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
const root = makeDataRoot({ feeds: [{ id: 'slow', url: `${origin}/slow`, title: 'Slow' }] })
const metaFile = path.join(root, '.local', 'meta.json')

// --- a stop already in effect never starts a run ---
const early = new AbortController()
early.abort()
const before = requests
const stoppedEarly = await runFetch({ root: root, dataDir: '.local', signal: early.signal })
ok(stoppedEarly.summary === 'stopped before the run finished',
  'a signal already aborted answers with the stop, not a verdict', stoppedEarly.summary)
ok(stoppedEarly.feeds === 1 && stoppedEarly.fresh === 0 && stoppedEarly.failed === 0,
  'the feed set is reported but nothing is counted against it', stoppedEarly)
ok(requests === before, 'and no request went out', requests - before)
ok(!existsSync(metaFile), 'nor was any health written', existsSync(metaFile))

// --- a stop mid-run cuts the read in flight and judges nothing ---
const mid = new AbortController()
started = null
const running = runFetch({ root: root, dataDir: '.local', signal: mid.signal })
await new Promise(function (resolve) { started = resolve })
mid.abort()
const stoppedMid = await running
ok(stoppedMid.summary === 'stopped before the run finished',
  'a run stopped while a read is open answers with the stop too', stoppedMid.summary)
ok(stoppedMid.failed === 0 && stoppedMid.offline === false,
  'the interrupted feed is not reported as broken, and the run is not called offline', stoppedMid)
ok(!existsSync(metaFile), 'and nothing was written about it', existsSync(metaFile))

// --- the machinery still runs when nothing stops it ---
const fastRoot = makeDataRoot({ feeds: [{ id: 'fast', url: `${origin}/feed`, title: 'Fast' }] })
const normal = await runFetch({ root: fastRoot, dataDir: '.local' })
ok(normal.failed === 0 && normal.fresh === 1, 'an unstopped run reads the feed and lands its row', normal)
ok(existsSync(path.join(fastRoot, '.local', 'meta.json')), 'and writes what it learned')
removeRoot(fastRoot)

// --- the reader owns the signal: unloading stops the run it started ---
const serviceRoot = makeDataRoot({ feeds: [{ id: 'slow', url: `${origin}/slow`, title: 'Slow' }] })
const service = createGitfeed({ root: serviceRoot, timers: nodeTimers(), allowGit: false, refreshMinutes: 0, syncMinutes: 0 })
const owned = service.runLocalFetch({ only: 'slow' })
await new Promise(function (resolve) { started = resolve })
service.dispose()
const stoppedByUnload = await owned
ok(stoppedByUnload.summary === 'stopped before the run finished',
  'the reader unloading stops the run it owns, and the caller gets the stop', stoppedByUnload.summary)
removeRoot(serviceRoot)

for (const res of pending) res.destroy()
if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
server.close()
removeRoot(root)
finish()
