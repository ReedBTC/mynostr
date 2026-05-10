/**
 * useNip15Scan — fetch a seller's legacy NIP-15 catalog and surface
 * what's still unhandled.
 *
 * Detection lifecycle:
 *   1. On first call for a pubkey with no `scanFlag === 'clean'` in
 *      storage, fire a single fetch for kind 30017 + 30018 events
 *      authored by the pubkey.
 *   2. Filter out any product whose event id is already in
 *      `migratedIds` or `ignoredIds` — those have been handled.
 *   3. If the filtered candidate list is empty, mark the scan clean
 *      so subsequent visits skip the fetch entirely.
 *   4. Otherwise the banner takes over — clicking through to the
 *      modal lets the seller migrate / delete / ignore each one.
 *
 * Re-scan: the `rescan()` returned function clears the clean flag
 * and re-fires the fetch. Triggered from the SellingTab tools menu so
 * sellers who publish new NIP-15 from another client later can clean
 * those up too.
 *
 * Replaceable-event dedup: 30017 and 30018 are both replaceable per
 * (kind, pubkey, dTag). We dedup by dTag, keeping the newest event
 * by created_at.
 */
import { useCallback, useEffect, useState } from 'react'
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'
import {
  KIND_NIP15_STALL,
  KIND_NIP15_PRODUCT,
  parseStall,
  parseProduct,
} from './nip15.js'
import {
  readState,
  markScanClean,
  clearScanFlag,
  markMigrated,
} from './nip15Storage.js'

function dedupReplaceable(events) {
  const byDTag = new Map()
  for (const ev of events || []) {
    const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
    if (!dTag) continue
    const existing = byDTag.get(dTag)
    if (!existing || (ev.created_at || 0) > (existing.created_at || 0)) {
      byDTag.set(dTag, ev)
    }
  }
  return [...byDTag.values()]
}

async function fetchLegacyEvents(pubkey) {
  const ndk = getNDK()
  try {
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds:   [KIND_NIP15_STALL, KIND_NIP15_PRODUCT],
        authors: [pubkey],
      }),
      8000,
      'fetch-timeout',
    )
    const stallEvents   = []
    const productEvents = []
    for (const ev of events) {
      if (ev.kind === KIND_NIP15_STALL)   stallEvents.push(ev)
      if (ev.kind === KIND_NIP15_PRODUCT) productEvents.push(ev)
    }
    return {
      stalls:   dedupReplaceable(stallEvents).map(parseStall).filter(Boolean),
      products: dedupReplaceable(productEvents).map(parseProduct).filter(Boolean),
    }
  } catch {
    return { stalls: [], products: [] }
  }
}

/**
 * Hook surface:
 *   { candidates, stalls, loading, scanFlag, rescan }
 *
 *   - candidates: array of parsed kind-30018 products that haven't been
 *     migrated or ignored yet. The banner counts these; the modal
 *     iterates over them.
 *   - stalls: array of parsed kind-30017 stalls. Used by the modal to
 *     show "Stall: Foo Crafts" grouping headers and to derive shipping
 *     options from stall zones.
 *   - loading: true while the fetch is in flight.
 *   - scanFlag: 'clean' means the scan was completed and nothing was
 *     left to handle. The hook returns empty arrays in this state.
 *   - rescan(): clears the clean flag and re-fires the fetch. Caller
 *     uses this for a "Re-scan for legacy listings" entry point.
 */
export function useNip15Scan(pubkey) {
  const [candidates, setCandidates] = useState([])
  const [stalls,     setStalls]     = useState([])
  const [loading,    setLoading]    = useState(false)
  const [scanFlag,   setScanFlag]   = useState(undefined)
  const [token,      setToken]      = useState(0)

  const rescan = useCallback(() => {
    if (!pubkey) return
    clearScanFlag(pubkey)
    setToken(t => t + 1)
  }, [pubkey])

  /**
   * Mark every current candidate as handled and stamp the scan clean.
   * Used by the modal's "I've already migrated these" path — sellers
   * who completed migration in another client (e.g. Plebeian's
   * migration tool) tell us they're done, and the banner stays gone.
   * Idempotent on storage; resets local state in-place so the banner
   * disappears immediately without a re-fetch.
   */
  const markAllHandled = useCallback(() => {
    if (!pubkey) return
    for (const c of candidates) markMigrated(pubkey, c.eventId)
    markScanClean(pubkey)
    setCandidates([])
    setScanFlag('clean')
  }, [pubkey, candidates])

  useEffect(() => {
    if (!pubkey) {
      setCandidates([])
      setStalls([])
      setLoading(false)
      setScanFlag(undefined)
      return
    }
    const stored = readState(pubkey)
    setScanFlag(stored.scanFlag)
    if (stored.scanFlag === 'clean') {
      setCandidates([])
      setStalls([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    ;(async () => {
      const { stalls, products } = await fetchLegacyEvents(pubkey)
      if (cancelled) return
      const handled = new Set([...stored.migratedIds, ...stored.ignoredIds])
      const remaining = products.filter(p => !handled.has(p.eventId))
      setStalls(stalls)
      setCandidates(remaining)
      setLoading(false)
      if (remaining.length === 0) {
        markScanClean(pubkey)
        setScanFlag('clean')
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, token])

  return { candidates, stalls, loading, scanFlag, rescan, markAllHandled }
}
