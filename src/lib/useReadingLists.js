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

// Per-pubkey cache so viewing multiple authors on the same machine doesn't
// leak one person's enriched bookmarks into another's display.
const STORAGE_KEY_PREFIX = 'mynostr_reading_lists:'

// Client-side per-pubkey list of hidden category ids. Hiding is a view-only
// preference; the underlying events still exist on relays.
const HIDDEN_STORAGE_KEY_PREFIX = 'mynostr_reading_hidden:'

// The kind-10003 primary list has this synthetic id everywhere in the app.
export const PRIMARY_LIST_ID = '_bookmarks'
export const PRIMARY_LIST_TITLE = 'Ungrouped'

// ── LocalStorage helpers ──────────────────────────────────────────────────────

function storageKeyFor(pubkey) {
  return pubkey ? `${STORAGE_KEY_PREFIX}${pubkey}` : null
}

function loadFromStorage(pubkey) {
  const key = storageKeyFor(pubkey)
  if (!key) return []
  try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
}

function saveToStorage(pubkey, lists) {
  const key = storageKeyFor(pubkey)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(lists)) } catch {}
}

function hiddenStorageKeyFor(pubkey) {
  return pubkey ? `${HIDDEN_STORAGE_KEY_PREFIX}${pubkey}` : null
}

function loadHiddenFromStorage(pubkey) {
  const key = hiddenStorageKeyFor(pubkey)
  if (!key) return new Set()
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]')
    return new Set(Array.isArray(arr) ? arr : [])
  } catch { return new Set() }
}

function saveHiddenToStorage(pubkey, hiddenSet) {
  const key = hiddenStorageKeyFor(pubkey)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(Array.from(hiddenSet))) } catch {}
}

// ── Cross-module concurrency ──────────────────────────────────────────────────
//
// Notes + Longform both read/write the user's single kind 10003 event.
// Each module owns a slice of that event (longform: `a`-tags + aTag items
// in content; notes: `e`-tags + id items in content + any NIP-04
// ciphertext in content). A naive publish-from-in-memory-snapshot races
// the other module and can silently clobber its data.
//
// fetchLatestPrimary fetches the freshest 10003 from relays immediately
// before publishing, so we can pick the *current* slice the other module
// owns and merge it into our new event. If the fetch fails (offline,
// timeout), callers fall back to their cached `extraTags` /
// `otherContentItems` — no worse than the pre-fix behavior.

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

// ── Nostr event helpers ───────────────────────────────────────────────────────

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `list-${Date.now()}`
}

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

// A category published with only a d-tag and empty content is a tombstone —
// our deleteList path writes exactly that shape. Don't surface it.
function isTombstone(event) {
  if (event.kind !== 30001 && event.kind !== 30003) return false
  const tags = event.tags || []
  const onlyDTag = tags.length === 1 && tags[0]?.[0] === 'd'
  return onlyDTag && (!event.content || event.content === '')
}

