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
 *
 * Private items (NIP-51):
 *   Encrypted `content` field carries a JSON-stringified tag array. For
 *   longform that means entries like ["a", "30023:pubkey:dtag"]. Per-item
 *   title/image/author metadata is NOT stored in the encrypted blob (it
 *   would be a self-encrypted leak that only adds decrypt cost); instead,
 *   enrichment re-fetches article metadata post-decrypt the same way it
 *   does for bare public `a` tags. Decryption is owner-only — visitor mode
 *   (readOnly) never decrypts anyone else's items.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'
import { withTimeout } from './utils.js'
import {
  looksEncrypted,
  encryptPrivateTagArray,
  decryptPrivateTagArray,
  decryptPrivateTagArrayDetailed,
} from './privateItems.js'
import {
  makeTombstoneStore,
  makeHiddenStore,
  fetchLatestPrimary,
  isTombstone,
  seedTombstonesFromEvents,
} from './bookmarkStorage.js'

// Per-pubkey cache so viewing multiple authors on the same machine doesn't
// leak one person's enriched bookmarks into another's display.
const STORAGE_KEY_PREFIX = 'mynostr_reading_lists:'

// The kind-10003 primary list has this synthetic id everywhere in the app.
export const PRIMARY_LIST_ID = '_bookmarks'
export const PRIMARY_LIST_TITLE = 'Ungrouped'

// ── LocalStorage helpers ──────────────────────────────────────────────────────

function storageKeyFor(pubkey) {
  return pubkey ? `${STORAGE_KEY_PREFIX}${pubkey}` : null
}

// Sanity-check a cached list entry before letting it round-trip through
// publishList. Another script on the same origin (or a buggy future
// revision) could in theory corrupt our localStorage blob; any shape
// mismatch should be dropped rather than silently flowing back into a
// publish. Matches the validation used by useNoteBookmarks.
function isValidCachedList(l) {
  if (!l || typeof l !== 'object') return false
  if (typeof l.id !== 'string' || !l.id) return false
  if (typeof l.title !== 'string') return false
  return true
}
function sanitizeCachedList(l) {
  const articles = Array.isArray(l.articles)
    ? l.articles.filter(a => a && typeof a.aTag === 'string' && a.aTag.includes(':'))
    : []
  const otherContentItems = Array.isArray(l.otherContentItems)
    ? l.otherContentItems.filter(it => it && typeof it === 'object')
    : []
  const extraTags = Array.isArray(l.extraTags)
    ? l.extraTags.filter(t => Array.isArray(t) && typeof t[0] === 'string')
    : []
  // privateDecrypted is a runtime success flag — never trust a cached
  // value. A fresh session always re-decrypts.
  return { ...l, articles, otherContentItems, extraTags, privateArticles: [], privateDecrypted: false }
}
function loadFromStorage(pubkey) {
  const key = storageKeyFor(pubkey)
  if (!key) return []
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter(isValidCachedList).map(sanitizeCachedList)
  } catch { return [] }
}

function saveToStorage(pubkey, lists) {
  const key = storageKeyFor(pubkey)
  if (!key) return
  try {
    // Decrypted private items NEVER touch disk — mirror of the notes-module
    // rule. The privateCiphertext blob is safe to persist (still encrypted,
    // requires the signer to decrypt).
    const stripped = (lists || []).map(l => {
      // privateDecrypted is a runtime success flag — strip so a stale
      // `true` doesn't survive into a session where decrypt hasn't run.
      const { privateArticles, privateDecrypted, ...rest } = l
      return rest
    })
    localStorage.setItem(key, JSON.stringify(stripped))
  } catch {}
}

// Shared helpers from bookmarkStorage.js:
//   - Tombstone store: per-pubkey `listId → created_at` map. Written when
//     deleteList's tombstone publish lands; read on load so a stale
//     fallback relay can't resurrect a deleted list.
//   - Hidden store: per-pubkey chip hide preferences split by privacy view.
//   - fetchLatestPrimary: cross-module concurrency — refetches the freshest
//     kind 10003 immediately before publishing so we don't silently clobber
//     data the notes module wrote since our load.
const { load: loadTombstones, save: saveTombstone } = makeTombstoneStore('mynostr_reading_tombstones:')
const { load: loadHiddenFromStorage, save: saveHiddenToStorage } = makeHiddenStore('mynostr_reading_hidden:')

// ── Nostr event helpers ───────────────────────────────────────────────────────

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `list-${Date.now()}`
}

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

// Build a minimal article stub from a bare aTag. Enrichment fills in
// title/image/author later. `addedAt` of 0 is a deliberate signal from
// callers that no client-side bookmark timestamp is available — the
// downstream sort falls through to `publishedAt` in that case. Coercing
// only a null/undefined input to `Date.now()` lets 0 pass through
// unmodified (the pre-fix `|| Date.now()` silently turned 0 into "now").
function stubFromATag(aTag, addedAt) {
  return {
    aTag,
    title: '',
    image: '',
    author: '',
    tTags: [],
    addedAt: addedAt != null ? addedAt : Date.now(),
  }
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
  //
  // If content is NIP-51 ciphertext (this category has private items),
  // stash the blob verbatim as privateCiphertext; publishList preserves it
  // on round-trip and an async decrypt pass decodes it for the owner.
  let articles = []
  const otherContentItems = []
  const privateCiphertext = looksEncrypted(event.content) ? event.content : ''
  if (!privateCiphertext) {
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
  }

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
      articles.push(stubFromATag(aTag, event.created_at ? event.created_at * 1000 : Date.now()))
    } else if (tag[0] !== 'd' && tag[0] !== 'title') {
      // Preserve every other tag (e tags from the notes module, r/t tags,
      // etc.) so republishing doesn't drop them.
      extraTags.push(tag)
    }
  }

  return {
    id, title,
    articles,
    privateArticles: [],
    privateCiphertext,
    createdAt: event.created_at,
    sourceKind: kind,
    extraTags,
    otherContentItems,
    // Back-compat: some older callers read `rawContent`. Now synonymous
    // with privateCiphertext — only meaningful when the blob is encrypted.
    rawContent: privateCiphertext,
  }
}

