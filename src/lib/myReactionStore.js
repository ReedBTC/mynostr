/**
 * Tracks which targets the current session user has reacted to (NIP-25
 * kind 7), so the like button can render an "already liked" state across
 * feeds, threads, articles, marketplace, and events. Source of truth is
 * the kind 7 events on relays — we just keep a session cache.
 *
 * Mirrors `myZapStore.js` — see there for design notes (lazy hydrate,
 * background refresh, optimistic mark, listener pattern, LRU cap, cross-
 * account race guard, per-target notify).
 *
 * Difference from zaps: kind 7 events are authored by the user, so we
 * filter on `authors: [pubkey]` rather than `#P`. NIP-25 says content '-'
 * is an explicit dislike — we exclude those from the liked set.
 *
 * No pending-track on likes: publishLike's success/failure window is
 * <1s in practice (sign + publish to relays), so the deferred-
 * persistence concern that drives the zap pending track is small enough
 * that we accept the rare stale-mark edge case here. unmarkLiked on
 * publish failure rolls back cleanly.
 */

import { storageKey } from './brand.js'
import { getNDK, FALLBACK_RELAYS } from './ndk.js'
import { withTimeout } from './utils.js'
import { NDKRelaySet } from '@nostr-dev-kit/ndk'

const STORAGE_PREFIX = storageKey('liked_')
const FETCH_LIMIT    = 1000
const FETCH_TIMEOUT  = 8000
const MAX_ENTRIES    = 5000

let activePubkey      = null
let likedEventIds     = new Set()
let likedAddressable  = new Set()
let loadPromise       = null

const listeners = new Set()
function notify(target) {
  for (const fn of listeners) {
    try { fn(target) } catch {}
  }
}

/**
 * Subscribe to store changes. Listener is called with `{eventId?,
 * addressable?}` for a single-target change, or undefined for a global
 * change (load complete / logout reset).
 */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function hasLikedEvent(eventId) {
  if (!eventId) return false
  return likedEventIds.has(eventId.toLowerCase())
}

export function hasLikedAddressable(coord) {
  if (!coord) return false
  return likedAddressable.has(coord)
}

function capSet(set, max) {
  while (set.size > max) {
    const oldest = set.values().next().value
    set.delete(oldest)
  }
}

/** Idempotent. Notifies subscribers and persists. */
export function markLiked({ eventId, addressable } = {}) {
  let changed = false
  if (eventId) {
    const id = eventId.toLowerCase()
    if (!likedEventIds.has(id)) {
      likedEventIds.add(id)
      capSet(likedEventIds, MAX_ENTRIES)
      changed = true
    }
  }
  if (addressable && !likedAddressable.has(addressable)) {
    likedAddressable.add(addressable)
    capSet(likedAddressable, MAX_ENTRIES)
    changed = true
  }
  if (changed && activePubkey) {
    saveToStorage(activePubkey)
    notify({ eventId, addressable })
  }
}

/** Inverse of markLiked. Used for optimistic-rollback when publish fails. */
export function unmarkLiked({ eventId, addressable } = {}) {
  let changed = false
  if (eventId) {
    const id = eventId.toLowerCase()
    if (likedEventIds.has(id)) {
      likedEventIds.delete(id)
      changed = true
    }
  }
  if (addressable && likedAddressable.has(addressable)) {
    likedAddressable.delete(addressable)
    changed = true
  }
  if (changed && activePubkey) {
    saveToStorage(activePubkey)
    notify({ eventId, addressable })
  }
}

export function resetMyLikes() {
  activePubkey = null
  likedEventIds = new Set()
  likedAddressable = new Set()
  loadPromise = null
  notify()
}

function storageKeyFor(pk) { return `${STORAGE_PREFIX}${pk}` }

function loadFromStorage(pk) {
  try {
    const raw = localStorage.getItem(storageKeyFor(pk))
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.eventIds))    parsed.eventIds.forEach(id => likedEventIds.add(id))
    if (Array.isArray(parsed?.addressable)) parsed.addressable.forEach(c => likedAddressable.add(c))
    capSet(likedEventIds, MAX_ENTRIES)
    capSet(likedAddressable, MAX_ENTRIES)
  } catch {}
}

function saveToStorage(pk) {
  try {
    localStorage.setItem(storageKeyFor(pk), JSON.stringify({
      eventIds:    [...likedEventIds],
      addressable: [...likedAddressable],
      savedAt:     Date.now(),
    }))
  } catch {}
}

export async function loadMyLikes(pubkey) {
  if (!pubkey) return
  if (activePubkey === pubkey && loadPromise) return loadPromise

  if (activePubkey !== pubkey) {
    activePubkey = pubkey
    likedEventIds = new Set()
    likedAddressable = new Set()
    loadFromStorage(pubkey)
    notify()
  }

  loadPromise = (async () => {
    const ndk = getNDK()
    try {
      const relaySet = NDKRelaySet.fromRelayUrls(FALLBACK_RELAYS, ndk)
      const events = await withTimeout(
        ndk.fetchEvents(
          { kinds: [7], authors: [pubkey], limit: FETCH_LIMIT },
          { closeOnEose: true },
          relaySet,
        ),
        FETCH_TIMEOUT,
        'fetch-likes-timeout',
      )

      // Cross-account race guard — same pattern as myZapStore.
      if (activePubkey !== pubkey) return

      for (const ev of events) {
        if (ev.content === '-') continue   // explicit dislike — skip
        // NIP-25: target tags are usually the LAST e/a (canonical). Some
        // clients include thread context with multiple e-tags; the last
        // wins. We accept either or both per receipt.
        const eTags = (ev.tags || []).filter(t => t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || ''))
        const aTags = (ev.tags || []).filter(t => t[0] === 'a' && typeof t[1] === 'string' && t[1].includes(':'))
        const lastE = eTags[eTags.length - 1]?.[1]
        const lastA = aTags[aTags.length - 1]?.[1]
        if (lastE) likedEventIds.add(lastE.toLowerCase())
        if (lastA) likedAddressable.add(lastA)
      }

      if (activePubkey !== pubkey) return

      capSet(likedEventIds, MAX_ENTRIES)
      capSet(likedAddressable, MAX_ENTRIES)
      saveToStorage(pubkey)
      notify()
    } catch (e) {
      console.warn('[mynostr-likes] loadMyLikes failed', e?.message || e)
    }
  })()
  return loadPromise
}
