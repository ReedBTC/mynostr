/**
 * useReadingLists — NIP-51 reading list management.
 *
 * Fetches three kinds of bookmark events from Nostr relays:
 *   - kind 10003: Standard NIP-51 bookmark list (single, unsorted)
 *   - kind 30001: Generic lists / reading lists (replaceable, d-tag)
 *   - kind 30003: Bookmark sets (replaceable, d-tag)
 *
 * Each event can store articles two ways (both supported):
 *   1. NIP-51 standard: `a` tags like ["a", "30023:pubkey:d-tag"]
 *   2. Our extended format: JSON in content with [{aTag, title, image, author, addedAt, tTags}]
 *
 * After loading, a background enrichment pass fetches the actual kind 30023
 * events for any bookmark items that are missing title/image/author (i.e. items
 * that came in as bare `a` tags from other Nostr apps). The enriched metadata
 * is cached in localStorage for instant display on subsequent loads.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK } from './ndk.js'

const STORAGE_KEY = 'mynostr_reading_lists'

// ── LocalStorage helpers ──────────────────────────────────────────────────────

function loadFromStorage() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}

function saveToStorage(lists) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(lists)) } catch {}
}

// ── Nostr event helpers ───────────────────────────────────────────────────────

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `list-${Date.now()}`
}

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

function eventToList(event) {
  const kind = event.kind

  let id, title
  if (kind === 10003) {
    id    = '_bookmarks'
    title = 'Bookmarks'
  } else {
    id    = event.tags?.find(t => t[0] === 'd')?.[1] || event.id
    title = event.tags?.find(t => t[0] === 'title')?.[1] || id
  }

  // Try our extended JSON content format first
  let articles = []
  try {
    const parsed = JSON.parse(event.content || '[]')
    if (Array.isArray(parsed)) articles = parsed
  } catch {}

  // Also parse NIP-51 `a` tags for articles not already in our JSON
  const existingATags = new Set(articles.map(a => a.aTag))
  const aTags = event.tags?.filter(t => t[0] === 'a') || []
  for (const tag of aTags) {
    const aTag = tag[1]
    if (!aTag || existingATags.has(aTag)) continue
    // Accept addressable event references (kind:pubkey:d-tag format)
    if (!aTag.includes(':')) continue
    // Accept long-form articles (30023) and recipes (30078)
    const kind = aTag.split(':')[0]
    if (kind !== '30023' && kind !== '30078') continue
    existingATags.add(aTag)
    articles.push({
      aTag,
      title: '',
      image: '',
      author: '',
      tTags: [],
      addedAt: event.created_at ? event.created_at * 1000 : Date.now(),
    })
  }

  return { id, title, articles, createdAt: event.created_at }
}

// ── Background enrichment ───────────────────────────────────────────────────
// Fetches kind 30023 events for bookmark items missing metadata, then fetches
// kind 0 profiles for the authors. Updates items in-place and returns true if
// any items were enriched.

// Returns true if a string looks like a hex pubkey fragment or npub, not a real name
function isHexLike(str) {
  if (!str) return true
  return /^[a-f0-9]{6,}$/i.test(str) || str.startsWith('npub')
}

async function enrichBookmarkItems(lists) {
  const ndk = getNDK()

  // Separate items into two buckets:
  // 1. needsArticle: missing title (bare `a` tag imports) — fetch kind 30023 + profile
  // 2. needsProfile: has title but missing real author name — just fetch kind 0 profile
  const needsArticle = []
  const needsProfile = []
  const allPubkeys = new Set()

  for (const list of lists) {
    for (const item of list.articles) {
      if (!item.aTag) continue
      const pubkey = item.aTag.split(':')[1]
      if (!pubkey) continue

      if (!item.title) {
        needsArticle.push(item)
        allPubkeys.add(pubkey)
      } else if (isHexLike(item.author) || !item.authorPic) {
        needsProfile.push(item)
        allPubkeys.add(pubkey)
      }
    }
  }

  if (needsArticle.length === 0 && needsProfile.length === 0) return false

  // Group article-needing items by author for batched queries
  const byAuthor = new Map()
  for (const item of needsArticle) {
    const parts = item.aTag.split(':')
    if (parts.length < 3) continue
    const kind   = Number(parts[0]) || 30023
    const pubkey = parts[1]
    const dTag   = parts.slice(2).join(':')
    if (!byAuthor.has(pubkey)) byAuthor.set(pubkey, [])
    byAuthor.get(pubkey).push({ item, dTag, kind })
  }

  // Fetch articles for bare-tag items
  const articleMap = new Map()
  if (byAuthor.size > 0) {
    const fetches = Array.from(byAuthor.entries()).map(async ([pubkey, items]) => {
      try {
        const dTags = items.map(i => i.dTag)
        const kinds = [...new Set(items.map(i => i.kind))]
        const events = await Promise.race([
          ndk.fetchEvents({ kinds, authors: [pubkey], '#d': dTags }),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000)),
        ])
        for (const ev of Array.from(events)) {
          const d = getTag(ev, 'd')
          const aTag = `${ev.kind}:${ev.pubkey}:${d}`
          articleMap.set(aTag, ev)
        }
      } catch {}
    })
    await Promise.allSettled(fetches)
  }

  // Fetch profiles for ALL pubkeys that need enrichment (both buckets)
  const profileMap = new Map()
  if (allPubkeys.size > 0) {
    try {
      const profileEvents = await Promise.race([
        ndk.fetchEvents({ kinds: [0], authors: Array.from(allPubkeys) }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000)),
      ])
      for (const ev of Array.from(profileEvents)) {
        try { profileMap.set(ev.pubkey, JSON.parse(ev.content)) } catch {}
      }
    } catch {}
  }

  // Enrich bare-tag items (title + image + author + pic)
  let enriched = false
  for (const item of needsArticle) {
    const pubkey = item.aTag.split(':')[1]
    const ev = articleMap.get(item.aTag)
    const profile = profileMap.get(pubkey)

    if (ev) {
      item.title = getTag(ev, 'title') || item.title
      item.image = getTag(ev, 'image') || item.image
      item.tTags = ev.tags?.filter(t => t[0] === 't').map(t => t[1]) || item.tTags || []
    }
    if (profile) {
      const name = profile.display_name || profile.name || ''
      if (name) item.author = name
      if (profile.picture) item.authorPic = profile.picture
    }
    if (ev || profile) enriched = true
  }

  // Enrich profile-only items (author name + pic)
  for (const item of needsProfile) {
    const pubkey = item.aTag.split(':')[1]
    const profile = profileMap.get(pubkey)
    if (!profile) continue
    const name = profile.display_name || profile.name || ''
    if (name && isHexLike(item.author)) item.author = name
    if (profile.picture && !item.authorPic) item.authorPic = profile.picture
    enriched = true
  }

  return enriched
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useReadingLists(user) {
  const [lists,   setLists]   = useState([])
  const [loading, setLoading] = useState(true)
  const enrichingRef = useRef(false)

  const pubkey   = user?.pubkey
  const readOnly = !!user?.readOnly

  // Load from Nostr on mount; localStorage as fallback / read-only store
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)

      if (readOnly || !pubkey) {
        setLists(loadFromStorage())
        setLoading(false)
        return
      }

      try {
        const ndk    = getNDK()
        const events = await ndk.fetchEvents({
          kinds: [10003, 30001, 30003],
          authors: [pubkey],
        })
        if (cancelled) return

        const parsed = Array.from(events).map(eventToList)

        // Merge duplicate IDs
        const merged = new Map()
        for (const list of parsed) {
          if (merged.has(list.id)) {
            const existing = merged.get(list.id)
            const seen = new Set(existing.articles.map(a => a.aTag))
            for (const art of list.articles) {
              if (!seen.has(art.aTag)) {
                existing.articles.push(art)
                seen.add(art.aTag)
              }
            }
            if (list.createdAt > existing.createdAt) {
              existing.createdAt = list.createdAt
              existing.title = list.title
            }
          } else {
            merged.set(list.id, list)
          }
        }

        // Filter out "deleted" lists (empty articles = deletion marker from deleteList)
        const result = Array.from(merged.values()).filter(l => l.articles.length > 0)
        result.sort((a, b) => b.createdAt - a.createdAt)

        // Merge cached metadata (author, authorPic, title, image) from localStorage
        // into fresh relay data so enriched info isn't lost on reload
        const cached = loadFromStorage()
        const cachedItemMap = new Map()
        for (const list of cached) {
          for (const art of (list.articles || [])) {
            if (art.aTag) cachedItemMap.set(art.aTag, art)
          }
        }
        for (const list of result) {
          for (const art of list.articles) {
            const c = cachedItemMap.get(art.aTag)
            if (!c) continue
            if (!art.author    && c.author)    art.author    = c.author
            if (!art.authorPic && c.authorPic) art.authorPic = c.authorPic
            if (!art.title     && c.title)     art.title     = c.title
            if (!art.image     && c.image)     art.image     = c.image
            if ((!art.tTags || art.tTags.length === 0) && c.tTags?.length) art.tTags = c.tTags
          }
        }

        setLists(result)
        saveToStorage(result)

        // Background enrichment — fetch metadata for items still missing info
        if (!cancelled && !enrichingRef.current) {
          enrichingRef.current = true
          enrichBookmarkItems(result).then(didEnrich => {
            enrichingRef.current = false
            if (cancelled) return
            if (didEnrich) {
              // Force a re-render with the enriched data
              setLists([...result])
              saveToStorage(result)
            }
          }).catch(() => { enrichingRef.current = false })
        }
      } catch {
        setLists(loadFromStorage())
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [pubkey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Publish a list to Nostr and update local state
  const publishList = useCallback(async (list) => {
    const updated = (prev) =>
      prev.some(l => l.id === list.id)
        ? prev.map(l => l.id === list.id ? list : l)
        : [list, ...prev]

    if (!readOnly && pubkey) {
      try {
        const ndk   = getNDK()
        const event = new NDKEvent(ndk)
        event.kind    = 30001
        event.tags    = [['d', list.id], ['title', list.title]]
        for (const art of list.articles) {
          if (art.aTag) event.tags.push(['a', art.aTag])
        }
        event.content = JSON.stringify(list.articles)
        await event.sign()
        await event.publish()
      } catch {
        // Non-fatal — local state still updated
      }
    }

    setLists(prev => {
      const next = updated(prev)
      saveToStorage(next)
      return next
    })
  }, [readOnly, pubkey])

  const createList = useCallback(async (name) => {
    const list = {
      id:        makeSlug(name),
      title:     name,
      articles:  [],
      createdAt: Math.floor(Date.now() / 1000),
    }
    await publishList(list)
    return list
  }, [publishList])

  const addArticle = useCallback(async (listId, articleMeta) => {
    setLists(prev => {
      const list = prev.find(l => l.id === listId)
      if (!list) return prev
      if (list.articles.some(a => a.aTag === articleMeta.aTag)) return prev
      const updated = { ...list, articles: [...list.articles, articleMeta] }
      publishList(updated)
      return prev
    })
  }, [publishList])

  const removeArticle = useCallback(async (listId, aTag) => {
    setLists(prev => {
      const list = prev.find(l => l.id === listId)
      if (!list) return prev
      const updated = { ...list, articles: list.articles.filter(a => a.aTag !== aTag) }
      publishList(updated)
      return prev
    })
  }, [publishList])

  const deleteList = useCallback(async (listId) => {
    if (!readOnly && pubkey) {
      try {
        const ndk   = getNDK()
        const event = new NDKEvent(ndk)
        event.kind    = 30001
        event.tags    = [['d', listId]]
        event.content = ''
        await event.sign()
        await event.publish()
      } catch {}
    }
    setLists(prev => {
      const next = prev.filter(l => l.id !== listId)
      saveToStorage(next)
      return next
    })
  }, [readOnly, pubkey])

  const renameList = useCallback(async (listId, newTitle) => {
    setLists(prev => {
      const list = prev.find(l => l.id === listId)
      if (!list) return prev
      const updated = { ...list, title: newTitle }
      publishList(updated)
      return prev
    })
  }, [publishList])

  const moveArticle = useCallback(async (fromListId, toListId, aTag) => {
    setLists(prev => {
      const from = prev.find(l => l.id === fromListId)
      const to   = prev.find(l => l.id === toListId)
      if (!from || !to) return prev
      const item = from.articles.find(a => a.aTag === aTag)
      if (!item) return prev
      if (to.articles.some(a => a.aTag === aTag)) {
        // Already in target — just remove from source
        const updatedFrom = { ...from, articles: from.articles.filter(a => a.aTag !== aTag) }
        publishList(updatedFrom)
        return prev
      }
      const updatedFrom = { ...from, articles: from.articles.filter(a => a.aTag !== aTag) }
      const updatedTo   = { ...to,   articles: [...to.articles, item] }
      publishList(updatedFrom)
      publishList(updatedTo)
      return prev
    })
  }, [publishList])

  const reorderLists = useCallback((fromIndex, toIndex) => {
    setLists(prev => {
      if (fromIndex < 0 || fromIndex >= prev.length) return prev
      if (toIndex   < 0 || toIndex   >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      saveToStorage(next)
      return next
    })
  }, [])

  return { lists, loading, createList, addArticle, removeArticle, moveArticle, deleteList, renameList, reorderLists }
}
