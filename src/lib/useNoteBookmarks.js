/**
 * useNoteBookmarks — categorized bookmark management for kind 1 notes.
 *
 * Parallel to useReadingLists (longform) but structured around `e` tags
 * (plain event ids) instead of NIP-33 `a` tags (addressable events).
 *
 * Storage model:
 *   - Kind 10003 (NIP-51 standard bookmark list): READ/WRITE, but CAREFUL.
 *     Surfaced as a synthetic category called "Ungrouped" pinned to the
 *     top. When we republish, we preserve the event's original `content`
 *     field (other clients store NIP-04 encrypted private bookmarks
 *     there — clobbering it would silently destroy user data) and any
 *     non-`e` tags (`a`/`t`/`r` from NIP-51). We only add or remove `e`
 *     tags. If a user has never created a 10003 event, we don't
 *     synthesize one; first add creates it.
 *   - Kind 30003 (bookmark sets): READ/WRITE. Each event is one category.
 *     - tags: [['d', categoryId], ['title', name], ['e', id], ['e', id] …]
 *     - content: JSON array [{ id, addedAt }, ...] — mynostr extension so
 *       we can sort "chronological by date bookmarked" without depending
 *       on tag order. Other clients ignore unknown content gracefully.
 *
 * Items returned for UI consumption:
 *   categories: [{ id, title, items: [{ id, addedAt }], createdAt, readOnly }]
 *   where readOnly is true for the synthetic "Ungrouped" (kind 10003) row.
 *
 * Visitor mode: when the user is read-only (viewing someone else's page),
 * we fetch the same events but disable all mutating functions.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout } from './ndk.js'

// Fetch the freshest kind 10003 event from relays. Used immediately
// before publishing the primary bookmark list so any data the longform
// module wrote since our load is preserved through our publish instead
// of silently clobbered. On fetch failure (timeout, offline) callers
// fall back to their cached `extraTags` / `rawContent` — no worse than
// pre-merge behavior.
async function fetchLatestPrimary(pubkey) {
  if (!pubkey) return null
  try {
    const ndk = getNDK()
    const events = await Promise.race([
      ndk.fetchEvents({ kinds: [10003], authors: [pubkey] }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
    ])
    let fresh = null
    for (const ev of events) {
      if (!fresh || (ev.created_at || 0) > (fresh.created_at || 0)) fresh = ev
    }
    return fresh
  } catch {
    return null
  }
}

const STORAGE_KEY_PREFIX = 'mynostr_note_bookmarks:'
const HIDDEN_STORAGE_KEY_PREFIX = 'mynostr_note_hidden_bookmarks:'
const PRIMARY_CATEGORY_ID = '_primary'

function storageKeyFor(pubkey) {
  return pubkey ? `${STORAGE_KEY_PREFIX}${pubkey}` : null
}
function loadFromStorage(pubkey) {
  const key = storageKeyFor(pubkey)
  if (!key) return []
  try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
}
function saveToStorage(pubkey, categories) {
  const key = storageKeyFor(pubkey)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(categories)) } catch {}
}

// Per-pubkey list of category ids that the user has client-side-hidden from
// the Notes module. Hidden is purely a display preference — the underlying
// 30001/30003 events stay on relays and other clients/modules still see
// them. Primary (_primary) is never hideable.
function hiddenStorageKeyFor(pubkey) {
  return pubkey ? `${HIDDEN_STORAGE_KEY_PREFIX}${pubkey}` : null
}
function loadHiddenFromStorage(pubkey) {
  const key = hiddenStorageKeyFor(pubkey)
  if (!key) return []
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : []
  } catch { return [] }
}
function saveHiddenToStorage(pubkey, ids) {
  const key = hiddenStorageKeyFor(pubkey)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify([...ids])) } catch {}
}

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `cat-${Date.now()}`
}

// A category event that was published with a d-tag but nothing else is a
// tombstone — our deleteCategory path writes exactly that shape. Filtering
// these out keeps deleted categories from reappearing after a relay refetch.
function isTombstone(event) {
  if (event.kind !== 30001 && event.kind !== 30003) return false
  const tags = event.tags || []
  const onlyDTag = tags.length === 1 && tags[0]?.[0] === 'd'
  const emptyContent = !event.content || event.content === ''
  return onlyDTag && emptyContent
}

export function parseEventToCategory(event) {
  if (event.kind === 10003) {
    // Primary bookmark list. Items come from `e` tags only — NIP-51
    // doesn't timestamp them, so addedAt defaults to the event's
    // created_at. We stash the original `content` and any non-`e` tags
    // so republish is non-destructive (see publishCategory).
    const items = []
    const seen = new Set()
    const extraTags = []
    for (const t of event.tags || []) {
      if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
        const id = t[1].toLowerCase()
        if (!seen.has(id)) { seen.add(id); items.push({ id, addedAt: (event.created_at || 0) * 1000 }) }
      } else {
        extraTags.push(t)
      }
    }
    return {
      id: PRIMARY_CATEGORY_ID,
      title: 'Ungrouped',
      items,
      createdAt: event.created_at || 0,
      readOnly: false,
      extraTags,
      rawContent: event.content || '',
    }
  }

  // Kind 30001 / 30003 — both are categorized bookmark sets. 30001 is the
  // older "generic list" kind (used by the longform module); 30003 is the
  // current NIP-51 bookmark-set kind (used by the notes module). Read both
  // so a single unified category set shows up in both feeds.
  const dTag  = event.tags?.find(t => t[0] === 'd')?.[1] || event.id
  const title = event.tags?.find(t => t[0] === 'title')?.[1] || dTag

  // Prefer the extended JSON content — it carries addedAt per item.
  // Fall back to bare `e` tags if content isn't valid JSON.
  // Round-trip preservation: any content item that isn't our `{id, addedAt}`
  // shape (notably the longform module's `{aTag, title, ...}`) gets stashed
  // verbatim so republishing from the notes UI doesn't nuke other modules'
  // data in shared categories.
  const byId = new Map()
  const otherContentItems = []
  try {
    const parsed = JSON.parse(event.content || '[]')
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        if (it?.id && /^[0-9a-f]{64}$/i.test(it.id)) {
          byId.set(it.id.toLowerCase(), { id: it.id.toLowerCase(), addedAt: Number(it.addedAt) || 0 })
        } else if (it && typeof it === 'object') {
          otherContentItems.push(it)
        }
      }
    }
  } catch {}
  // Same for tags: preserve every non-managed tag (anything that isn't a
  // kind-1 `e` reference or the d/title we rewrite ourselves) so a-tag
  // bookmarks written by longform survive a round-trip.
  const extraTags = []
  for (const t of event.tags || []) {
    if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
      const id = t[1].toLowerCase()
      if (!byId.has(id)) byId.set(id, { id, addedAt: (event.created_at || 0) * 1000 })
    } else if (t[0] !== 'd' && t[0] !== 'title') {
      extraTags.push(t)
    }
  }
  return {
    id: dTag,
    title,
    items: Array.from(byId.values()),
    createdAt: event.created_at || 0,
    readOnly: false,
    sourceKind: event.kind,
    extraTags,
    otherContentItems,
  }
}

/**
 * Returns { categories, loading, createCategory, addNote, removeNote,
 * deleteCategory, renameCategory }.
 */