// ── Background enrichment ───────────────────────────────────────────────────
// Fetches kind 30023 events for bookmark items missing metadata, then fetches
// kind 0 profiles for the authors. Returns a Map<aTag, newItem> of enriched
// replacements (null if nothing needed enriching). The caller swaps items in
// via setLists so enrichment is immutable end-to-end — if this mutated items
// in place, a future React.memo keyed on article props wouldn't invalidate.
//
// Operates on both buckets (public articles + private articles) — private
// items need the same title/image/author pass; enrichment looks up public
// 30023 events so nothing confidential leaks in the process.

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
    const allItems = [...(list.articles || []), ...(list.privateArticles || [])]
    for (const item of allItems) {
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

  if (needsArticle.length === 0 && needsProfile.length === 0) return null

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
        const events = await withTimeout(
          ndk.fetchEvents({ kinds, authors: [pubkey], '#d': dTags }),
          10000,
        )
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
      const profileEvents = await withTimeout(
        ndk.fetchEvents({ kinds: [0], authors: Array.from(allPubkeys) }),
        10000,
      )
      for (const ev of Array.from(profileEvents)) {
        try { profileMap.set(ev.pubkey, JSON.parse(ev.content)) } catch {}
      }
    } catch {}
  }

  // Build replacement items keyed by aTag. Each is a new object — callers
  // swap by reference so React reconciliation sees a change.
  const enrichedMap = new Map()

  for (const item of needsArticle) {
    const pubkey = item.aTag.split(':')[1]
    const ev = articleMap.get(item.aTag)
    const profile = profileMap.get(pubkey)
    if (!ev && !profile) continue
    const next = { ...item }
    if (ev) {
      next.title = getTag(ev, 'title') || next.title
      next.image = getTag(ev, 'image') || next.image
      next.tTags = ev.tags?.filter(t => t[0] === 't').map(t => t[1]) || next.tTags || []
      const pub = parseInt(getTag(ev, 'published_at'))
      if (!next.publishedAt) {
        next.publishedAt = !isNaN(pub) && pub ? pub : (ev.created_at || 0)
      }
    }
    if (profile) {
      const name = profile.display_name || profile.name || ''
      if (name) next.author = name
      if (profile.picture) next.authorPic = profile.picture
    }
    enrichedMap.set(item.aTag, next)
  }

  for (const item of needsProfile) {
    const pubkey = item.aTag.split(':')[1]
    const profile = profileMap.get(pubkey)
    if (!profile) continue
    const next = { ...item }
    const name = profile.display_name || profile.name || ''
    if (name && isHexLike(next.author)) next.author = name
    if (profile.picture && !next.authorPic) next.authorPic = profile.picture
    enrichedMap.set(item.aTag, next)
  }

  return enrichedMap.size > 0 ? enrichedMap : null
}

// Decrypt a list's privateCiphertext blob into article stubs. Returns an
// empty array if decryption fails or the blob contains no `a` tags.
// Enrichment re-fetches title/image/author post-decrypt.
async function decryptPrivateArticles(ciphertext, ndk) {
  const { articles } = await decryptPrivateArticlesDetailed(ciphertext, ndk)
  return articles
}

