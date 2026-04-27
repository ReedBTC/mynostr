/**
 * Delete a kind 30402 listing via NIP-09 deletion request, with a
 * pre-delete relay scan so the kind-5 reaches the relays that
 * actually serve the listing — not just the user's current outbox.
 *
 * Why the scan: a user's kind 10002 write set drifts over time. A
 * listing published months ago may live on relays that aren't in the
 * user's *current* outbox at delete time, so a plain
 * publishToOwnOutbox(kind5) misses them and the listing keeps
 * reappearing on hard-refresh in clients that query a wider relay
 * set. The scan finds the listing's actual current footprint and
 * targets the kind-5 surgically.
 *
 * Event shape matches Plebeian Market's deleteProduct:
 *
 *   kind:    5
 *   content: "Product deleted"
 *   tags:    [['a', '30402:<pubkey>:<dTag>']]
 *
 * NIP-09 is advisory — relays may keep serving the event, and
 * archive/indexer services may retain it indefinitely. The scan-
 * then-target approach maximizes reach within Nostr's limits but
 * doesn't promise universal removal.
 */

import { SimplePool } from 'nostr-tools'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout } from './ndk.js'
import { withTimeout } from './utils.js'
import { buildProductCoord, KIND_PRODUCT } from './gamma.js'
import { DEFAULT_MARKETPLACE_RELAYS } from './marketplaceRelays.js'

