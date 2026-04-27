/**
 * useCollections — fetch + mutate all of a user's kind 30405 (Gamma)
 * collections.
 *
 * A collection is identified by its `d` tag. Each user can have any
 * number of collections; the watchlist is just a specific one with
 * `d:watchlist` (created by `useWatchlist`, which is a thin wrapper
 * around this hook).
 *
 * Reading: fetches whichever pubkey you ask for. Visitors see another
 * user's public collections; on your own page, you see yours.
 *
 * Writing: only meaningful when `pubkey === sessionUser.pubkey`. The
 * mutators sign with the NDK session signer and publish via outbox.
 * Calling them with a non-session pubkey produces events with the
 * wrong author and silently fails at relay-acceptance — guard at the
 * call site.
 *
 * Replaceable kind semantics: each collection is keyed by
 * (kind 30405, pubkey, dTag), so updates re-emit at the same dTag.
 * Deletion is via NIP-09 kind 5 with an `a` tag for the coordinate.
 */
import { useCallback, useEffect, useState } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'
import { withTimeout, isSafeUrl } from './utils.js'
import {
  KIND_COLLECTION,
  WATCHLIST_D_TAG,
  encodeCollection,
  decodeCollection,
  buildCollectionCoord,
} from './gamma.js'

/**
 * Generate a fresh dTag for a new collection. Slug-style, randomized
 * suffix to avoid collisions if the user has multiple collections
 * with similar titles.
 */
function generateCollectionDTag(title) {
  const base = String(title || 'collection').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'collection'
  const suffix = Math.random().toString(36).slice(2, 7)
  return `${base}-${suffix}`
}

async function fetchAllCollections(pubkey) {
  if (!pubkey) return []
  const ndk = getNDK()
  try {
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds:   [KIND_COLLECTION],
        authors: [pubkey],
      }),
      8000,
      'fetch-timeout',
    )
    // Replaceable kind — dedupe by dTag, keep the newest by created_at.
    const byDTag = new Map()
    for (const ev of events) {
      const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
      if (!dTag) continue
      const existing = byDTag.get(dTag)
      if (!existing || (ev.created_at || 0) > (existing.created_at || 0)) {
        byDTag.set(dTag, ev)
      }
    }
    const out = []
    for (const ev of byDTag.values()) {
      const decoded = decodeCollection(ev)
      if (decoded) out.push({ event: ev, decoded })
    }
    // Watchlist pinned to the top, then everything else by created_at desc
    out.sort((a, b) => {
      if (a.decoded.dTag === WATCHLIST_D_TAG) return -1
      if (b.decoded.dTag === WATCHLIST_D_TAG) return 1
      return (b.event.created_at || 0) - (a.event.created_at || 0)
    })
    return out
  } catch {
    return []
  }
}

