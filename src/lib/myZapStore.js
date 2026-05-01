/**
 * Tracks which targets the current session user has zapped, so the zap
 * button can render an "already zapped" state across feeds, threads,
 * articles, marketplace, and events. Source of truth is the kind 9735 zap
 * receipts on relays — we just keep a session cache.
 *
 * Storage shape:
 *   - eventIds:    Set<hex>   — for kind 1 notes (and any #e-tagged target)
 *   - addressable: Set<coord> — for replaceables, format "<kind>:<pubkey>:<dtag>"
 *
 * Load strategy:
 *   1. On session change, hydrate from localStorage immediately for instant
 *      cold-load styling.
 *   2. In the background, query relays for kind 9735 receipts where the
 *      user is the sender (`#P` uppercase tag — optional in NIP-57 but
 *      most common providers emit it). Merge into the set.
 *   3. ZapModal calls markZapped() on successful payment for optimistic
 *      updates without waiting on receipt propagation.
 *
 * Persistence rule (Option B from the security review):
 *   markZapped does NOT persist when the target is currently in the
 *   pending Set — that's an optimistic NWC mark and persistence is
 *   deferred until clearZapPending fires (success path) or unmarkZapped
 *   fires (failure path). This prevents a tab-close mid-NWC-pay from
 *   leaving a stale "zapped" entry in localStorage. Manual zaps (no
 *   pending track) persist immediately.
 *
 * LRU cap: each Set is bounded at MAX_ENTRIES with oldest-insertion
 * eviction so prolific zappers don't fill localStorage over years.
 *
 * Cross-account race (security review): the loadMyZaps IIFE captures
 * `pubkey` and re-checks `activePubkey !== pubkey` after every await; if
 * the user has switched accounts mid-flight, the in-flight query aborts
 * before mutating the shared in-memory state.
 *
 * Per-target notifications: notify() takes an optional changed target so
 * subscribers (the React hooks) can skip re-rendering when the change
 * doesn't affect their watched key. notify() with no arg means "global
 * change, everyone re-render."
 *
 * Caveat: The `#P` index misses providers that don't emit the uppercase P
 * tag. For now we accept that gap — those zaps still register in the
 * session via the optimistic markZapped path; only zaps issued from other
 * clients to providers that omit `P` will be missed.
 */

import { getNDK, FALLBACK_RELAYS } from './ndk.js'
import { withTimeout } from './utils.js'
import { NDKRelaySet } from '@nostr-dev-kit/ndk'

const STORAGE_PREFIX = 'mynostr_zapped_'
const FETCH_LIMIT    = 1000
const FETCH_TIMEOUT  = 8000
const MAX_ENTRIES    = 5000   // LRU cap per Set, oldest evicted on overflow

let activePubkey      = null
let zappedEventIds    = new Set()
let zappedAddressable = new Set()
let pendingEventIds   = new Set()   // in-flight NWC zaps — drives button pulse + defers persistence
let pendingAddressable = new Set()
let loadPromise       = null

const listeners = new Set()
function notify(target) {
  for (const fn of listeners) {
    try { fn(target) } catch {}
  }
}

/**
 * Subscribe to store changes. The listener is called with an optional
 * `target` argument — `{ eventId?, addressable? }` when a single target
 * changed, or undefined when the whole store changed (load complete,
 * logout reset). Returns an unsubscribe fn.
 */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function hasZappedEvent(eventId) {
  if (!eventId) return false
  return zappedEventIds.has(eventId.toLowerCase())
}

export function hasZappedAddressable(coord) {
  if (!coord) return false
  return zappedAddressable.has(coord)
}

// Evict oldest insertion-order entries from a Set until it's within cap.
// Sets in JS maintain insertion order, so .values().next().value is the
// oldest. Ranged loops aren't safe under deletion; iterate via take-front.
function capSet(set, max) {
  while (set.size > max) {
    const oldest = set.values().next().value
    set.delete(oldest)
  }
}

/**
 * Mark a target as zapped. Idempotent. Persists to localStorage UNLESS
 * the target is currently pending (NWC payment in flight) — in that
 * case, persistence is deferred to clearZapPending so a failed payment
 * never leaves a stale localStorage entry.
 */
export function markZapped({ eventId, addressable } = {}) {
  let changed = false
  if (eventId) {
    const id = eventId.toLowerCase()
    if (!zappedEventIds.has(id)) {
      zappedEventIds.add(id)
      capSet(zappedEventIds, MAX_ENTRIES)
      changed = true
    }
  }
  if (addressable && !zappedAddressable.has(addressable)) {
    zappedAddressable.add(addressable)
    capSet(zappedAddressable, MAX_ENTRIES)
    changed = true
  }
  if (changed && activePubkey) {
    if (!isZapPending({ eventId, addressable })) {
      saveToStorage(activePubkey)
    }
    notify({ eventId, addressable })
  }
}

/**
 * Inverse of markZapped — used to revert an optimistic mark when the
 * background NWC payment fails. Persists immediately so the rollback is
 * durable.
 */
export function unmarkZapped({ eventId, addressable } = {}) {
  let changed = false
  if (eventId) {
    const id = eventId.toLowerCase()
    if (zappedEventIds.has(id)) {
      zappedEventIds.delete(id)
      changed = true
    }
  }
  if (addressable && zappedAddressable.has(addressable)) {
    zappedAddressable.delete(addressable)
    changed = true
  }
  if (changed && activePubkey) {
    saveToStorage(activePubkey)
    notify({ eventId, addressable })
  }
}