export function useNoteBookmarks(user) {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  // Mirror of `categories` so async flows (deleteCategory) can read the
  // current value without wrapping logic in a setState reducer.
  const categoriesRef = useRef([])
  useEffect(() => { categoriesRef.current = categories }, [categories])

  const pubkey   = user?.pubkey
  const readOnly = !!user?.readOnly

  // Load per-pubkey hidden set whenever the session user changes.
  useEffect(() => {
    if (!pubkey) { setHiddenIds(new Set()); return }
    setHiddenIds(new Set(loadHiddenFromStorage(pubkey)))
  }, [pubkey])

  const hideCategory = useCallback((categoryId) => {
    if (!categoryId || categoryId === PRIMARY_CATEGORY_ID) return
    setHiddenIds(prev => {
      if (prev.has(categoryId)) return prev
      const next = new Set(prev)
      next.add(categoryId)
      saveHiddenToStorage(pubkey, next)
      return next
    })
  }, [pubkey])

  const unhideCategory = useCallback((categoryId) => {
    if (!categoryId) return
    setHiddenIds(prev => {
      if (!prev.has(categoryId)) return prev
      const next = new Set(prev)
      next.delete(categoryId)
      saveHiddenToStorage(pubkey, next)
      return next
    })
  }, [pubkey])

  useEffect(() => {
    if (!pubkey) {
      setCategories([])
      setLoading(false)
      return
    }
    setLoading(true)

    // Show cached state immediately so the three-dot menu can render
    // existing category names before relays answer.
    const cached = loadFromStorage(pubkey)
    if (cached.length > 0) setCategories(cached)

    let cancelled = false
    ;(async () => {
      try {
        const ndk = getNDK()
        const events = await Promise.race([
          ndk.fetchEvents({ kinds: [10003, 30001, 30003], authors: [pubkey] }),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
        ])
        if (cancelled) return

        // Parse everything but tombstones so empty-for-kind categories still
        // show in the chip bar (they just render with a 0 count — the user
        // can see the list exists and pick it to add notes to).
        const parsed = Array.from(events)
          .filter(ev => !isTombstone(ev))
          .map(parseEventToCategory)
        // Merge (dedup by id, preferring the newest createdAt per id).
        const byId = new Map()
        for (const cat of parsed) {
          const existing = byId.get(cat.id)
          if (!existing || cat.createdAt > existing.createdAt) byId.set(cat.id, cat)
        }
        const result = Array.from(byId.values())
        // Order: primary "Ungrouped" (kind 10003) first — it's the default
        // target for anything without a category — then custom 30003
        // categories newest-first.
        result.sort((a, b) => {
          if (a.id === PRIMARY_CATEGORY_ID) return -1
          if (b.id === PRIMARY_CATEGORY_ID) return 1
          return b.createdAt - a.createdAt
        })
        if (cancelled) return
        setCategories(result)
        if (!readOnly) saveToStorage(pubkey, result)
      } catch {
        if (cancelled) return
        // On failure, stick with whatever was cached.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, readOnly])

  // Publish a category. Primary (kind 10003) preserves original content +
  // any non-`e` tags so we don't clobber data written by other clients
  // (NIP-04 encrypted private bookmarks in `content`; `t`/`r`/`a` tags).
  // Custom categories write as kind 30003 with a d-tag.
  //
  // Returns true iff the relay publish succeeded. Callers that need to
  // gate a follow-up action (e.g., deleteCategory won't tombstone unless
  // the merged primary publish was durable) check this; everyone else
  // can ignore it — local state is updated by the caller independently.
  const publishCategory = useCallback(async (cat) => {
    if (readOnly || !pubkey) return false
    if (cat.readOnly) return false
    try {
      const ndk = getNDK()
      const event = new NDKEvent(ndk)
      if (cat.id === PRIMARY_CATEGORY_ID) {
        // Cross-module merge — refetch the latest 10003 so any data the
        // longform module wrote since our load isn't silently clobbered.
        const fresh = await fetchLatestPrimary(pubkey)
        let preservedTags = cat.extraTags || []
        let contentOverride = cat.rawContent || ''
        if (fresh) {
          // Keep every non-`e` tag (longform's `a`-tags, NIP-51 `t`/`r`
          // tags, etc). We rewrite the `e`-tag set completely from our
          // `cat.items`.
          preservedTags = (fresh.tags || []).filter(t => t[0] !== 'e')
          // Content strategy: if it's a JSON array (shared format
          // between modules), rebuild it — our `{id,addedAt}` items +
          // every non-note item (longform's `{aTag,...}`). If it isn't
          // JSON (likely NIP-04 encrypted private bookmarks that only
          // the owner's other client can decrypt), preserve verbatim.
          let parsed = null
          try {
            const p = JSON.parse(fresh.content || '[]')
            if (Array.isArray(p)) parsed = p
          } catch {}
          if (parsed) {
            const longformItems = parsed.filter(it => it && typeof it === 'object' && it.aTag)
            const mergedContent = [
              ...cat.items.map(it => ({ id: it.id, addedAt: it.addedAt || 0 })),
              ...longformItems,
            ]
            contentOverride = JSON.stringify(mergedContent)
          } else if (fresh.content && fresh.content !== '') {
            // Non-JSON content — almost certainly ciphertext. Don't touch it.
            contentOverride = fresh.content
          } else {
            contentOverride = ''
          }
        }
        event.kind = 10003
        event.tags = [...preservedTags]
        for (const it of cat.items) {
          if (it?.id) event.tags.push(['e', it.id])
        }
        event.content = contentOverride
      } else {
        // Preserve the source kind (30001 or 30003) so categories authored
        // by other modules stay on their original kind. New categories
        // created here default to 30003 (current NIP-51 convention).
        event.kind = cat.sourceKind === 30001 ? 30001 : 30003
        event.tags = [['d', cat.id], ['title', cat.title], ...(cat.extraTags || [])]
        for (const it of cat.items) {
          if (it?.id) event.tags.push(['e', it.id])
        }
        // Merge our items with any foreign content items (e.g., longform's
        // `{aTag, ...}`) so they round-trip intact.
        const mergedContent = [...cat.items, ...(cat.otherContentItems || [])]
        event.content = JSON.stringify(mergedContent)
      }
      await signWithTimeout(event)
      await event.publish()
      return true
    } catch {
      // Best-effort — local state is already updated; republish on next
      // mutation.
      return false
    }
  }, [readOnly, pubkey])

  const createCategory = useCallback(async (name) => {
    if (readOnly) return null
    const trimmed = (name || '').trim()
    if (!trimmed) return null
    const id = makeSlug(trimmed)
    const cat = {
      id,
      title: trimmed,
      items: [],
      createdAt: Math.floor(Date.now() / 1000),
      readOnly: false,
    }
    // Local only — publishing an empty 30003 would either clash with our
    // delete convention (empty = tombstone) or pollute relays. First
    // addNote publishes the category with real items.
    setCategories(prev => {
      if (prev.some(c => c.id === id)) return prev
      const next = [cat, ...prev]
      saveToStorage(pubkey, next)
      return next
    })
    return cat
  }, [readOnly, pubkey])

  // Mutually-exclusive bookmarks: a note lives in exactly one bucket at a
  // time. Adding to target X removes from every other bucket (primary + any
  // other 30003 set) it was in. We batch the state mutation so the UI sees
  // one atomic move, then publish each affected bucket in sequence.
  //
  // Trade-off: moving between kinds costs two signatures (e.g., 10003 out +
  // 30003 in). Most NIP-07 extensions auto-approve replaceables; NIP-46
  // signers surface it as two prompts. Acceptable for v1.
  const addNote = useCallback(async (categoryId, noteId) => {
    if (readOnly || !noteId) return
    const id = noteId.toLowerCase()
    const toPublish = []
    setCategories(prev => {
      const target = prev.find(c => c.id === categoryId)
      if (!target) return prev

      const next = prev.map(c => {
        if (c.id === categoryId) {
          if (c.items.some(it => it.id === id)) return c  // already there — no-op
          const newCat = { ...c, items: [{ id, addedAt: Date.now() }, ...c.items] }
          toPublish.push(newCat)
          return newCat
        }
        // Evict from any other bucket that held it.
        if (c.items.some(it => it.id === id)) {
          const newCat = { ...c, items: c.items.filter(it => it.id !== id) }
          toPublish.push(newCat)
          return newCat
        }
        return c
      })
      saveToStorage(pubkey, next)
      return next
    })
    for (const cat of toPublish) {
      await publishCategory(cat)
    }
  }, [readOnly, pubkey, publishCategory])

  const removeNote = useCallback(async (categoryId, noteId) => {
    if (readOnly || !noteId) return
    const id = noteId.toLowerCase()
    let updated = null
    setCategories(prev => {
      const cat = prev.find(c => c.id === categoryId)
      if (!cat || cat.readOnly) return prev
      const newCat = { ...cat, items: cat.items.filter(it => it.id !== id) }
      updated = newCat
      const next = prev.map(c => c.id === categoryId ? newCat : c)
      saveToStorage(pubkey, next)
      return next
    })
    if (updated) await publishCategory(updated)
  }, [readOnly, pubkey, publishCategory])

  // Bulk move: same mutual-exclusivity semantics as addNote, but for a
  // batch. One state mutation plus one publish per *changed* category
  // (source buckets + destination) — not per note. Moving 20 notes from
  // Ungrouped → Reading Queue is 2 signatures, not 40.
  const bulkMove = useCallback(async (targetCategoryId, noteIds) => {
    if (readOnly || !Array.isArray(noteIds) || noteIds.length === 0) return
    const idSet = new Set(noteIds.map(n => n.toLowerCase()).filter(n => /^[0-9a-f]{64}$/.test(n)))
    if (idSet.size === 0) return
    const toPublish = []
    setCategories(prev => {
      const target = prev.find(c => c.id === targetCategoryId)
      if (!target) return prev
      const now = Date.now()
      const next = prev.map(c => {
        if (c.id === targetCategoryId) {
          const existing = new Set(c.items.map(it => it.id))
          const toAdd = [...idSet].filter(id => !existing.has(id))
          if (toAdd.length === 0) return c
          const newCat = {
            ...c,
            items: [...toAdd.map(id => ({ id, addedAt: now })), ...c.items],
          }
          toPublish.push(newCat)
          return newCat
        }
        if (c.items.some(it => idSet.has(it.id))) {
          const newCat = { ...c, items: c.items.filter(it => !idSet.has(it.id)) }
          toPublish.push(newCat)
          return newCat
        }
        return c
      })
      saveToStorage(pubkey, next)
      return next
    })
    for (const cat of toPublish) {
      await publishCategory(cat)
    }
  }, [readOnly, pubkey, publishCategory])

  const bulkRemove = useCallback(async (categoryId, noteIds) => {
    if (readOnly || !Array.isArray(noteIds) || noteIds.length === 0) return
    const idSet = new Set(noteIds.map(n => n.toLowerCase()).filter(n => /^[0-9a-f]{64}$/.test(n)))
    if (idSet.size === 0) return
    let updated = null
    setCategories(prev => {
      const cat = prev.find(c => c.id === categoryId)
      if (!cat || cat.readOnly) return prev
      const newCat = { ...cat, items: cat.items.filter(it => !idSet.has(it.id)) }
      if (newCat.items.length === cat.items.length) return prev
      updated = newCat
      const next = prev.map(c => c.id === categoryId ? newCat : c)
      saveToStorage(pubkey, next)
      return next
    })
    if (updated) await publishCategory(updated)
  }, [readOnly, pubkey, publishCategory])

  // Atomic "create category + move selection into it" — collapses what would
  // otherwise be two separate state transitions (createCategory then bulkMove)
  // into one setCategories call, so bulkMove's reducer can never race the
  // creation. If the slug already exists, we move into the existing category
  // (same forgiveness as createCategory).
  const bulkMoveToNew = useCallback(async (name, noteIds) => {
    if (readOnly || !Array.isArray(noteIds) || noteIds.length === 0) return null
    const trimmed = (name || '').trim()
    if (!trimmed) return null
    const id = makeSlug(trimmed)
    const idSet = new Set(noteIds.map(n => n.toLowerCase()).filter(n => /^[0-9a-f]{64}$/.test(n)))
    if (idSet.size === 0) return null
    const now = Date.now()
    const toPublish = []
    setCategories(prev => {
      const existingAt = prev.findIndex(c => c.id === id)
      let next
      if (existingAt >= 0) {
        // Slug collision — merge into the existing category (respect readOnly).
        if (prev[existingAt].readOnly) return prev
        next = prev.map(c => {
          if (c.id === id) {
            const existing = new Set(c.items.map(it => it.id))
            const toAdd = [...idSet].filter(iid => !existing.has(iid))
            const newCat = {
              ...c,
              items: [...toAdd.map(iid => ({ id: iid, addedAt: now })), ...c.items],
            }
            toPublish.push(newCat)
            return newCat
          }
          if (c.items.some(it => idSet.has(it.id))) {
            const newCat = { ...c, items: c.items.filter(it => !idSet.has(it.id)) }
            toPublish.push(newCat)
            return newCat
          }
          return c
        })
      } else {
        const newCat = {
          id,
          title: trimmed,
          items: [...idSet].map(iid => ({ id: iid, addedAt: now })),
          createdAt: Math.floor(Date.now() / 1000),
          readOnly: false,
        }
        toPublish.push(newCat)
        next = [newCat, ...prev.map(c => {
          if (c.items.some(it => idSet.has(it.id))) {
            const pruned = { ...c, items: c.items.filter(it => !idSet.has(it.id)) }
            toPublish.push(pruned)
            return pruned
          }
          return c
        })]
      }
      saveToStorage(pubkey, next)
      return next
    })
    for (const cat of toPublish) {
      await publishCategory(cat)
    }
    return id
  }, [readOnly, pubkey, publishCategory])

  const renameCategory = useCallback(async (categoryId, newTitle) => {
    if (readOnly) return
    if (categoryId === PRIMARY_CATEGORY_ID) return
    const trimmed = (newTitle || '').trim()
    if (!trimmed) return
    let updated = null
    setCategories(prev => {
      const cat = prev.find(c => c.id === categoryId)
      if (!cat || cat.readOnly) return prev
      const newCat = { ...cat, title: trimmed }
      updated = newCat
      const next = prev.map(c => c.id === categoryId ? newCat : c)
      saveToStorage(pubkey, next)
      return next
    })
    if (updated) await publishCategory(updated)
  }, [readOnly, pubkey, publishCategory])

  // Delete a category. Items inside are moved back to the primary
  // Ungrouped list (creating it locally if the user had never published
  // one) so deleting never silently discards content. Primary gets
  // republished with the merged items, and the deleted category gets a
  // tombstone event (empty replaceable, same kind it was authored in).
  const deleteCategory = useCallback(async (categoryId) => {
    if (readOnly) return
    if (categoryId === PRIMARY_CATEGORY_ID) return

    // Read current categories via ref so the merge is computed from
    // fresh data and nothing is mutated until the durable publish lands.
    const current = categoriesRef.current
    const cat = current.find(c => c.id === categoryId)
    if (!cat || cat.readOnly) return

    const sourceKind    = cat.sourceKind === 30001 ? 30001 : 30003
    const itemsToRehome = cat.items || []

    // ── Atomicity contract ──────────────────────────────────────────────
    // Never leave items with no home. Order of operations:
    //   1. If the category has items, publish merged primary FIRST. If
    //      that fails, ABORT — no local state change, no tombstone.
    //      Items stay safely in the source category.
    //   2. Only after the primary write lands, remove the source category
    //      locally and publish the tombstone.
    // Tombstone failure at step 2 leaves the source category live on
    // relays; items will show in both places on reload (duplication, not
    // loss). User can retry delete.
    let primaryToPublish = null
    if (itemsToRehome.length > 0) {
      const primary = current.find(c => c.id === PRIMARY_CATEGORY_ID)
      if (primary) {
        const existing = new Set(primary.items.map(it => it.id))
        const merged = [
          ...itemsToRehome
            .filter(it => !existing.has(it.id))
            .map(it => ({ id: it.id, addedAt: it.addedAt || Date.now() })),
          ...primary.items,
        ]
        primaryToPublish = { ...primary, items: merged }
      } else {
        // No primary yet — synthesize one. First publish creates the
        // user's kind 10003 event.
        primaryToPublish = {
          id: PRIMARY_CATEGORY_ID,
          title: 'Ungrouped',
          items: itemsToRehome.map(it => ({ id: it.id, addedAt: it.addedAt || Date.now() })),
          createdAt: Math.floor(Date.now() / 1000),
          readOnly: false,
          extraTags: [],
          rawContent: '',
        }
      }
      const primaryOk = await publishCategory(primaryToPublish)
      if (!primaryOk) return
    }

    // Primary is durable (or there was nothing to rehome). Apply local
    // state: merge primary if we rebuilt it, remove the source category.
    setCategories(prev => {
      let next
      if (primaryToPublish) {
        const primaryIdx = prev.findIndex(c => c.id === PRIMARY_CATEGORY_ID)
        if (primaryIdx >= 0) {
          next = prev
            .filter(c => c.id !== categoryId)
            .map(c => c.id === PRIMARY_CATEGORY_ID ? primaryToPublish : c)
        } else {
          next = [primaryToPublish, ...prev.filter(c => c.id !== categoryId)]
        }
      } else {
        next = prev.filter(c => c.id !== categoryId)
      }
      saveToStorage(pubkey, next)
      return next
    })

    // Tombstone the deleted category on the kind it was authored in —
    // replaceables are per-kind, so a 30003 tombstone wouldn't invalidate
    // a 30001 original.
    try {
      const ndk = getNDK()
      const event = new NDKEvent(ndk)
      event.kind = sourceKind
      event.tags = [['d', categoryId]]
      event.content = ''
      await signWithTimeout(event)
      await event.publish()
    } catch {}
  }, [readOnly, pubkey, publishCategory])

  return { categories, loading, createCategory, addNote, removeNote, deleteCategory, renameCategory, bulkMove, bulkRemove, bulkMoveToNew, hiddenIds, hideCategory, unhideCategory }
}

export const NOTE_PRIMARY_CATEGORY_ID = PRIMARY_CATEGORY_ID