export function useCollections(pubkey) {
  const [collections, setCollections] = useState([])  // [{ event, decoded }]
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState(null)
  const [token,       setToken]       = useState(0)
  const [pending,     setPending]     = useState(false)

  const reload = useCallback(() => setToken(t => t + 1), [])

  useEffect(() => {
    if (!pubkey) {
      setCollections([])
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const all = await fetchAllCollections(pubkey)
        if (cancelled) return
        setCollections(all)
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e?.message || 'Collections load failed.')
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, token])

  // ── Lookups ─────────────────────────────────────────────────────────

  /** Find a collection by its dTag. Returns null if not present. */
  const find = useCallback((dTag) => {
    if (!dTag) return null
    return collections.find(c => c.decoded.dTag === dTag) || null
  }, [collections])

  /** Returns the list of collection dTags that contain a given product. */
  const containingCollections = useCallback((productATag) => {
    if (!productATag) return []
    return collections
      .filter(c => (c.decoded.productRefs || []).includes(productATag))
      .map(c => c.decoded.dTag)
  }, [collections])

  // ── Internal: build + sign + publish a 30405 from a decoded shape ──

  const publishCollectionEvent = useCallback(async (form) => {
    const ndk = getNDK()
    if (!ndk?.signer) throw new Error('No signer available')
    const { kind, content, tags } = encodeCollection(form)
    const ev = new NDKEvent(ndk, {
      kind,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    })
    await signWithTimeout(ev)
    await publishToOwnOutbox(ev)
    return ev
  }, [])

  // Update a collection's local state by dTag, keeping the rest of
  // the array intact. If the collection didn't exist locally yet
  // (first-time create), prepend it to the list.
  const upsertLocal = useCallback((decoded, eventOverride) => {
    setCollections(prev => {
      const others = prev.filter(c => c.decoded.dTag !== decoded.dTag)
      const entry = {
        event: eventOverride || (prev.find(c => c.decoded.dTag === decoded.dTag)?.event) || null,
        decoded,
      }
      // Re-sort: watchlist pinned, then by created_at desc.
      const next = [...others, entry]
      next.sort((a, b) => {
        if (a.decoded.dTag === WATCHLIST_D_TAG) return -1
        if (b.decoded.dTag === WATCHLIST_D_TAG) return 1
        return ((b.event?.created_at) || 0) - ((a.event?.created_at) || 0)
      })
      return next
    })
  }, [])

  // ── Mutators ────────────────────────────────────────────────────────

  /**
   * Create a new collection. Returns { ok, dTag } on success or
   * { ok: false, error } on failure.
   */
  const createCollection = useCallback(async ({ title, summary = '', image = '', productRefs = [] }) => {
    if (pending) return { ok: false, reason: 'busy' }
    if (!title?.trim()) return { ok: false, error: 'Title required' }
    const cleanImage = image?.trim() || ''
    if (cleanImage && !isSafeUrl(cleanImage)) {
      return { ok: false, error: 'Cover image must be a valid https:// URL.' }
    }
    setPending(true)
    setError(null)
    try {
      const dTag = generateCollectionDTag(title)
      const decoded = {
        dTag,
        title: title.trim(),
        summary: summary?.trim() || '',
        image: cleanImage,
        productRefs,
        shippingOptionRefs: [],
        tTags: [],
        _extraTags: [],
      }
      const ev = await publishCollectionEvent(decoded)
      upsertLocal(decoded, ev)
      return { ok: true, dTag }
    } catch (e) {
      setError(e?.message || 'Create failed.')
      return { ok: false, error: e?.message || 'Create failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, publishCollectionEvent, upsertLocal])

  /**
   * Update a collection's metadata. Preserves productRefs.
   * Auto-creates the watchlist if it doesn't exist yet (the watchlist
   * is the one collection users may edit before they've ever added a
   * product to it).
   */
  const updateMetadata = useCallback(async (dTag, patch) => {
    if (!dTag || pending) return { ok: false, reason: 'busy-or-empty' }
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'image')) {
      const cleanImage = (patch.image || '').trim()
      if (cleanImage && !isSafeUrl(cleanImage)) {
        return { ok: false, error: 'Cover image must be a valid https:// URL.' }
      }
    }
    setPending(true)
    setError(null)
    try {
      const existing = collections.find(c => c.decoded.dTag === dTag)?.decoded
      const baseline = existing || {
        dTag,
        title: dTag === WATCHLIST_D_TAG ? 'Watchlist' : 'Collection',
        summary: '',
        image: '',
        productRefs: [],
        shippingOptionRefs: [],
        tTags: [],
        _extraTags: [],
      }
      const next = {
        ...baseline,
        ...patch,
        dTag,
        title: patch.title?.trim() || baseline.title || 'Collection',
      }
      const ev = await publishCollectionEvent(next)
      upsertLocal(next, ev)
      return { ok: true }
    } catch (e) {
      setError(e?.message || 'Update failed.')
      return { ok: false, error: e?.message || 'Update failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, collections, publishCollectionEvent, upsertLocal])

  /** Add a product ref to a collection. Auto-creates if absent. */
  const addToCollection = useCallback(async (dTag, productATag) => {
    if (!dTag || !productATag || pending) return { ok: false, reason: 'busy-or-empty' }
    const existing = collections.find(c => c.decoded.dTag === dTag)?.decoded
    if (existing && (existing.productRefs || []).includes(productATag)) {
      return { ok: true, alreadyPresent: true }
    }
    setPending(true)
    setError(null)
    // Optimistic state.
    const baseline = existing || {
      dTag,
      title: dTag === WATCHLIST_D_TAG ? 'Watchlist' : 'Collection',
      summary: '',
      image: '',
      productRefs: [],
      shippingOptionRefs: [],
      tTags: [],
      _extraTags: [],
    }
    const next = {
      ...baseline,
      productRefs: [...(baseline.productRefs || []), productATag],
    }
    upsertLocal(next)
    try {
      const ev = await publishCollectionEvent(next)
      upsertLocal(next, ev)
      return { ok: true }
    } catch (e) {
      // Rollback optimistic update.
      if (existing) upsertLocal(existing)
      else setCollections(prev => prev.filter(c => c.decoded.dTag !== dTag))
      setError(e?.message || 'Add failed.')
      return { ok: false, error: e?.message || 'Add failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, collections, publishCollectionEvent, upsertLocal])

  /** Remove a product ref from a collection. */
  const removeFromCollection = useCallback(async (dTag, productATag) => {
    if (!dTag || !productATag || pending) return { ok: false, reason: 'busy-or-empty' }
    const existing = collections.find(c => c.decoded.dTag === dTag)?.decoded
    if (!existing || !(existing.productRefs || []).includes(productATag)) {
      return { ok: true, alreadyAbsent: true }
    }
    setPending(true)
    setError(null)
    const next = {
      ...existing,
      productRefs: (existing.productRefs || []).filter(r => r !== productATag),
    }
    upsertLocal(next)
    try {
      const ev = await publishCollectionEvent(next)
      upsertLocal(next, ev)
      return { ok: true }
    } catch (e) {
      upsertLocal(existing)  // rollback
      setError(e?.message || 'Remove failed.')
      return { ok: false, error: e?.message || 'Remove failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, collections, publishCollectionEvent, upsertLocal])

  /**
   * Delete a collection via NIP-09 kind 5. Local state removes it
   * immediately; the relay-side respect is advisory.
   *
   * Refuses to delete the watchlist (d:watchlist) — it's a system
   * collection. Empty it via removeFromCollection if you want it
   * cleared but preserved.
   */
  const deleteCollection = useCallback(async (dTag) => {
    if (!dTag || pending) return { ok: false, reason: 'busy-or-empty' }
    if (dTag === WATCHLIST_D_TAG) {
      return { ok: false, error: 'The watchlist cannot be deleted.' }
    }
    if (!pubkey) return { ok: false, error: 'No pubkey' }
    // Defensive: only the author can delete their own collection. The
    // hook is shared between session-owned views and visitor-profile
    // views, so guard against mis-wired callers signing a kind 5 with
    // someone else's `a` coord (which relays would reject anyway, but
    // we don't want to leak a misleading "deleted" toast).
    const ndk = getNDK()
    const activePubkey = ndk?.activeUser?.pubkey
    if (!activePubkey || activePubkey !== pubkey) {
      const errMsg = 'You can only delete your own collections.'
      setError(errMsg)
      return { ok: false, error: errMsg }
    }
    setPending(true)
    setError(null)
    const prevCollections = collections
    setCollections(prev => prev.filter(c => c.decoded.dTag !== dTag))
    try {
      if (!ndk?.signer) throw new Error('No signer available')
      const coord = buildCollectionCoord(pubkey, dTag)
      const ev = new NDKEvent(ndk, {
        kind: 5,
        content: 'Collection deleted',
        created_at: Math.floor(Date.now() / 1000),
        tags: [['a', coord]],
      })
      await signWithTimeout(ev)
      await publishToOwnOutbox(ev)
      return { ok: true }
    } catch (e) {
      setCollections(prevCollections)
      setError(e?.message || 'Delete failed.')
      return { ok: false, error: e?.message || 'Delete failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, pubkey, collections])

  return {
    collections,
    loading,
    error,
    pending,
    find,
    containingCollections,
    createCollection,
    updateMetadata,
    addToCollection,
    removeFromCollection,
    deleteCollection,
    reload,
  }
}
