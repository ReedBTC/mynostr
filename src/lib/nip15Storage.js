/**
 * Per-pubkey state for the NIP-15 → Gamma legacy migration tool.
 *
 * Storage shape:
 *   localStorage["mynostr_nip15_state_<npub>"] = JSON.stringify({
 *     scanFlag:    'clean' | 'pending' | undefined,  // 'clean' suppresses the detection fetch
 *     migratedIds: ['<30018-event-id>', ...],         // legacy products we've successfully replaced or deleted
 *     ignoredIds:  ['<30018-event-id>', ...],         // legacy products the seller chose "Ignore forever" on
 *     savedAt:     <ms epoch>,
 *   })
 *
 * Why per-pubkey: same rule as the rest of the app — different accounts
 * on the same browser don't share migration state. Switching identity
 * doesn't leak one seller's migration progress to another.
 *
 * Why event-ids and not d-tags for migrated/ignored: an event id is
 * stable across the seller's lifetime; a d-tag could theoretically
 * collide between unrelated stalls (though the spec says the id is
 * merchant-generated). Using the event id of the legacy product event
 * is the unambiguous reference.
 *
 * Size discipline: every legacy product the seller ever had adds an
 * id to the blob. Even at 50 products that's well under 4KB. Cap at
 * 64KB defensively — past that something's wrong, drop the blob.
 */
import { nip19 } from 'nostr-tools'

const STORAGE_PREFIX = 'mynostr_nip15_state_'
const MAX_BLOB_SIZE  = 64 * 1024

function storageKey(pubkey) {
  if (!pubkey) return null
  try { return `${STORAGE_PREFIX}${nip19.npubEncode(pubkey)}` }
  catch { return null }
}

function emptyState() {
  return { scanFlag: undefined, migratedIds: [], ignoredIds: [], savedAt: 0 }
}

/**
 * Read the current migration state for a pubkey. Returns a safe
 * default when nothing's stored, the blob is malformed, or the blob
 * is suspiciously oversized.
 */
export function readState(pubkey) {
  const key = storageKey(pubkey)
  if (!key) return emptyState()
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return emptyState()
    if (raw.length > MAX_BLOB_SIZE) {
      try { localStorage.removeItem(key) } catch {}
      return emptyState()
    }
    const parsed = JSON.parse(raw)
    return {
      scanFlag:    parsed?.scanFlag === 'clean' || parsed?.scanFlag === 'pending'
                     ? parsed.scanFlag : undefined,
      migratedIds: Array.isArray(parsed?.migratedIds)
                     ? parsed.migratedIds.filter(s => typeof s === 'string') : [],
      ignoredIds:  Array.isArray(parsed?.ignoredIds)
                     ? parsed.ignoredIds.filter(s => typeof s === 'string') : [],
      savedAt:     Number.isFinite(parsed?.savedAt) ? parsed.savedAt : 0,
    }
  } catch { return emptyState() }
}

function writeState(pubkey, next) {
  const key = storageKey(pubkey)
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify({ ...next, savedAt: Date.now() }))
  } catch {}
}

/**
 * Mark the scan as clean — banner suppressed, detection fetch skipped
 * on subsequent visits. Called only when a complete scan finds no
 * candidates left to handle.
 */
export function markScanClean(pubkey) {
  const cur = readState(pubkey)
  writeState(pubkey, { ...cur, scanFlag: 'clean' })
}

/**
 * Mark the scan as pending — explicit signal that legacy events were
 * detected but the seller hasn't finished handling them yet. Currently
 * informational; the banner doesn't gate on this (it gates on the
 * filtered candidate list being non-empty), but it's useful for
 * future telemetry / debugging.
 */
export function markScanPending(pubkey) {
  const cur = readState(pubkey)
  writeState(pubkey, { ...cur, scanFlag: 'pending' })
}

/**
 * Clear the scan flag — re-arms the detection fetch on next visit.
 * Triggered by the "Re-scan for legacy listings" tools-menu item.
 */
export function clearScanFlag(pubkey) {
  const cur = readState(pubkey)
  writeState(pubkey, { ...cur, scanFlag: undefined })
}

/**
 * Append a legacy product id to the migrated list. Idempotent — safe
 * to call again on the same id without growing the blob. Per-item
 * append (not per-batch) so a mid-batch interruption preserves the
 * progress already made.
 */
export function markMigrated(pubkey, productEventId) {
  if (!productEventId) return
  const cur = readState(pubkey)
  if (cur.migratedIds.includes(productEventId)) return
  writeState(pubkey, { ...cur, migratedIds: [...cur.migratedIds, productEventId] })
}

/**
 * Append a legacy product id to the ignored list. Same idempotence
 * rules as markMigrated. Once ignored, the detection scan filters
 * the id out — banner won't re-prompt for it on subsequent visits.
 */
export function markIgnored(pubkey, productEventId) {
  if (!productEventId) return
  const cur = readState(pubkey)
  if (cur.ignoredIds.includes(productEventId)) return
  writeState(pubkey, { ...cur, ignoredIds: [...cur.ignoredIds, productEventId] })
}