function eventToList(event) {
  const kind = event.kind

  let id, title
  if (kind === 10003) {
    id    = '_bookmarks'
    title = 'Ungrouped'
  } else {
    id    = event.tags?.find(t => t[0] === 'd')?.[1] || event.id
    title = event.tags?.find(t => t[0] === 'title')?.[1] || id
  }

  // Parse content JSON. Keep only items with a valid `aTag` as articles;
  // stash everything else (e.g., the notes module's `{id, addedAt}` items)
  // verbatim so republishing preserves them for other modules.
  let articles = []
  const otherContentItems = []
  try {
    const parsed = JSON.parse(event.content || '[]')
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        if (it?.aTag && typeof it.aTag === 'string') {
          articles.push(it)
        } else if (it && typeof it === 'object') {
          otherContentItems.push(it)
        }
      }
    }
  } catch {}

  // Also parse NIP-51 `a` tags for articles not already in our JSON.
  const existingATags = new Set(articles.map(a => a.aTag))
  const extraTags = []
  for (const tag of event.tags || []) {
    if (tag[0] === 'a' && typeof tag[1] === 'string') {
      const aTag = tag[1]
      if (!aTag.includes(':') || existingATags.has(aTag)) continue
      const aKind = aTag.split(':')[0]
      // Accept long-form articles (30023) and recipes (30078) only.
      if (aKind !== '30023' && aKind !== '30078') continue
      existingATags.add(aTag)
      articles.push({
        aTag,
        title: '',
        image: '',
        author: '',
        tTags: [],
        addedAt: event.created_at ? event.created_at * 1000 : Date.now(),
      })
    } else if (tag[0] !== 'd' && tag[0] !== 'title') {
      // Preserve every other tag (e tags from the notes module, r/t tags,
      // etc.) so republishing doesn't drop them.
      extraTags.push(tag)
    }
  }

  return { id, title, articles, createdAt: event.created_at, sourceKind: kind, extraTags, otherContentItems }
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
  // 1. needsArticle: missing title OR publishedAt — fetch kind 30023 + profile
  // 2. needsProfile: has title/publishedAt but missing real author name — just fetch kind 0 profile
  const needsArticle = []
  const needsProfile = []
  const allPubkeys = new Set()

  for (const list of lists) {
    for (const item of list.articles) {
      if (!item.aTag) continue
      const pubkey = item.aTag.split(':')[1]
      if (!pubkey) continue

      if (!item.title || !item.publishedAt) {
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
      const pub = parseInt(getTag(ev, 'published_at'))
      if (!item.publishedAt) {
        item.publishedAt = !isNaN(pub) && pub ? pub : (ev.created_at || 0)
      }
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
  const [lists,     setLists]     = useState([])
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  const [loading,   setLoading]   = useState(true)
  const enrichingRef = useRef(false)
  // Mirror of `lists` so async flows (deleteList) can read the current
  // value without wrapping logic in a setState reducer.
  const listsRef = useRef([])
  useEffect(() => { listsRef.current = lists }, [lists])

  const pubkey   = user?.pubkey
  const readOnly = !!user?.readOnly

  // Hidden-list preference is purely client-side and per-pubkey.
  useEffect(() => {
    setHiddenIds(loadHiddenFromStorage(pubkey))
  }, [pubkey])

  // Load from Nostr on mount; localStorage as fallback / read-only store
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)

      if (!pubkey) {
        setLists([])
        setLoading(false)
        return
      }

      // Show cached lists immediately so the UI isn't empty while relays respond.
      const cachedInitial = loadFromStorage(pubkey)
      if (cancelled) return
      if (cachedInitial.length > 0) setLists(cachedInitial)

      try {
        const ndk    = getNDK()
        const events = await ndk.fetchEvents({
          kinds: [10003, 30001, 30003],
          authors: [pubkey],
        })
        if (cancelled) return

        const parsed = Array.from(events)
          .filter(ev => !isTombstone(ev))
          .map(eventToList)

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
              existing.sourceKind = list.sourceKind
              existing.extraTags = list.extraTags
              existing.otherContentItems = list.otherContentItems
            }
          } else {
            merged.set(list.id, list)
          }
        }

        // Keep categories with zero matching articles — they still show in
        // the sidebar as empty (user may just have notes-only items there).
        const result = Array.from(merged.values())
        result.sort((a, b) => b.createdAt - a.createdAt)

        // Merge cached metadata (author, authorPic, title, image) from localStorage
        // into fresh relay data so enriched info isn't lost on reload
        const cached = loadFromStorage(pubkey)
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
            if (!art.author      && c.author)      art.author      = c.author
            if (!art.authorPic   && c.authorPic)   art.authorPic   = c.authorPic
            if (!art.title       && c.title)       art.title       = c.title
            if (!art.image       && c.image)       art.image       = c.image
            if (!art.publishedAt && c.publishedAt) art.publishedAt = c.publishedAt
            if ((!art.tTags || art.tTags.length === 0) && c.tTags?.length) art.tTags = c.tTags
          }
        }

        setLists(result)
        // Only persist for the signed-in owner. Visitor caches (every other
        // author's lists) would grow unbounded in localStorage across a long
        // session, so keep those in-memory for the page lifetime only.
        if (!readOnly) saveToStorage(pubkey, result)

        // Background enrichment — fetch metadata for items still missing info
        if (!cancelled && !enrichingRef.current) {
          enrichingRef.current = true
          enrichBookmarkItems(result).then(didEnrich => {
            enrichingRef.current = false
            if (cancelled) return
            if (didEnrich) {
              // Force a re-render with the enriched data
              setLists([...result])
              if (!readOnly) saveToStorage(pubkey, result)
            }
          }).catch(() => { enrichingRef.current = false })
        }
      } catch {
        if (cancelled) return
        setLists(loadFromStorage(pubkey))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [pubkey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Publish a list to Nostr and update local state. Returns true iff the
  // relay publish actually succeeded. Local state is updated regardless
  // (so a transient relay error doesn't yank the user's edit from the
  // UI) — the return value is only for callers who need to gate a
  // follow-up action (e.g., deleteList won't tombstone unless primary
  // publish was durable).
  const publishList = useCallback(async (list) => {
    // Defense in depth — UI already hides these paths for visitors, but if a
    // caller ever slipped through, we must not mutate the viewed user's cache.
    if (readOnly) return false

    const updated = (prev) =>
      prev.some(l => l.id === list.id)
        ? prev.map(l => l.id === list.id ? list : l)
        : [list, ...prev]

    let published = false
    if (pubkey) {
      try {
        const ndk   = getNDK()
        const event = new NDKEvent(ndk)
        // Preserve the source kind for round-trip of existing events:
        // 10003 stays 10003, legacy 30001 stays 30001. NIP-51 deprecated
        // 30001 in favor of 30003, so *new* lists we create always go out
        // as 30003. The kind-10003 primary is a singleton (no d-tag, no
        // title tag) and is shared with the notes module.
        if (list.sourceKind === 10003) {
          // Cross-module merge — refetch the latest primary so any data
          // the notes module wrote since our load isn't silently clobbered.
          const fresh = await fetchLatestPrimary(pubkey)
          let preservedTags  = list.extraTags || []
          let preservedItems = list.otherContentItems || []
          let rawContentOverride = null
          if (fresh) {
            // Keep every tag except what longform owns (`a`/`d`/`title`).
            // `e`-tags (notes), `t`/`r`/etc stay.
            preservedTags = []
            for (const t of fresh.tags || []) {
              if (t[0] === 'a' || t[0] === 'd' || t[0] === 'title') continue
              preservedTags.push(t)
            }
            // Content: if it's a JSON array, keep every non-article item
            // (notes' `{id, addedAt}` etc). If it isn't JSON (likely
            // NIP-04 encrypted private bookmarks), preserve it verbatim
            // in `rawContentOverride` — our articles live in `a`-tags and
            // don't need the content blob.
            let parsed = null
            try {
              const p = JSON.parse(fresh.content || '[]')
              if (Array.isArray(p)) parsed = p
            } catch {}
            if (parsed) {
              preservedItems = parsed.filter(it => it && typeof it === 'object' && !it.aTag)
            } else if (fresh.content && fresh.content !== '') {
              preservedItems = []
              rawContentOverride = fresh.content
            }
          }
          event.kind = 10003
          event.tags = [...preservedTags]
          for (const art of list.articles) {
            if (art.aTag) event.tags.push(['a', art.aTag])
          }
          if (rawContentOverride) {
            event.content = rawContentOverride
          } else {
            const mergedContent = [...list.articles, ...preservedItems]
            event.content = JSON.stringify(mergedContent)
          }
        } else {
          event.kind = list.sourceKind === 30001 ? 30001 : 30003
          event.tags = [['d', list.id], ['title', list.title], ...(list.extraTags || [])]
          for (const art of list.articles) {
            if (art.aTag) event.tags.push(['a', art.aTag])
          }
          // Merge our articles with any foreign content items (e.g., the
          // notes module's `{id, addedAt}`) so they round-trip intact.
          const mergedContent = [...list.articles, ...(list.otherContentItems || [])]
          event.content = JSON.stringify(mergedContent)
        }
        await event.sign()
        await event.publish()
        published = true
      } catch {
        // Non-fatal — local state still updated
      }
    }

    setLists(prev => {
      const next = updated(prev)
      saveToStorage(pubkey, next)
      return next
    })
    return published
  }, [readOnly, pubkey])

  const createList = useCallback(async (name) => {
    if (readOnly) return null
    const list = {
      id:         makeSlug(name),
      title:      name,
      articles:   [],
      createdAt:  Math.floor(Date.now() / 1000),
      sourceKind: 30003,
    }
    await publishList(list)
    return list
  }, [readOnly, publishList])

  const addArticle = useCallback(async (listId, articleMeta) => {
    if (readOnly) return
    setLists(prev => {
      const list = prev.find(l => l.id === listId)
      if (!list) return prev
      if (list.articles.some(a => a.aTag === articleMeta.aTag)) return prev
      const updated = { ...list, articles: [...list.articles, articleMeta] }
      publishList(updated)
      return prev
    })
  }, [readOnly, publishList])

  // Bulk add — single publish for N articles. The per-call addArticle path
  // publishes immediately on each call, which races itself when a caller
  // loops it: kind 10003 is replaceable, so N rapid publishes means the
  // last-signed event (holding only its own article) clobbers the others
  // on the relay and only one article actually gets bookmarked. This
  // collapses everything into one signed event with all new articles.
  const addArticlesBulk = useCallback(async (listId, articleMetas) => {
    if (readOnly) return false
    if (!Array.isArray(articleMetas) || articleMetas.length === 0) return true
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    const existing = new Set((list.articles || []).map(a => a.aTag))
    const additions = articleMetas.filter(m => m?.aTag && !existing.has(m.aTag))
    if (additions.length === 0) return true
    const updated = { ...list, articles: [...(list.articles || []), ...additions] }
    return await publishList(updated)
  }, [readOnly, publishList])

  const removeArticle = useCallback(async (listId, aTag) => {
    if (readOnly) return
    setLists(prev => {
      const list = prev.find(l => l.id === listId)
      if (!list) return prev
      const updated = { ...list, articles: list.articles.filter(a => a.aTag !== aTag) }
      publishList(updated)
      return prev
    })
  }, [readOnly, publishList])

  // Bulk remove — single publish per list. Same rationale as addArticlesBulk:
  // looping removeArticle races on 10003 because each call publishes from a
  // stale `prev` snapshot and the last publish wins.
  const removeArticlesBulk = useCallback(async (listId, aTags) => {
    if (readOnly) return false
    if (!Array.isArray(aTags) || aTags.length === 0) return true
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    const aTagSet = new Set(aTags)
    const remaining = (list.articles || []).filter(a => !aTagSet.has(a.aTag))
    if (remaining.length === (list.articles || []).length) return true
    return await publishList({ ...list, articles: remaining })
  }, [readOnly, publishList])

  const deleteList = useCallback(async (listId) => {
    if (readOnly) return
    // Primary ("Ungrouped") is the rehome destination — deleting it would
    // have nowhere to land its items, so block it.
    if (listId === PRIMARY_LIST_ID) return

    // Read current lists via ref so the merge is computed from fresh data
    // and nothing is mutated until the durable publish lands.
    const current = listsRef.current
    const sourceList = current.find(l => l.id === listId)
    if (!sourceList) return

    const sourceKind = sourceList.sourceKind === 30003 ? 30003 : 30001
    const primary    = current.find(l => l.id === PRIMARY_LIST_ID)

    // Merge deleted list's articles + otherContentItems into primary,
    // deduping by aTag (articles) / id (notes-module items). If no
    // primary exists yet, synthesize one — first publish creates the
    // user's kind 10003 event.
    const mergedArticles = primary ? [...primary.articles] : []
    const seenATags = new Set(mergedArticles.map(a => a.aTag))
    for (const art of sourceList.articles || []) {
      if (art.aTag && !seenATags.has(art.aTag)) {
        mergedArticles.push(art)
        seenATags.add(art.aTag)
      }
    }
    const mergedOther = primary ? [...(primary.otherContentItems || [])] : []
    const seenNoteIds = new Set(mergedOther.map(it => it?.id).filter(Boolean))
    for (const it of sourceList.otherContentItems || []) {
      if (it?.id && !seenNoteIds.has(it.id)) {
        mergedOther.push(it)
        seenNoteIds.add(it.id)
      }
    }

    const newPrimary = primary
      ? { ...primary, articles: mergedArticles, otherContentItems: mergedOther }
      : {
          id: PRIMARY_LIST_ID,
          title: PRIMARY_LIST_TITLE,
          articles: mergedArticles,
          otherContentItems: mergedOther,
          extraTags: [],
          sourceKind: 10003,
          createdAt: Math.floor(Date.now() / 1000),
        }

    // ── Atomicity contract ──────────────────────────────────────────────
    // We must never end up in a state where articles are neither in the
    // source list nor in primary. Order of operations:
    //   1. Publish merged primary. If this fails, ABORT — no local state
    //      change, no tombstone. Articles stay safely in the source list.
    //   2. Only after (1) lands, remove the source list locally and
    //      publish the tombstone.
    // If the tombstone step fails, the source list will reappear on next
    // relay refetch and the user will see their articles in both places —
    // duplication, not loss. They can retry delete.
    const primaryOk = await publishList(newPrimary)
    if (!primaryOk) return

    setLists(prev => {
      const next = prev.filter(l => l.id !== listId)
      saveToStorage(pubkey, next)
      return next
    })

    if (pubkey) {
      try {
        const ndk   = getNDK()
        const event = new NDKEvent(ndk)
        // Tombstone the original kind — replaceables are per-kind, so a
        // 30001 tombstone wouldn't invalidate a 30003 original and vice versa.
        event.kind    = sourceKind
        event.tags    = [['d', listId]]
        event.content = ''
        await event.sign()
        await event.publish()
      } catch {}
    }
  }, [readOnly, pubkey, publishList])

  const renameList = useCallback(async (listId, newTitle) => {
    if (readOnly) return
    setLists(prev => {
      const list = prev.find(l => l.id === listId)
      if (!list) return prev
      const updated = { ...list, title: newTitle }
      publishList(updated)
      return prev
    })
  }, [readOnly, publishList])

  const moveArticle = useCallback(async (fromListId, toListId, aTag) => {
    if (readOnly) return
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
  }, [readOnly, publishList])

  // Bulk move from one list to another — single publish per side. Loops of
  // moveArticle hit the same replaceable-event race as addArticle (each
  // iteration publishes its own stale snapshot; the last publish wins on
  // the relay). Target is published first so a failure between publishes
  // leaves duplicates rather than dropped items — same atomicity stance as
  // deleteList.
  const moveArticlesBulk = useCallback(async (fromListId, toListId, aTags) => {
    if (readOnly) return false
    if (!Array.isArray(aTags) || aTags.length === 0) return true
    if (fromListId === toListId) return true
    const current = listsRef.current
    const from = current.find(l => l.id === fromListId)
    const to   = current.find(l => l.id === toListId)
    if (!from || !to) return false
    const aTagSet = new Set(aTags)
    const moving = (from.articles || []).filter(a => aTagSet.has(a.aTag))
    if (moving.length === 0) return true
    const existingTo = new Set((to.articles || []).map(a => a.aTag))
    const newItems = moving.filter(it => !existingTo.has(it.aTag))
    const updatedTo   = { ...to,   articles: [...(to.articles || []), ...newItems] }
    const updatedFrom = { ...from, articles: (from.articles || []).filter(a => !aTagSet.has(a.aTag)) }
    const toOk = await publishList(updatedTo)
    if (!toOk) return false
    const fromOk = await publishList(updatedFrom)
    return toOk && fromOk
  }, [readOnly, publishList])

  const reorderLists = useCallback((fromIndex, toIndex) => {
    // Visitors can't re-order someone else's lists — the cache belongs to the
    // viewed user, not the viewer.
    if (readOnly) return
    setLists(prev => {
      if (fromIndex < 0 || fromIndex >= prev.length) return prev
      if (toIndex   < 0 || toIndex   >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      saveToStorage(pubkey, next)
      return next
    })
  }, [readOnly, pubkey])

  const hideList = useCallback((listId) => {
    if (readOnly || !listId) return
    // Primary stays visible — hiding it would strand items with nowhere to
    // surface them.
    if (listId === PRIMARY_LIST_ID) return
    setHiddenIds(prev => {
      if (prev.has(listId)) return prev
      const next = new Set(prev)
      next.add(listId)
      saveHiddenToStorage(pubkey, next)
      return next
    })
  }, [readOnly, pubkey])

  const unhideList = useCallback((listId) => {
    if (readOnly || !listId) return
    setHiddenIds(prev => {
      if (!prev.has(listId)) return prev
      const next = new Set(prev)
      next.delete(listId)
      saveHiddenToStorage(pubkey, next)
      return next
    })
  }, [readOnly, pubkey])

  return {
    lists, loading,
    createList,
    addArticle, addArticlesBulk,
    removeArticle, removeArticlesBulk,
    moveArticle, moveArticlesBulk,
    deleteList, renameList, reorderLists,
    hiddenIds, hideList, unhideList,
  }
}