// Variant that also returns the underlying decrypt diagnostic so the
// UI can surface what actually went wrong on failure.
async function decryptPrivateArticlesDetailed(ciphertext, ndk) {
  if (!ciphertext) return { articles: [], diagnostic: null, decryptOk: false }
  const detailed = await decryptPrivateTagArrayDetailed(ciphertext, ndk)
  // `decryptOk` distinguishes "decrypt failed" from "decrypted but the
  // blob has no `a` tags" — critical when notes and longform share a
  // category. The articles-side decrypt of a notes-only blob succeeds
  // and returns []; callers need to know that's not a failure.
  if (!Array.isArray(detailed.result)) return { articles: [], diagnostic: detailed, decryptOk: false }
  const out = []
  const seen = new Set()
  for (const t of detailed.result) {
    if (!Array.isArray(t) || t[0] !== 'a' || typeof t[1] !== 'string') continue
    const aTag = t[1]
    if (!aTag.includes(':') || seen.has(aTag)) continue
    const aKind = aTag.split(':')[0]
    if (aKind !== '30023' && aKind !== '30078') continue
    seen.add(aTag)
    out.push(stubFromATag(aTag, 0))
  }
  return { articles: out, diagnostic: detailed, decryptOk: true }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

// Retry pacing for the private-decrypt pass (parallel to useNoteBookmarks).
// Catches the cold-start signer race AND gives the user time to grant a
// per-call permission popup without leaving the list permanently empty.
const PRIVATE_DECRYPT_RETRY_DELAYS_MS = [1000, 3000]

export function useReadingLists(user) {
  const [lists,           setLists]           = useState([])
  const [hiddenIdsByView, setHiddenIdsByView] = useState(() => ({
    public: new Set(),
    private: new Set(),
  }))
  const [loading,   setLoading]   = useState(true)
  // Count of lists whose privateCiphertext we couldn't decrypt after all
  // retries. Surfaced to the UI so the Articles bookmark surface can show
  // a "your signer may need permission" banner instead of silently
  // rendering "Private (0)" when the user definitely has private items.
  const [privateDecryptFailed, setPrivateDecryptFailed] = useState(0)
  // True while runDecryptPass is mid-flight. The UI uses this to render a
  // "Decrypting…" state on the Private tab during the retry window
  // instead of an empty list that misleads the user.
  const [privateDecryptInProgress, setPrivateDecryptInProgress] = useState(false)
  // Re-entrancy guard for cold-load + user-triggered retry running
  // simultaneously. Ref so the check is synchronous before kicking off.
  const decryptInFlightRef = useRef(false)
  // Last decrypt failure diagnostic — surfaced to the UI for mobile
  // triage where the user can't open devtools.
  const [decryptDiagnostic, setDecryptDiagnostic] = useState(null)
  const enrichingRef = useRef(false)
  // Mirror of `lists` so async flows (deleteList) can read the current
  // value without wrapping logic in a setState reducer.
  const listsRef = useRef([])
  useEffect(() => { listsRef.current = lists }, [lists])

  const pubkey   = user?.pubkey
  const readOnly = !!user?.readOnly

  // Hidden-list preference is purely client-side and per-pubkey, split by view.
  useEffect(() => {
    if (!pubkey) {
      setHiddenIdsByView({ public: new Set(), private: new Set() })
      return
    }
    const stored = loadHiddenFromStorage(pubkey)
    setHiddenIdsByView({
      public:  new Set(stored.public),
      private: new Set(stored.private),
    })
  }, [pubkey])

  // Sequential decrypt sweep with backoff retries (1s, 3s). Exposed as
  // `retryDecrypt` so the UI can offer a "Tap to retry" button. Re-entrant
  // guard prevents the cold-load and a user tap from running concurrently.
  const runDecryptPass = useCallback(async () => {
    if (!pubkey || readOnly) return
    if (decryptInFlightRef.current) return
    decryptInFlightRef.current = true
    setPrivateDecryptInProgress(true)
    try {
      const ndk = getNDK()
      // Rebuild the cached-metadata map fresh — cheap, and avoids
      // stitching this callback's lifetime to whatever cachedItemMap
      // happened to be in scope when the loading effect first ran.
      const cached = loadFromStorage(pubkey)
      const cachedItemMap = new Map()
      for (const list of cached) {
        for (const art of (list.articles || [])) {
          if (art.aTag) cachedItemMap.set(art.aTag, art)
        }
      }
      function pendingPass() {
        const live = listsRef.current
        return live.filter(l => l.privateCiphertext && !l.privateDecrypted)
      }
      let pending = pendingPass()
      if (pending.length === 0) {
        setPrivateDecryptFailed(0)
        setDecryptDiagnostic(null)
        return
      }
      let lastDiagnostic = null
      for (let attempt = 0; ; attempt++) {
        const failures = []
        for (const list of pending) {
          if (!ndk.signer) { failures.push(list); continue }
          const { articles: privateArticles, diagnostic, decryptOk } = await decryptPrivateArticlesDetailed(list.privateCiphertext, ndk)
          if (!decryptOk) {
            if (diagnostic) lastDiagnostic = diagnostic
            failures.push(list)
            continue
          }
          for (const art of privateArticles) {
            const c = cachedItemMap.get(art.aTag)
            if (!c) continue
            if (!art.title       && c.title)       art.title       = c.title
            if (!art.image       && c.image)       art.image       = c.image
            if (!art.author      && c.author)      art.author      = c.author
            if (!art.authorPic   && c.authorPic)   art.authorPic   = c.authorPic
            if (!art.publishedAt && c.publishedAt) art.publishedAt = c.publishedAt
            if ((!art.tTags || art.tTags.length === 0) && c.tTags?.length) art.tTags = c.tTags
          }
          setLists(prev => prev.map(l =>
            l.id === list.id ? { ...l, privateArticles, privateDecrypted: true } : l
          ))
        }
        if (failures.length === 0) {
          setPrivateDecryptFailed(0)
          setDecryptDiagnostic(null)
          return
        }
        const nextDelay = PRIVATE_DECRYPT_RETRY_DELAYS_MS[attempt]
        if (nextDelay == null) {
          setPrivateDecryptFailed(failures.length)
          if (lastDiagnostic) setDecryptDiagnostic(lastDiagnostic)
          return
        }
        await new Promise(r => setTimeout(r, nextDelay))
        pending = pendingPass()
      }
    } finally {
      decryptInFlightRef.current = false
      setPrivateDecryptInProgress(false)
    }
  }, [pubkey, readOnly])

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

        // Tombstone filter: drop any fetched event whose created_at is at or
        // below a locally-recorded tombstone for that list id. Prevents a
        // stale fallback relay from resurrecting a list we already deleted.
        const tombstones = loadTombstones(pubkey)
        // Also seed the local log from tombstones we just fetched — a delete
        // set on another device arrives here as a regular replaceable event,
        // and without seeding, the isTombstone filter drops it and any stale
        // cached copy resurrects the entry on the next cache-merge pass.
        const eventsArr = Array.from(events)
        seedTombstonesFromEvents(eventsArr, tombstones, pubkey, saveTombstone)
        const tombstoneFor = (ev) => {
          if (ev.kind === 10003) return tombstones[PRIMARY_LIST_ID] || 0
          const dTag = ev.tags?.find(t => t[0] === 'd')?.[1]
          return dTag ? (tombstones[dTag] || 0) : 0
        }

        const parsed = eventsArr
          .filter(ev => !isTombstone(ev))
          .filter(ev => (ev.created_at || 0) > tombstoneFor(ev))
          .map(eventToList)

        // Dedupe by list id, keeping the newest version wholesale. Replaceable
        // events (10003/30001/30003) identify by (kind, author, d-tag) — if
        // multiple relays return the same logical list we must pick ONE copy,
        // not union their items. Unioning re-adds articles the user just
        // removed whenever a fallback relay still has the pre-delete event.
        const merged = new Map()
        for (const list of parsed) {
          const existing = merged.get(list.id)
          if (!existing || list.createdAt > existing.createdAt) {
            merged.set(list.id, list)
          }
        }

        // Cache-aware merge: for any list the cache has with a newer
        // createdAt than what we just pulled, trust the cache. This is what
        // prevents a publish-succeeded-to-one-relay delete/rename/edit from
        // being clobbered on reload by fallback relays that still return
        // the pre-publish event. publishList stamps the cached entry with
        // the real event created_at, so stale fetches can't outrank it.
        // A genuinely-newer write from another client still wins by virtue
        // of having an even higher createdAt.
        for (const c of cachedInitial) {
          if (!c?.id) continue
          const tombAt = tombstones[c.id] || 0
          if (tombAt && (Number(c.createdAt) || 0) <= tombAt) continue
          const existing = merged.get(c.id)
          const cachedAt = Number(c.createdAt) || 0
          if (!existing || cachedAt > (existing.createdAt || 0)) merged.set(c.id, c)
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

        // Kick off the async decrypt sweep — see runDecryptPass above
        // for the full pattern, retry budget, and rationale. Don't
        // await: lists are usable right now, decrypts stream in.
        if (!readOnly) runDecryptPass()

        // Background enrichment — fetch metadata for items still missing info
        if (!cancelled && !enrichingRef.current) {
          enrichingRef.current = true
          // Use the latest state (which may include just-decrypted private
          // articles) so enrichment covers them too.
          const enrichTarget = listsRef.current.length > 0 ? listsRef.current : result
          enrichBookmarkItems(enrichTarget).then(enrichedMap => {
            enrichingRef.current = false
            if (cancelled || !enrichedMap) return
            // Merge the returned Map<aTag, newItem> into the latest lists
            // via setLists updater. New items only replace existing ones
            // where the aTag matches, and each affected list gets a fresh
            // object reference so React reconciliation invalidates memoed
            // descendants. Using the updater (not listsRef.current) avoids
            // clobbering any writes the user made while enrichment ran.
            setLists(prev => {
              let touched = false
              const next = prev.map(list => {
                const prevArts = list.articles || []
                const prevPriv = list.privateArticles || []
                const articles = prevArts.map(a => enrichedMap.get(a.aTag) || a)
                const privateArticles = prevPriv.map(a => enrichedMap.get(a.aTag) || a)
                const changed = articles.some((a, i) => a !== prevArts[i])
                             || privateArticles.some((a, i) => a !== prevPriv[i])
                if (!changed) return list
                touched = true
                return { ...list, articles, privateArticles }
              })
              if (!touched) return prev
              if (!readOnly) saveToStorage(pubkey, next)
              return next
            })
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

  // Publish a list to Nostr and — on success — commit the matching local
  // state. Returns true iff the relay publish actually succeeded.
  //
  // Publish-before-commit: state is updated ONLY when the relay
  // acknowledges the event. On failure, local state is untouched so the
  // UI stays truthful rather than showing a change that didn't land (this
  // matters a lot with remote signers like NIP-46 bunkers, where signing
  // can time out 30s later and the user may have missed the phone prompt).
  // Callers read the boolean to drive saving / done / error feedback.
  //
  // Two content strategies coexist (parallel to useNoteBookmarks):
  //
  //   A) No private items anywhere — content is our JSON-extended format.
  //      Shared categories merge both shapes (aTag items + notes' {id,addedAt}).
  //
  //   B) Any private items — content becomes the NIP-51 encrypted tag array.
  //      Cross-module merge: decrypt existing ciphertext, filter out `a`-tags
  //      (longform owns those), keep `e`-tags (notes' private items), and
  //      re-encrypt the union. If decrypt fails and we have new private
  //      items to save, bail rather than corrupt the blob.
  const publishList = useCallback(async (list) => {
    // Defense in depth — UI already hides these paths for visitors, but if a
    // caller ever slipped through, we must not mutate the viewed user's cache.
    if (readOnly) return false

    const logFailure = (where, err) => {
      if (!import.meta.env.DEV) return
      try {
        // eslint-disable-next-line no-console
        console.error(`[reading-lists] ${where} failed for list "${list.title}" (${list.id}):`, err)
      } catch {}
    }

    let published = false
    let publishedAt = 0
    if (pubkey) {
      try {
        const ndk   = getNDK()
        const event = new NDKEvent(ndk)

        const publicArticles = list.articles || []
        const privateArticles = list.privateArticles || []
        const hasPrivateItems = privateArticles.length > 0

        // Build the encrypted content blob from our current private items
        // plus any foreign (non-`a`) tags preserved from an existing blob.
        async function buildEncryptedContent(sourceCiphertext) {
          let foreignTags = []
          if (sourceCiphertext && looksEncrypted(sourceCiphertext)) {
            const existing = await decryptPrivateTagArray(sourceCiphertext, ndk)
            if (Array.isArray(existing)) {
              foreignTags = existing.filter(t => Array.isArray(t) && t[0] !== 'a')
            }
          }
          const ourTags = privateArticles.map(a => ['a', a.aTag])
          const merged = [...ourTags, ...foreignTags]
          if (merged.length === 0) return ''
          return await encryptPrivateTagArray(merged, ndk)
        }

        // Preserve the source kind for round-trip of existing events:
        // 10003 stays 10003, legacy 30001 stays 30001. New lists default
        // to 30003 (current NIP-51 convention). The kind-10003 primary is
        // a singleton (no d-tag, no title tag) and is shared with the
        // notes module.
        if (list.sourceKind === 10003) {
          // Cross-module merge — refetch the latest primary so any data
          // the notes module wrote since our load isn't silently clobbered.
          const fresh = await fetchLatestPrimary(pubkey)
          let preservedTags  = list.extraTags || []
          let preservedItems = list.otherContentItems || []
          let contentOverride = ''
          const freshContent  = fresh ? (fresh.content || '') : ''
          const freshEncrypted = looksEncrypted(freshContent)
          if (fresh) {
            // Keep every tag except what longform owns (`a`/`d`/`title`).
            // `e`-tags (notes), `t`/`r`/etc stay. Strip any foreign
            // `client` tag too — we re-add ours below so cross-client
            // edits don't accumulate multiple client tags.
            preservedTags = []
            for (const t of fresh.tags || []) {
              if (t[0] === 'a' || t[0] === 'd' || t[0] === 'title' || t[0] === 'client') continue
              preservedTags.push(t)
            }
          }

          if (hasPrivateItems) {
            // We have new private items — re-encrypt the merged blob (our
            // items plus any foreign tags the other module owns).
            try {
              contentOverride = await buildEncryptedContent(freshEncrypted ? freshContent : list.privateCiphertext || '')
            } catch (err) {
              logFailure('encrypt (primary)', err)
              return false
            }
          } else if (freshEncrypted) {
            // No new private items and the blob is encrypted. Do NOT decrypt-
            // and-re-encrypt — if our async decrypt hasn't finished yet,
            // privateArticles is empty and re-encrypting would filter out our
            // own `a`-tags, silently wiping them from the blob. Preserve it
            // verbatim; we're only touching public items in this publish.
            contentOverride = freshContent
          } else if (fresh) {
            // Pure-public path — merge our articles with notes-module items.
            let parsed = null
            try {
              const p = JSON.parse(freshContent || '[]')
              if (Array.isArray(p)) parsed = p
            } catch {}
            if (parsed) {
              preservedItems = parsed.filter(it => it && typeof it === 'object' && !it.aTag)
            } else if (freshContent !== '') {
              // Non-JSON, non-encrypted — preserve verbatim.
              contentOverride = freshContent
              preservedItems = []
            }
            if (!contentOverride) {
              const mergedContent = [...publicArticles, ...preservedItems]
              contentOverride = JSON.stringify(mergedContent)
            }
          } else {
            // No fresh fetch — fall back to cached items.
            const mergedContent = [...publicArticles, ...preservedItems]
            contentOverride = JSON.stringify(mergedContent)
          }

          event.kind = 10003
          event.tags = [...preservedTags]
          for (const art of publicArticles) {
            if (art.aTag) event.tags.push(['a', art.aTag])
          }
          event.tags.push(['client', 'mynostr'])
          event.content = contentOverride
        } else {
          // Strip any inherited `client` from extraTags before re-adding
          // ours below.
          const customExtras = (list.extraTags || []).filter(t => t[0] !== 'client')
          event.kind = list.sourceKind === 30001 ? 30001 : 30003
          event.tags = [['d', list.id], ['title', list.title], ...customExtras]
          for (const art of publicArticles) {
            if (art.aTag) event.tags.push(['a', art.aTag])
          }
          event.tags.push(['client', 'mynostr'])

          const hadCiphertext = !!list.privateCiphertext
          if (hasPrivateItems) {
            try {
              event.content = await buildEncryptedContent(list.privateCiphertext || '')
            } catch (err) {
              logFailure('encrypt (list)', err)
              return false
            }
          } else if (hadCiphertext) {
            // Preserve blob verbatim (see primary branch).
            event.content = list.privateCiphertext
          } else {
            // Merge our articles with any foreign content items (e.g., notes'
            // `{id, addedAt}`) so they round-trip intact.
            const mergedContent = [...publicArticles, ...(list.otherContentItems || [])]
            event.content = JSON.stringify(mergedContent)
          }
        }

        await signWithTimeout(event)
        // Reading lists are replaceable (kind 10003/30001/30003) and users
        // keep curating them. Publish only to their NIP-65 write relays so
        // every copy lives where future edits and deletes will land — a copy
        // on a fallback outside their write set would keep the pre-edit state
        // visible to other clients after we move on. 15s hard timeout so a
        // relay black-hole surfaces as a clean failure instead of an
        // indefinite spinner.
        const publishedTo = await withTimeout(
          publishToOwnOutbox(event),
          15000,
          'publish timeout (15s)',
        )
        const reached = Array.from(publishedTo || []).map(r => r.url).filter(Boolean)
        if (reached.length === 0) {
          logFailure('publish', new Error('no relays acknowledged the event'))
        } else {
          published = true
          publishedAt = Number(event.created_at) || Math.floor(Date.now() / 1000)
        }
      } catch (err) {
        logFailure('sign/publish', err)
      }
    }

    if (published) {
      // Stamp the cached list with the event's real created_at so the
      // load-path merge can tell a freshly-published commit apart from a
      // stale fallback-relay echo of the pre-publish event on reload.
      const stamped = publishedAt > 0 ? { ...list, createdAt: publishedAt } : list
      setLists(prev => {
        const next = prev.some(l => l.id === stamped.id)
          ? prev.map(l => l.id === stamped.id ? stamped : l)
          : [stamped, ...prev]
        saveToStorage(pubkey, next)
        return next
      })
    }
    return published
  }, [readOnly, pubkey])

  const createList = useCallback(async (name) => {
    if (readOnly) return null
    const list = {
      id:         makeSlug(name),
      title:      name,
      articles:   [],
      privateArticles: [],
      createdAt:  Math.floor(Date.now() / 1000),
      sourceKind: 30003,
    }
    await publishList(list)
    return list
  }, [readOnly, publishList])

  // Add an article to a list. Optional privacy: 'public' (default) | 'private'.
  // Mutually exclusive with the other bucket in the same list — if the
  // article was already in the opposite bucket, it moves rather than
  // duplicating. Returns true iff the publish succeeded (or the article
  // was already present, which is treated as a no-op success).
  const addArticle = useCallback(async (listId, articleMeta, options = {}) => {
    if (readOnly) return false
    if (!articleMeta?.aTag) return false
    const privacy = options.privacy === 'private' ? 'private' : 'public'
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false

    const publicHas  = (list.articles        || []).some(a => a.aTag === articleMeta.aTag)
    const privateHas = (list.privateArticles || []).some(a => a.aTag === articleMeta.aTag)
    if (privacy === 'public' && publicHas && !privateHas) return true
    if (privacy === 'private' && privateHas && !publicHas) return true

    const targetBucket = privacy === 'public' ? 'articles' : 'privateArticles'
    const otherBucket  = privacy === 'public' ? 'privateArticles' : 'articles'

    const newItem = { ...articleMeta, addedAt: articleMeta.addedAt || Date.now() }
    const newTarget = [
      newItem,
      ...(list[targetBucket] || []).filter(a => a.aTag !== articleMeta.aTag),
    ]
    const newOther = (list[otherBucket] || []).filter(a => a.aTag !== articleMeta.aTag)
    const newList = {
      ...list,
      [targetBucket]: newTarget,
      [otherBucket]:  newOther,
    }
    return await publishList(newList)
  }, [readOnly, publishList])

  // Bulk add — single publish for N articles. The per-call addArticle path
  // publishes immediately on each call, which races itself when a caller
  // loops it: kind 10003 is replaceable, so N rapid publishes means the
  // last-signed event (holding only its own article) clobbers the others
  // on the relay and only one article actually gets bookmarked. This
  // collapses everything into one signed event with all new articles.
  const addArticlesBulk = useCallback(async (listId, articleMetas, options = {}) => {
    if (readOnly) return false
    if (!Array.isArray(articleMetas) || articleMetas.length === 0) return true
    const privacy = options.privacy === 'private' ? 'private' : 'public'
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    const targetBucket = privacy === 'public' ? 'articles' : 'privateArticles'
    const otherBucket  = privacy === 'public' ? 'privateArticles' : 'articles'
    const existing = new Set((list[targetBucket] || []).map(a => a.aTag))
    const additions = articleMetas.filter(m => m?.aTag && !existing.has(m.aTag))
    const aTagsInAdd = new Set(articleMetas.map(m => m?.aTag).filter(Boolean))
    const demoting = (list[otherBucket] || []).some(a => aTagsInAdd.has(a.aTag))
    if (additions.length === 0 && !demoting) return true
    const newTarget = [
      ...additions.map(m => ({ ...m, addedAt: m.addedAt || Date.now() })),
      ...(list[targetBucket] || []).filter(a => !aTagsInAdd.has(a.aTag)),
    ]
    const newOther  = (list[otherBucket] || []).filter(a => !aTagsInAdd.has(a.aTag))
    const updated = {
      ...list,
      [targetBucket]: newTarget,
      [otherBucket]:  newOther,
    }
    return await publishList(updated)
  }, [readOnly, publishList])

  const removeArticle = useCallback(async (listId, aTag, options = {}) => {
    if (readOnly) return false
    // When privacy is omitted, remove from whichever bucket holds it.
    const explicit = options.privacy === 'private' || options.privacy === 'public'
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    const newList = {
      ...list,
      articles:        (!explicit || options.privacy === 'public')
        ? (list.articles || []).filter(a => a.aTag !== aTag)
        : (list.articles || []),
      privateArticles: (!explicit || options.privacy === 'private')
        ? (list.privateArticles || []).filter(a => a.aTag !== aTag)
        : (list.privateArticles || []),
    }
    const changed = (newList.articles.length !== (list.articles || []).length)
      || (newList.privateArticles.length !== (list.privateArticles || []).length)
    if (!changed) return true
    return await publishList(newList)
  }, [readOnly, publishList])

  // Bulk remove — single publish per list.
  const removeArticlesBulk = useCallback(async (listId, aTags, options = {}) => {
    if (readOnly) return false
    if (!Array.isArray(aTags) || aTags.length === 0) return true
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    const explicit = options.privacy === 'private' || options.privacy === 'public'
    const aTagSet = new Set(aTags)
    const newArticles = (!explicit || options.privacy === 'public')
      ? (list.articles || []).filter(a => !aTagSet.has(a.aTag))
      : (list.articles || [])
    const newPrivate = (!explicit || options.privacy === 'private')
      ? (list.privateArticles || []).filter(a => !aTagSet.has(a.aTag))
      : (list.privateArticles || [])
    if (newArticles.length === (list.articles || []).length
        && newPrivate.length === (list.privateArticles || []).length) {
      return true
    }
    const updated = { ...list, articles: newArticles, privateArticles: newPrivate }
    return await publishList(updated)
  }, [readOnly, publishList])

  const deleteList = useCallback(async (listId) => {
    if (readOnly) return false
    // Primary ("Ungrouped") is the rehome destination — deleting it would
    // have nowhere to land its items, so block it.
    if (listId === PRIMARY_LIST_ID) return false

    // Read current lists via ref so the merge is computed from fresh data
    // and nothing is mutated until the durable publish lands.
    const current = listsRef.current
    const sourceList = current.find(l => l.id === listId)
    if (!sourceList) return false

    const sourceKind = sourceList.sourceKind === 30003 ? 30003 : 30001
    const primary    = current.find(l => l.id === PRIMARY_LIST_ID)

    // Merge deleted list's articles + privateArticles + otherContentItems
    // into primary, deduping by aTag (articles) / id (notes-module items).
    // If no primary exists yet, synthesize one — first publish creates the
    // user's kind 10003 event.
    const publicToRehome  = sourceList.articles || []
    const privateToRehome = sourceList.privateArticles || []
    const mergedArticles = primary ? [...primary.articles] : []
    const mergedPrivate  = primary ? [...(primary.privateArticles || [])] : []
    const seenPubATags  = new Set(mergedArticles.map(a => a.aTag))
    const seenPrivATags = new Set(mergedPrivate.map(a => a.aTag))
    for (const art of publicToRehome) {
      if (art.aTag && !seenPubATags.has(art.aTag)) {
        mergedArticles.push(art)
        seenPubATags.add(art.aTag)
      }
    }
    for (const art of privateToRehome) {
      if (art.aTag && !seenPrivATags.has(art.aTag)) {
        mergedPrivate.push(art)
        seenPrivATags.add(art.aTag)
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
      ? { ...primary, articles: mergedArticles, privateArticles: mergedPrivate, otherContentItems: mergedOther }
      : {
          id: PRIMARY_LIST_ID,
          title: PRIMARY_LIST_TITLE,
          articles: mergedArticles,
          privateArticles: mergedPrivate,
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
    //   2. Publish the tombstone. Only after it lands on ≥1 relay do we
    //      remove the source list from local state.
    // If the tombstone step fails, the source list stays in local state so
    // the user can retry — better than a UI that lies about persistence.
    const primaryOk = await publishList(newPrimary)
    if (!primaryOk) return false

    let tombstoneAt = 0
    try {
      const ndk   = getNDK()
      const event = new NDKEvent(ndk)
      // Tombstone the original kind — replaceables are per-kind, so a
      // 30001 tombstone wouldn't invalidate a 30003 original and vice versa.
      event.kind    = sourceKind
      event.tags    = [['d', listId], ['client', 'mynostr']]
      event.content = ''
      await signWithTimeout(event)
      // Same outbox-only reasoning as publishList — tombstones must reach
      // the same relay set that holds every copy of the list.
      const publishedTo = await publishToOwnOutbox(event)
      const landed = Array.from(publishedTo || []).length > 0
      if (!landed) return false
      tombstoneAt = Number(event.created_at) || Math.floor(Date.now() / 1000)
    } catch {
      return false
    }

    // Record the tombstone locally so a stale fetch from a lagging fallback
    // relay can't resurrect this list on the next reload — the load-path
    // filter drops any fetched event for this id with created_at <= tombstoneAt.
    saveTombstone(pubkey, listId, tombstoneAt)

    setLists(prev => {
      const next = prev.filter(l => l.id !== listId)
      saveToStorage(pubkey, next)
      return next
    })

    return true
  }, [readOnly, pubkey, publishList])

  const renameList = useCallback(async (listId, newTitle) => {
    if (readOnly) return false
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    if (list.title === newTitle) return true
    const newList = { ...list, title: newTitle }
    return await publishList(newList)
  }, [readOnly, publishList])

  // Move a single article across lists. Target is published first so a
  // failure between publishes leaves duplicates rather than dropped items
  // (same atomicity stance as deleteList).
  const moveArticle = useCallback(async (fromListId, toListId, aTag, options = {}) => {
    if (readOnly) return false
    const privacy = options.privacy === 'private' ? 'private' : 'public'
    const from = listsRef.current.find(l => l.id === fromListId)
    const to   = listsRef.current.find(l => l.id === toListId)
    if (!from || !to) return false

    const sourceBucket = (from.articles || []).some(a => a.aTag === aTag) ? 'articles' : 'privateArticles'
    const item = (from[sourceBucket] || []).find(a => a.aTag === aTag)
    if (!item) return false

    const targetBucket = privacy === 'public' ? 'articles' : 'privateArticles'
    const otherBucket  = privacy === 'public' ? 'privateArticles' : 'articles'

    const newFrom = {
      ...from,
      articles:        (from.articles        || []).filter(a => a.aTag !== aTag),
      privateArticles: (from.privateArticles || []).filter(a => a.aTag !== aTag),
    }
    const targetHas = (to[targetBucket] || []).some(a => a.aTag === aTag)
    const newTo = {
      ...to,
      [targetBucket]: targetHas
        ? (to[targetBucket] || [])
        : [{ ...item, addedAt: item.addedAt || Date.now() }, ...(to[targetBucket] || [])],
      [otherBucket]:  (to[otherBucket] || []).filter(a => a.aTag !== aTag),
    }

    const toOk = await publishList(newTo)
    if (!toOk) return false
    const fromOk = await publishList(newFrom)
    return fromOk
  }, [readOnly, publishList])

  // Bulk move from one list to another — single publish per side. Target is
  // published first so a failure between publishes leaves duplicates rather
  // than dropped items — same atomicity stance as deleteList.
  const moveArticlesBulk = useCallback(async (fromListId, toListId, aTags, options = {}) => {
    if (readOnly) return false
    if (!Array.isArray(aTags) || aTags.length === 0) return true
    if (fromListId === toListId) {
      // Same-list move — this is a privacy flip, not a cross-list move.
      return await bulkMovePrivacyRef.current?.(fromListId, aTags, options.privacy) || false
    }
    const privacy = options.privacy === 'private' ? 'private' : 'public'
    const current = listsRef.current
    const from = current.find(l => l.id === fromListId)
    const to   = current.find(l => l.id === toListId)
    if (!from || !to) return false
    const aTagSet = new Set(aTags)
    const fromItems = [
      ...(from.articles || []).filter(a => aTagSet.has(a.aTag)),
      ...(from.privateArticles || []).filter(a => aTagSet.has(a.aTag)),
    ]
    if (fromItems.length === 0) return true

    const targetBucket = privacy === 'public' ? 'articles' : 'privateArticles'
    const otherBucket  = privacy === 'public' ? 'privateArticles' : 'articles'
    const existingTo = new Set((to[targetBucket] || []).map(a => a.aTag))
    const newToTarget = [
      ...fromItems
        .filter(it => !existingTo.has(it.aTag))
        .map(it => ({ ...it, addedAt: it.addedAt || Date.now() })),
      ...(to[targetBucket] || []),
    ]
    const newToOther = (to[otherBucket] || []).filter(a => !aTagSet.has(a.aTag))
    const updatedTo = {
      ...to,
      [targetBucket]: newToTarget,
      [otherBucket]:  newToOther,
    }
    const updatedFrom = {
      ...from,
      articles:        (from.articles        || []).filter(a => !aTagSet.has(a.aTag)),
      privateArticles: (from.privateArticles || []).filter(a => !aTagSet.has(a.aTag)),
    }
    const toOk = await publishList(updatedTo)
    if (!toOk) return false
    const fromOk = await publishList(updatedFrom)
    return fromOk
  }, [readOnly, publishList])

  // Flip privacy for one article within a single list. One publish.
  const movePrivacy = useCallback(async (listId, aTag, newPrivacy) => {
    if (readOnly || !aTag) return false
    const target = newPrivacy === 'private' ? 'private' : 'public'
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    const pubList  = list.articles || []
    const privList = list.privateArticles || []
    const publicHas  = pubList.some(a => a.aTag === aTag)
    const privateHas = privList.some(a => a.aTag === aTag)
    let newList
    if (target === 'private') {
      if (privateHas || !publicHas) return true
      const item = pubList.find(a => a.aTag === aTag)
      newList = {
        ...list,
        articles:        pubList.filter(a => a.aTag !== aTag),
        privateArticles: [item, ...privList],
      }
    } else {
      if (publicHas || !privateHas) return true
      const item = privList.find(a => a.aTag === aTag)
      newList = {
        ...list,
        articles:        [item, ...pubList],
        privateArticles: privList.filter(a => a.aTag !== aTag),
      }
    }
    return await publishList(newList)
  }, [readOnly, publishList])

  // Bulk flip privacy within a single list. One publish.
  const bulkMovePrivacy = useCallback(async (listId, aTags, newPrivacy) => {
    if (readOnly || !Array.isArray(aTags) || aTags.length === 0) return false
    const target = newPrivacy === 'private' ? 'private' : 'public'
    const aTagSet = new Set(aTags)
    const list = listsRef.current.find(l => l.id === listId)
    if (!list) return false
    const pubList  = list.articles || []
    const privList = list.privateArticles || []
    let newList
    if (target === 'private') {
      const moving = pubList.filter(a => aTagSet.has(a.aTag))
      if (moving.length === 0) return true
      newList = {
        ...list,
        articles:        pubList.filter(a => !aTagSet.has(a.aTag)),
        privateArticles: [...moving, ...privList],
      }
    } else {
      const moving = privList.filter(a => aTagSet.has(a.aTag))
      if (moving.length === 0) return true
      newList = {
        ...list,
        articles:        [...moving, ...pubList],
        privateArticles: privList.filter(a => !aTagSet.has(a.aTag)),
      }
    }
    return await publishList(newList)
  }, [readOnly, publishList])

  // moveArticlesBulk needs to reference bulkMovePrivacy for the same-list
  // short-circuit, but bulkMovePrivacy is defined after. A ref bridges the
  // forward reference without re-ordering useCallback hooks.
  const bulkMovePrivacyRef = useRef(null)
  useEffect(() => { bulkMovePrivacyRef.current = bulkMovePrivacy }, [bulkMovePrivacy])

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

  const hideList = useCallback((listId, view = 'public') => {
    if (readOnly || !listId) return
    // Primary stays visible — hiding it would strand items with nowhere to
    // surface them.
    if (listId === PRIMARY_LIST_ID) return
    const bucket = view === 'private' ? 'private' : 'public'
    setHiddenIdsByView(prev => {
      const current = prev[bucket]
      if (current.has(listId)) return prev
      const nextBucket = new Set(current)
      nextBucket.add(listId)
      const next = { ...prev, [bucket]: nextBucket }
      saveHiddenToStorage(pubkey, { public: next.public, private: next.private })
      return next
    })
  }, [readOnly, pubkey])

  const unhideList = useCallback((listId, view = 'public') => {
    if (readOnly || !listId) return
    const bucket = view === 'private' ? 'private' : 'public'
    setHiddenIdsByView(prev => {
      const current = prev[bucket]
      if (!current.has(listId)) return prev
      const nextBucket = new Set(current)
      nextBucket.delete(listId)
      const next = { ...prev, [bucket]: nextBucket }
      saveHiddenToStorage(pubkey, { public: next.public, private: next.private })
      return next
    })
  }, [readOnly, pubkey])

  return {
    lists, loading, privateDecryptFailed, privateDecryptInProgress, decryptDiagnostic,
    retryDecrypt: runDecryptPass,
    createList,
    addArticle, addArticlesBulk,
    removeArticle, removeArticlesBulk,
    moveArticle, moveArticlesBulk,
    movePrivacy, bulkMovePrivacy,
    deleteList, renameList, reorderLists,
    hiddenIdsByView, hideList, unhideList,
  }
}
