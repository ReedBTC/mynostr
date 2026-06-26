/**
 * gammaClassified.js — per-listing "this isn't a checkout product" mark.
 *
 * Sits next to gammaCompliance.js. The grader stays spec-faithful — it
 * still reports NO_SHIPPING_OPTION on a bare classified-style listing.
 * This module is the *intent* layer: a seller who has otherwise opted
 * into Gamma (e.g. published a 30406 for shippable products) can mark
 * specific listings as classified-only so the compliance UI stops
 * nagging them about THIS listing while keeping the warnings on the
 * rest of the shop.
 *
 * Storage: localStorage storageKey(`gamma_classified_<npub>`) — JSON array
 * of `dTag` strings. Per-pubkey scoping matches the project rule;
 * dTag (rather than event id) survives a republish so editing the
 * listing doesn't lose the mark.
 *
 * No published-event side effect — the mark is purely a client-side
 * preference. If/when we promote this to a published tag for cross-
 * device sync, callers won't change because the helpers will keep the
 * same shape.
 */
import { storageKey } from './brand.js'
import { nip19 } from 'nostr-tools'

const STORAGE_PREFIX = storageKey('gamma_classified_')

function storageKeyFor(pubkey) {
  if (!pubkey) return null
  try { return `${STORAGE_PREFIX}${nip19.npubEncode(pubkey)}` }
  catch { return null }
}

// ── Pub/sub ──────────────────────────────────────────────────────────────
// React surfaces (cards, panel, banner, drawer) need to re-read on toggle
// without waiting for a tab focus. Subscribers are global per pubkey for
// simplicity — every consumer re-reads on any change, but the work is
// trivial (parse a tiny JSON array) so a per-pubkey index isn't worth it.

const subscribers = new Set()
function notifyChange() {
  for (const fn of subscribers) {
    try { fn() } catch {}
  }
}
export function onClassifiedChange(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

// ── Reads ────────────────────────────────────────────────────────────────

export function readClassifiedSet(pubkey) {
  const key = storageKeyFor(pubkey)
  if (!key) return new Set()
  try {
    const raw = localStorage.getItem(key)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [])
  } catch {
    return new Set()
  }
}

export function isClassifiedOnly(pubkey, dTag) {
  if (!pubkey || !dTag) return false
  return readClassifiedSet(pubkey).has(dTag)
}

// ── Writes ───────────────────────────────────────────────────────────────

function writeSet(pubkey, set) {
  const key = storageKeyFor(pubkey)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify([...set])) }
  catch {}
  notifyChange()
}

export function markClassifiedOnly(pubkey, dTag) {
  if (!pubkey || !dTag) return
  const set = readClassifiedSet(pubkey)
  if (set.has(dTag)) return
  set.add(dTag)
  writeSet(pubkey, set)
}

export function unmarkClassifiedOnly(pubkey, dTag) {
  if (!pubkey || !dTag) return
  const set = readClassifiedSet(pubkey)
  if (!set.has(dTag)) return
  set.delete(dTag)
  writeSet(pubkey, set)
}
