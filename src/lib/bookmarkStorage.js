/**
 * Shared bookmark storage/relay helpers used by useNoteBookmarks and
 * useReadingLists. Both hooks manage NIP-51 bookmark events (kinds
 * 10003/30001/30003) and need the same tombstone log, hidden-chip
 * store, outbox fetch, and tombstone shape detection — duplicating that
 * logic caused drift (the cache-side tombstone check lived in one hook
 * but not the other).
 *
 * Factories are parameterized by localStorage key prefix so each hook
 * keeps its own namespace without sharing keys.
 */
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'

// Bound the tombstone map so a churn-heavy user (or a script pasted into
// devtools) can't push it past the ~5MB localStorage quota. 500 is far
// more than any real user needs since tombstones only matter while
// fallback relays might still echo the pre-delete event.
const TOMBSTONE_MAX_ENTRIES = 500

export function makeTombstoneStore(prefix) {
  const keyFor = (pubkey) => pubkey ? `${prefix}${pubkey}` : null

  function load(pubkey) {
    const key = keyFor(pubkey)
    if (!key) return {}
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null')
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const out = {}
      for (const [k, v] of Object.entries(raw)) {
        if (typeof k === 'string' && Number.isFinite(v)) out[k] = v
      }
      return out
    } catch { return {} }
  }

  function save(pubkey, id, createdAt) {
    const key = keyFor(pubkey)
    if (!key || !id) return
    try {
      const current = load(pubkey)
      const stamp = Number.isFinite(createdAt) ? createdAt : Math.floor(Date.now() / 1000)
      current[id] = Math.max(current[id] || 0, stamp)
      // Evict oldest entries (lowest created_at) if we've exceeded the cap.
      const keys = Object.keys(current)
      if (keys.length > TOMBSTONE_MAX_ENTRIES) {
        const sorted = keys.sort((a, b) => current[a] - current[b])
        for (const k of sorted.slice(0, keys.length - TOMBSTONE_MAX_ENTRIES)) {
          delete current[k]
        }
      }
      localStorage.setItem(key, JSON.stringify(current))
    } catch {}
  }

  return { load, save }
}

// Per-pubkey hidden chip store, split by privacy view. Hiding is a display
// preference — the underlying 30001/30003 events stay on relays and other
// clients/modules still see them. Storage shape: `{ public: string[],
// private: string[] }`. A bare array (pre-split schema) migrates into the
// public bucket so previously-hidden chips don't pop back onto view.
export function makeHiddenStore(prefix) {
  const keyFor = (pubkey) => pubkey ? `${prefix}${pubkey}` : null

  function load(pubkey) {
    const key = keyFor(pubkey)
    const empty = { public: [], private: [] }
    if (!key) return empty
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null')
      if (Array.isArray(raw)) {
        return { public: raw.filter(id => typeof id === 'string'), private: [] }
      }
      if (raw && typeof raw === 'object') {
        return {
          public:  Array.isArray(raw.public)  ? raw.public .filter(id => typeof id === 'string') : [],
          private: Array.isArray(raw.private) ? raw.private.filter(id => typeof id === 'string') : [],
        }
      }
      return empty
    } catch { return empty }
  }

  function save(pubkey, hiddenByView) {
    const key = keyFor(pubkey)
    if (!key) return
    try {
      localStorage.setItem(key, JSON.stringify({
        public:  [...(hiddenByView.public  || [])],
        private: [...(hiddenByView.private || [])],
      }))
    } catch {}
  }

  return { load, save }
}

// Fetch the freshest kind 10003 event from relays. Used immediately
// before publishing the primary bookmark list so any data another
// module wrote since our load isn't silently clobbered. On fetch failure
// (timeout, offline) callers fall back to their cached shape — no worse
// than pre-merge behavior.
export async function fetchLatestPrimary(pubkey) {
  if (!pubkey) return null
  try {
    const ndk = getNDK()
    const events = await withTimeout(
      ndk.fetchEvents({ kinds: [10003], authors: [pubkey] }),
      5000,
    )
    let fresh = null
    for (const ev of events) {
      if (!fresh || (ev.created_at || 0) > (fresh.created_at || 0)) fresh = ev
    }
    return fresh
  } catch {
    return null
  }
}

// A replaceable event with only a d-tag and empty content is a tombstone —
// the delete path writes exactly that shape. Surface neither as an item
// nor as a "present" category.
//
// Assumption: no legitimate list event from any client will have exactly
// one tag (just `d`) AND empty content. A third-party client that wrote
// a completely empty 30001/30003 with that shape would be hidden by this
// filter. Accepted trade-off — empty + no title is effectively a deleted
// list anyway, and no other mynostr write path produces it.
export function isTombstone(event) {
  if (event.kind !== 30001 && event.kind !== 30003) return false
  const tags = event.tags || []
  const onlyDTag = tags.length === 1 && tags[0]?.[0] === 'd'
  return onlyDTag && (!event.content || event.content === '')
}

// Seed a tombstone map with any tombstones we just fetched from relays.
// A delete set on another device arrives here as a regular replaceable
// event; without seeding, the isTombstone filter drops it and any stale
// cached copy then resurrects the deleted entry on the next load.
//
// Mutates the passed-in `tombstones` object AND persists via `saveFn` so
// subsequent loads (even after the origin event stops being served) keep
// the delete sticky.
export function seedTombstonesFromEvents(events, tombstones, pubkey, saveFn) {
  for (const ev of events) {
    if (!isTombstone(ev)) continue
    const dTag = ev.tags?.find(t => t[0] === 'd')?.[1]
    if (!dTag) continue
    const at = ev.created_at || 0
    if (at > (tombstones[dTag] || 0)) {
      tombstones[dTag] = at
      saveFn(pubkey, dTag, at)
    }
  }
}
