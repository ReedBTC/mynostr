// WebSocket race across a fixed relay set. CF Workers' outgoing WebSocket
// goes through `fetch()` with `Upgrade: websocket` rather than the browser
// `new WebSocket()` constructor — that's the supported pattern.
//
// First valid event wins; surviving sockets are closed. If every relay
// times out, the function returns null and the caller falls back to
// static meta tags (i.e., site-availability is preserved on relay outage).

const RELAYS = [
  'https://relay.primal.net',
  'https://relay.damus.io',
  'https://nos.lol',
  'https://purplepag.es',
]

const DEFAULT_TIMEOUT_MS = 2500

async function fetchEventFrom(relayUrl, filter, timeoutMs, settledRef) {
  let ws
  try {
    const resp = await fetch(relayUrl, {
      headers: { Upgrade: 'websocket' },
    })
    if (resp.status !== 101) return null
    ws = resp.webSocket
    if (!ws) return null
    ws.accept()
  } catch {
    return null
  }

  return new Promise(resolve => {
    let done = false
    const subId = 'og' + Math.random().toString(36).slice(2, 10)

    const finish = ev => {
      if (done) return
      done = true
      try { ws.close(1000, 'done') } catch {}
      resolve(ev)
    }

    ws.addEventListener('message', e => {
      // If another relay already won the race, abort this one early.
      if (settledRef.settled) return finish(null)
      try {
        const raw = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
        const msg = JSON.parse(raw)
        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          finish(msg[2])
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          // Relay finished without finding the event — close cleanly.
          finish(null)
        }
      } catch {}
    })
    ws.addEventListener('close', () => finish(null))
    ws.addEventListener('error', () => finish(null))

    try {
      ws.send(JSON.stringify(['REQ', subId, filter]))
    } catch {
      finish(null)
    }

    setTimeout(() => finish(null), timeoutMs)
  })
}

// Race all relays in parallel. First non-null event wins; if all return
// null we resolve null after the slowest finishes (or the timeout).
export async function raceRelays(filter, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const settledRef = { settled: false }

  return new Promise(resolve => {
    let pending = RELAYS.length
    let resolved = false

    const done = ev => {
      if (resolved) return
      resolved = true
      settledRef.settled = true
      resolve(ev)
    }

    for (const url of RELAYS) {
      fetchEventFrom(url, filter, timeoutMs, settledRef)
        .then(ev => {
          if (ev) done(ev)
          else if (--pending === 0) done(null)
        })
        .catch(() => {
          if (--pending === 0) done(null)
        })
    }

    // Hard cap — covers the case where a fetch hangs before we get a
    // socket back. The per-socket timer above only fires after accept().
    setTimeout(() => done(null), timeoutMs + 500)
  })
}