// ── Pending track ────────────────────────────────────────────────────
// In-flight NWC zaps. Drives the pulse animation on zap buttons after
// the user clicks Send Zap and the modal closes. Also gates persistence
// of optimistic markZapped calls (see markZapped).

export function isZapPending({ eventId, addressable } = {}) {
  if (eventId && pendingEventIds.has(eventId.toLowerCase())) return true
  if (addressable && pendingAddressable.has(addressable)) return true
  return false
}

export function markZapPending({ eventId, addressable } = {}) {
  let changed = false
  if (eventId) {
    const id = eventId.toLowerCase()
    if (!pendingEventIds.has(id)) { pendingEventIds.add(id); changed = true }
  }
  if (addressable && !pendingAddressable.has(addressable)) {
    pendingAddressable.add(addressable); changed = true
  }
  if (changed) notify({ eventId, addressable })
}

/**
 * Clear pending state for a target. Called when a NWC payment lands
 * (success → preimage in) or fails (after unmarkZapped reverts). Always
 * flushes the current in-memory zapped Sets to localStorage so any
 * deferred optimistic mark gets committed (or, on failure, the post-
 * unmark state is persisted).
 */
export function clearZapPending({ eventId, addressable } = {}) {
  let changed = false
  if (eventId) {
    const id = eventId.toLowerCase()
    if (pendingEventIds.has(id)) { pendingEventIds.delete(id); changed = true }
  }
  if (addressable && pendingAddressable.has(addressable)) {
    pendingAddressable.delete(addressable); changed = true
  }
  if (changed) {
    if (activePubkey) saveToStorage(activePubkey)
    notify({ eventId, addressable })
  }
}

/** Drop in-memory state. Called on logout. localStorage is left intact —
 *  re-login as the same npub re-hydrates from the cached blob. */
export function resetMyZaps() {
  activePubkey = null
  zappedEventIds = new Set()
  zappedAddressable = new Set()
  pendingEventIds = new Set()
  pendingAddressable = new Set()
  loadPromise = null
  notify()  // global change — every hook re-renders to reset
}

function storageKey(pk) { return `${STORAGE_PREFIX}${pk}` }

function loadFromStorage(pk) {
  try {
    const raw = localStorage.getItem(storageKey(pk))
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.eventIds))    parsed.eventIds.forEach(id => zappedEventIds.add(id))
    if (Array.isArray(parsed?.addressable)) parsed.addressable.forEach(c => zappedAddressable.add(c))
    capSet(zappedEventIds, MAX_ENTRIES)
    capSet(zappedAddressable, MAX_ENTRIES)
  } catch {}
}

function saveToStorage(pk) {
  try {
    localStorage.setItem(storageKey(pk), JSON.stringify({
      eventIds:    [...zappedEventIds],
      addressable: [...zappedAddressable],
      savedAt:     Date.now(),
    }))
  } catch {}
}

/**
 * Hydrate from localStorage + refresh from relays. Idempotent — repeat
 * calls for the same pubkey reuse the in-flight promise. Switching pubkey
 * resets in-memory state and starts over.
 */
export async function loadMyZaps(pubkey) {
  if (!pubkey) return
  if (activePubkey === pubkey && loadPromise) return loadPromise

  if (activePubkey !== pubkey) {
    activePubkey = pubkey
    zappedEventIds = new Set()
    zappedAddressable = new Set()
    loadFromStorage(pubkey)
    notify()
  }

  loadPromise = (async () => {
    const ndk = getNDK()
    try {
      // `#P` (uppercase) = sender pubkey per NIP-57. Most providers emit
      // it; the ones that don't will be missed by this bulk query but
      // still tracked optimistically when the user zaps from this app.
      const relaySet = NDKRelaySet.fromRelayUrls(FALLBACK_RELAYS, ndk)
      const events = await withTimeout(
        ndk.fetchEvents(
          { kinds: [9735], '#P': [pubkey], limit: FETCH_LIMIT },
          { closeOnEose: true },
          relaySet,
        ),
        FETCH_TIMEOUT,
        'fetch-zaps-timeout',
      )

      // Cross-account race guard: if the user logged out and back in as a
      // different account while the fetch was in flight, drop the result
      // — writing it now would pollute the new account's in-memory Set.
      if (activePubkey !== pubkey) return

      for (const ev of events) {
        // Cross-check sender pubkey from the embedded zap request — the
        // `#P` tag isn't authenticated, but the description (zap request)
        // is signed by the actual sender. Reject any receipt whose
        // description doesn't match the session pubkey.
        const desc = ev.tags?.find(t => t[0] === 'description')?.[1]
        if (desc) {
          let zapReq
          try { zapReq = JSON.parse(desc) } catch { continue }
          if (zapReq?.pubkey && zapReq.pubkey !== pubkey) continue
        }
        const eTag = ev.tags?.find(t => t[0] === 'e')?.[1]
        const aTag = ev.tags?.find(t => t[0] === 'a')?.[1]
        if (eTag && /^[0-9a-f]{64}$/i.test(eTag)) zappedEventIds.add(eTag.toLowerCase())
        if (aTag) zappedAddressable.add(aTag)
      }

      // Re-check after the loop — events may have arrived in a quick
      // burst, but even so a session change between await and now means
      // we shouldn't persist or notify.
      if (activePubkey !== pubkey) return

      capSet(zappedEventIds, MAX_ENTRIES)
      capSet(zappedAddressable, MAX_ENTRIES)
      saveToStorage(pubkey)
      notify()
    } catch (e) {
      console.warn('[mynostr-zaps] loadMyZaps failed', e?.message || e)
      // localStorage cache stays in place — user keeps the styling they
      // had on previous load until the next successful refresh.
    }
  })()
  return loadPromise
}
