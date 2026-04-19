/**
 * useNoteBookmarks — categorized bookmark management for kind 1 notes.
 *
 * Parallel to useReadingLists (longform) but structured around `e` tags
 * (plain event ids) instead of NIP-33 `a` tags (addressable events).
 *
 * Storage model:
 *   - Kind 10003 (NIP-51 standard bookmark list): READ/WRITE, but CAREFUL.
 *     Surfaced as a synthetic category called "Bookmarks" pinned to the
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
 *   where readOnly is true for the synthetic "Bookmarks" (kind 10003) row.
 *
 * Visitor mode: when the user is read-only (viewing someone else's page),
 * we fetch the same events but disable all mutating functions.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK } from './ndk.js'

const STORAGE_KEY_PREFIX = 'mynostr_note_bookmarks:'
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

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `cat-${Date.now()}`
}

function parseEventToCategory(event) {
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
      title: 'Bookmarks',
      items,
      createdAt: event.created_at || 0,
      readOnly: false,
      extraTags,
      rawContent: event.content || '',
    }
  }

  // Kind 30003
  const dTag  = event.tags?.find(t => t[0] === 'd')?.[1] || event.id
  const title = event.tags?.find(t => t[0] === 'title')?.[1] || dTag

  // Prefer the extended JSON content — it carries addedAt per item.
  // Fall back to bare `e` tags if content isn't valid JSON.
  const byId = new Map()
  try {
    const parsed = JSON.parse(event.content || '[]')
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        if (it?.id && /^[0-9a-f]{64}$/i.test(it.id)) {
          byId.set(it.id.toLowerCase(), { id: it.id.toLowerCase(), addedAt: Number(it.addedAt) || 0 })
        }
      }
    }
  } catch {}
  for (const t of event.tags || []) {
    if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
      const id = t[1].toLowerCase()
      if (!byId.has(id)) byId.set(id, { id, addedAt: (event.created_at || 0) * 1000 })
    }
  }
  return {
    id: dTag,
    title,
    items: Array.from(byId.values()),
    createdAt: event.created_at || 0,
    readOnly: false,
  }
}

/**
 * Returns { categories, loading, createCategory, addNote, removeNote,
 * deleteCategory, renameCategory }.
 */
export function useNoteBookmarks(user) {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)

  const pubkey   = user?.pubkey
  const readOnly = !!user?.readOnly
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

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
          ndk.fetchEvents({ kinds: [10003, 30003], authors: [pubkey] }),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
        ])
        if (cancelled) return

        const parsed = Array.from(events).map(parseEventToCategory)
        // Merge (dedup by id, preferring the newest createdAt per id).
        const byId = new Map()
        for (const cat of parsed) {
          const existing = byId.get(cat.id)
          if (!existing || cat.createdAt > existing.createdAt) byId.set(cat.id, cat)
        }
        // Drop deleted categories (30003 written with empty tags/content).
        const result = Array.from(byId.values()).filter(c => c.items.length > 0)
        // Order: primary "Bookmarks" (kind 10003) first — it's the default
        // target most users recognize — then custom 30003 categories
        // newest-first.
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
  const publishCategory = useCallback(async (cat) => {
    if (readOnly || !pubkey) return
    if (cat.readOnly) return
    try {
      const ndk = getNDK()
      const event = new NDKEvent(ndk)
      if (cat.id === PRIMARY_CATEGORY_ID) {
        event.kind = 10003
        event.tags = [...(cat.extraTags || [])]
        for (const it of cat.items) {
          if (it?.id) event.tags.push(['e', it.id])
        }
        event.content = cat.rawContent || ''
      } else {
        event.kind = 30003
        event.tags = [['d', cat.id], ['title', cat.title]]
        for (const it of cat.items) {
          if (it?.id) event.tags.push(['e', it.id])
        }
        event.content = JSON.stringify(cat.items)
      }
      await event.sign()
      await event.publish()
    } catch {
      // Best-effort — local state is already updated; republish on next
      // mutation.
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
    // Optimistic: add locally so the submenu shows it instantly.
    setCategories(prev => {
      if (prev.some(c => c.id === id)) return prev
      const next = [cat, ...prev]
      saveToStorage(pubkey, next)
      return next
    })
    await publishCategory(cat)
    return cat
  }, [readOnly, pubkey, publishCategory])

  const addNote = useCallback(async (categoryId, noteId) => {
    if (readOnly || !noteId) return
    const id = noteId.toLowerCase()
    let updated = null
    setCategories(prev => {
      const cat = prev.find(c => c.id === categoryId)
      if (!cat || cat.readOnly) return prev
      if (cat.items.some(it => it.id === id)) return prev
      const newCat = { ...cat, items: [{ id, addedAt: Date.now() }, ...cat.items] }
      updated = newCat
      const next = prev.map(c => c.id === categoryId ? newCat : c)
      saveToStorage(pubkey, next)
      return next
    })
    if (updated) await publishCategory(updated)
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

  const deleteCategory = useCallback(async (categoryId) => {
    if (readOnly) return
    if (categoryId === PRIMARY_CATEGORY_ID) return
    setCategories(prev => {
      const cat = prev.find(c => c.id === categoryId)
      if (!cat || cat.readOnly) return prev
      const next = prev.filter(c => c.id !== categoryId)
      saveToStorage(pubkey, next)
      return next
    })
    // Publish an empty replaceable to signal deletion to relays.
    try {
      const ndk = getNDK()
      const event = new NDKEvent(ndk)
      event.kind = 30003
      event.tags = [['d', categoryId]]
      event.content = ''
      await event.sign()
      await event.publish()
    } catch {}
  }, [readOnly, pubkey])

  return { categories, loading, createCategory, addNote, removeNote, deleteCategory, renameCategory }
}

export const NOTE_PRIMARY_CATEGORY_ID = PRIMARY_CATEGORY_ID