// Fetch the user's *current* kind-10002 write relays via a direct
// fetchEvent call rather than NDK's cached relayList helper. The cache
// can be stale (especially after the user has recently shuffled their
// relay list, which is exactly when accurate delete targeting matters
// most). Mirrors the resolution path in `ensureUserWriteRelays`,
// minus the side-effect warning bus — we just want the URLs.
async function fetchCurrentWriteRelays(ndk, pubkey) {
  if (!ndk || !pubkey) return []
  try {
    const ev = await withTimeout(
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      5000,
      'fetch-10002-timeout',
    )
    if (!ev) return []
    return (ev.tags || [])
      .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write'))
      .map(t => t[1])
      .filter(u => typeof u === 'string' && /^wss:\/\//i.test(u))
  } catch {
    return []
  }
}

// Extras beyond the user's outbox + marketplace defaults — popular
// general-purpose relays that often end up carrying listings via
// other clients' wider write sets.
const SCAN_EXTRA_RELAYS = [
  'wss://relay.primal.net',
  'wss://purplepag.es',
]

// Per-relay scan budget. The scan is parallel across all candidates,
// so total wallclock for the scan phase is capped at this value (the
// slowest responder gates the phase). Sized in proportion to the
// publish-phase budget below: short enough that the user isn't waiting
// forever before the publish kicks off, long enough to capture the
// "slow but alive" tail of relays under load. Most well-run relays
// respond in <2s; pushing past 8s rarely catches a true positive.
const SCAN_PER_RELAY_TIMEOUT_MS = 8000

function dedupe(urls) {
  const seen = new Set()
  const out = []
  for (const u of urls) {
    const v = String(u || '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * Sign and publish a NIP-09 deletion for a kind-30402 listing,
 * targeting relays the listing actually appears on.
 *
 * @param {object}   params
 * @param {string}   params.pubkey          author hex
 * @param {string}   params.dTag            listing's d-tag
 * @param {function} [params.onProgress]    optional ({phase, ...}) callback
 *                                          phase: 'scanning' | 'deleting' | 'done'
 * @returns {Promise<{ sentTo: string[], scanned: number, foundOn: number }>}
 */
export async function deleteProduct({ pubkey, dTag, onProgress }) {
  if (!pubkey || !dTag) throw new Error('deleteProduct: pubkey and dTag required')
  const ndk = getNDK()
  const coord = buildProductCoord(pubkey, dTag)

  // 1. Build the scan candidate set. Fetch the *current* 10002 write
  // relays directly (not via NDK's cached relayList) so a recent relay
  // shuffle doesn't leave us targeting an old set.
  const ownOutbox = await fetchCurrentWriteRelays(ndk, pubkey)
  const candidates = dedupe([
    ...ownOutbox,
    ...DEFAULT_MARKETPLACE_RELAYS,
    ...SCAN_EXTRA_RELAYS,
  ])

  onProgress?.({ phase: 'scanning', candidates: candidates.length })

  // 2. Parallel scan — which relays currently serve this listing?
  const filter = { kinds: [KIND_PRODUCT], authors: [pubkey], '#d': [dTag] }
  const found = new Set()
  const scanPool = new SimplePool()
  try {
    await Promise.all(candidates.map(async (url) => {
      try {
        const ev = await withTimeout(
          scanPool.get([url], filter),
          SCAN_PER_RELAY_TIMEOUT_MS,
          'scan-timeout',
        )
        if (ev) found.add(url)
      } catch {
        // Unreachable / auth-gated / timeout — skip silently. We can't
        // delete from a relay we can't read from anyway.
      }
    }))
  } finally {
    try { scanPool.close(candidates) } catch {}
  }

  // 3. Compute publish targets: scan-positives ∪ current outbox. We
  // always include current outbox so future reads from the user's
  // relays see the tombstone, even if the listing isn't currently
  // there. If both sets are empty (no outbox, scan returned nothing),
  // fall back to the full candidate set as a best-effort broadcast.
  let targets = dedupe([...found, ...ownOutbox])
  if (targets.length === 0) targets = [...candidates]

  onProgress?.({
    phase: 'deleting',
    targets: targets.length,
    foundOn: found.size,
  })

  // 4. Sign the kind-5 once with NDK (so NIP-07 / bunker / nsec all work
  // uniformly), then publish per-relay via SimplePool so we get a
  // deterministic per-relay ack count. NDK's event.publish enforces a
  // `requiredRelayCount` that throws if too few ack, which conflates
  // "9 of 12 acked" with "publish failed" — partial success is the
  // expected outcome on Nostr and we want to surface the real number.
  const event = new NDKEvent(ndk)
  event.kind = 5
  event.content = 'Product deleted'
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = [['a', coord]]
  await signWithTimeout(event)
  const signedEvent = await event.toNostrEvent()

  const PUBLISH_TIMEOUT_MS = 15000
  const pubPool = new SimplePool()
  const ownOutboxSet = new Set(ownOutbox)
  let acked = []
  let failures = []
  try {
    const pubs = pubPool.publish(targets, signedEvent)
    const results = await Promise.allSettled(
      pubs.map(p => withTimeout(p, PUBLISH_TIMEOUT_MS, 'pub-timeout')),
    )
    for (let i = 0; i < targets.length; i++) {
      const url = targets[i]
      const r = results[i]
      if (r.status === 'fulfilled') {
        acked.push(url)
      } else {
        // Categorize the failure for the UI: timeout vs explicit
        // rejection vs connection error. Helps the user decide whether
        // to drop the relay from their write list.
        const msg = r.reason?.message || String(r.reason || '')
        let reason = 'no response'
        if (/pub-timeout|timed?\s*out|timeout/i.test(msg)) reason = 'no response within 15s'
        else if (/blocked|reject|forbid|noauth|auth|not allowed|rate.?limit/i.test(msg)) reason = 'rejected by relay'
        else if (msg) reason = msg.slice(0, 80)
        failures.push({
          url,
          reason,
          fromOutbox: ownOutboxSet.has(url),
        })
      }
    }
  } finally {
    try { pubPool.close(targets) } catch {}
  }

  onProgress?.({
    phase: 'done',
    targeted: targets.length,
    acked: acked.length,
    failures,
    foundOn: found.size,
    scanned: candidates.length,
  })

  return {
    targets,                          // every relay we sent the kind-5 to
    acked,                            // subset that ack'd within the timeout
    failures,                         // [{url, reason, fromOutbox}] for the rest
    foundOn: found.size,
    scanned: candidates.length,
  }
}

// Re-exported convenience so callers don't need a second import.
export { KIND_PRODUCT }
