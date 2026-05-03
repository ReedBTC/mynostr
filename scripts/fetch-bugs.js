#!/usr/bin/env node
/**
 * fetch-bugs.js — pull recent bug reports off relay.mynostr.app.
 *
 * Speaks raw NIP-01 over the Node 22+ built-in WebSocket so we don't
 * pay the dep cost of a full Nostr client lib for a one-shot triage
 * fetch. Output is pretty-printed JSON to stdout; redirect to a file
 * and ask Claude to read it.
 *
 * Usage (direct invocation):
 *   node scripts/fetch-bugs.js              # last 7 days, pretty
 *   node scripts/fetch-bugs.js --days 30
 *   node scripts/fetch-bugs.js --since 1735689600
 *   node scripts/fetch-bugs.js --limit 50
 *
 * Usage via npm — npm consumes its own flags before forwarding, so any
 * flags for this script must come after `--`:
 *   npm run bugs                            # last 7 days
 *   npm run bugs -- --days 30
 *   npm run bugs -- --limit 50
 *   npm run bugs -- --days 30 > /tmp/bugs.json
 *
 * Triage workflow:
 *   npm run bugs > /tmp/bugs.json
 *   then ask Claude: "review /tmp/bugs.json and propose fixes"
 */

const RELAY    = 'wss://relay.mynostr.app'
const BUG_TAG  = 'mynostr-alpha'
const TIMEOUT_MS = 15_000

function parseArgs(argv) {
  const out = { days: 7, since: null, limit: 200 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days')  out.days  = Number(argv[++i])
    else if (a === '--since') out.since = Number(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv)
  const since = args.since || Math.floor(Date.now() / 1000) - args.days * 86400

  const ws = new WebSocket(RELAY)
  const events = []
  const subId = 'bugs-' + Math.random().toString(36).slice(2, 8)
  let timer

  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)

    ws.addEventListener('open', () => {
      const filter = { kinds: [1], '#t': [BUG_TAG], since, limit: args.limit }
      ws.send(JSON.stringify(['REQ', subId, filter]))
    })

    ws.addEventListener('message', ev => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (!Array.isArray(msg)) return
      const [type, sub, payload] = msg
      if (sub !== subId) return
      if (type === 'EVENT' && payload) events.push(payload)
      else if (type === 'EOSE') {
        try { ws.send(JSON.stringify(['CLOSE', subId])) } catch {}
        ws.close()
        resolve()
      }
    })

    ws.addEventListener('error', err => {
      // 'error' isn't an Error instance — pull whatever's there.
      const detail =
        err?.message ||
        err?.error?.message ||
        err?.code ||
        err?.target?.url ||
        err?.type ||
        'unknown'
      reject(new Error(`WS error: ${detail}`))
    })
    ws.addEventListener('close', () => resolve())
  })

  try {
    await done
  } finally {
    clearTimeout(timer)
  }

  events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
  process.stdout.write(JSON.stringify(events, null, 2) + '\n')
  process.stderr.write(`Fetched ${events.length} bug report${events.length === 1 ? '' : 's'} since ${new Date(since * 1000).toISOString()}\n`)
}

main().catch(e => {
  process.stderr.write(`fetch-bugs: ${e.message}\n`)
  process.exit(1)
})
