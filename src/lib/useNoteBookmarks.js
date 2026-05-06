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
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'
import { withTimeout } from './utils.js'
import {
  looksEncrypted,
  encryptPrivateTagArray,
  decryptPrivateTagArray,
  noteItemsToTagArray,
  tagArrayToNoteItems,
} from './privateItems.js'
import {
  makeTombstoneStore,
  makeHiddenStore,
  fetchLatestPrimary,
  isTombstone,
  seedTombstonesFromEvents,
} from './bookmarkStorage.js'

// Shared helpers from bookmarkStorage.js — see that file for details.
// The tombstone/hidden stores live behind hook-specific localStorage
// prefixes so the notes and longform modules keep their own namespaces.
const { load: loadTombstones, save: saveTombstone } = makeTombstoneStore('mynostr_note_bookmark_tombstones:')
const { load: loadHiddenFromStorage, save: saveHiddenToStorage } = makeHiddenStore('mynostr_note_hidden_bookmarks:')

const STORAGE_KEY_PREFIX = 'mynostr_note_bookmarks:'
const PRIMARY_CATEGORY_ID = '_primary'

// Defense-in-depth cap on relay-sourced bookmark content before JSON.parse.
// Our own bookmark blobs are well under 100 KB even for heavy users; a
// multi-MB string on kind 10003/30001/30003 from a malicious relay in the
// user's pool could burn memory and stall the hook. 2 MB is ~20× the
// realistic ceiling — anything larger is treated as empty.
const MAX_CONTENT_BYTES = 2_000_000
function safeParseContentArray(content) {
  if (typeof content !== 'string' || !content) return null
  if (content.length > MAX_CONTENT_BYTES) return null
  try {
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function storageKeyFor(pubkey) {
  return pubkey ? `${STORAGE_KEY_PREFIX}${pubkey}` : null
}
// Validate a cached category entry before letting it flow back into
// publish paths. Any other script with access to the same origin could
// in theory write our localStorage keys, and a cache written by a buggy
// future revision could round-trip through publishCategory and corrupt
// the user's data. Drop anything that doesn't look like the shape we
// wrote — items without a valid id, or items whose id isn't a hex event
// id — rather than trust the blob on disk.
function isValidCachedCategory(c) {
  if (!c || typeof c !== 'object') return false
  if (typeof c.id !== 'string' || !c.id) return false
  if (typeof c.title !== 'string') return false
  return true
}
function sanitizeCachedCategory(c) {
  const items = Array.isArray(c.items)
    ? c.items.filter(it => it && typeof it.id === 'string' && /^[0-9a-f]{64}$/i.test(it.id))
    : []
  const otherContentItems = Array.isArray(c.otherContentItems)
    ? c.otherContentItems.filter(it => it && typeof it === 'object')
    : []
  const extraTags = Array.isArray(c.extraTags)
    ? c.extraTags.filter(t => Array.isArray(t) && typeof t[0] === 'string')
    : []
  return { ...c, items, otherContentItems, extraTags, privateItems: [] }
}
function loadFromStorage(pubkey) {
  const key = storageKeyFor(pubkey)
  if (!key) return []
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter(isValidCachedCategory).map(sanitizeCachedCategory)
  } catch { return [] }
}
function saveToStorage(pubkey, categories) {
  const key = storageKeyFor(pubkey)
  if (!key) return
  try {
    // Decrypted private items NEVER touch disk — an attacker with
    // filesystem access to the browser profile shouldn't be able to read
    // private bookmarks without also compromising the signer. The
    // privateCiphertext blob is safe to persist (it's still encrypted,
    // requires the signer to decrypt) and keeping it in the cache avoids
    // a stale-merge problem on publish: if we lost the ciphertext, adding
    // a new private item would overwrite any private items written to the
    // same category by another module.
    const stripped = (categories || []).map(c => {
      const { privateItems, ...rest } = c
      return rest
    })
    localStorage.setItem(key, JSON.stringify(stripped))
  } catch {}
}

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `cat-${Date.now()}`
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
      privateItems: [],
      privateCiphertext: looksEncrypted(event.content) ? event.content : '',
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

  // If the content blob is NIP-51 ciphertext, public items parse from
  // tags only (losing per-item addedAt precision — graceful fallback to
  // event.created_at) and the ciphertext is preserved for async decrypt.
  // The content field cannot simultaneously be both our extended JSON
  // format and an encrypted blob, so detecting ciphertext up-front lets us
  // skip the JSON.parse path entirely.
  const encryptedContent = looksEncrypted(event.content) ? event.content : ''

  // Prefer the extended JSON content — it carries addedAt per item.
  // Fall back to bare `e` tags if content isn't valid JSON.
  // Round-trip preservation: any content item that isn't our `{id, addedAt}`
  // shape (notably the longform module's `{aTag, title, ...}`) gets stashed
  // verbatim so republishing from the notes UI doesn't nuke other modules'
  // data in shared categories.
  const byId = new Map()
  const otherContentItems = []
  if (!encryptedContent) {
    const parsed = safeParseContentArray(event.content || '[]')
    if (parsed) {
      for (const it of parsed) {
        if (it?.id && /^[0-9a-f]{64}$/i.test(it.id)) {
          byId.set(it.id.toLowerCase(), { id: it.id.toLowerCase(), addedAt: Number(it.addedAt) || 0 })
        } else if (it && typeof it === 'object') {
          otherContentItems.push(it)
        }
      }
    }
  }
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
    privateItems: [],
    privateCiphertext: encryptedContent,
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
  // Split by privacy view. Consumers pick `hiddenIdsByView[privacyView]`
  // when they know which bucket they're rendering; cross-cutting consumers
  // (e.g., the Add-to-bookmarks picker inside a note's three-dot menu) can
  // pick based on the target privacy of the action they're offering.
  const [hiddenIdsByView, setHiddenIdsByView] = useState(() => ({
    public: new Set(),
    private: new Set(),
  }))
  // Mirror of `categories` so async flows (deleteCategory) can read the
  // current value without wrapping logic in a setState reducer.
  const categoriesRef = useRef([])
  useEffect(() => { categoriesRef.current = categories }, [categories])

  const pubkey   = user?.pubkey
  const readOnly = !!user?.readOnly

  // Load per-pubkey hidden set whenever the session user changes.
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

  const hideCategory = useCallback((categoryId, view = 'public') => {
    if (!categoryId || categoryId === PRIMARY_CATEGORY_ID) return
    const bucket = view === 'private' ? 'private' : 'public'
    setHiddenIdsByView(prev => {
      const current = prev[bucket]
      if (current.has(categoryId)) return prev
      const nextBucket = new Set(current)
      nextBucket.add(categoryId)
      const next = { ...prev, [bucket]: nextBucket }
      saveHiddenToStorage(pubkey, { public: next.public, private: next.private })
      return next
    })
  }, [pubkey])

  const unhideCategory = useCallback((categoryId, view = 'public') => {
    if (!categoryId) return
    const bucket = view === 'private' ? 'private' : 'public'
    setHiddenIdsByView(prev => {
      const current = prev[bucket]
      if (!current.has(categoryId)) return prev
      const nextBucket = new Set(current)
      nextBucket.delete(categoryId)
      const next = { ...prev, [bucket]: nextBucket }
      saveHiddenToStorage(pubkey, { public: next.public, private: next.private })
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
        const events = await withTimeout(
          ndk.fetchEvents({ kinds: [10003, 30001, 30003], authors: [pubkey] }),
          6000,
        )
        if (cancelled) return

        // Tombstone filter: a locally-recorded tombstone outranks any fetched
        // event for the same category whose created_at is older. Prevents a
        // fallback relay (which may not have seen our delete yet) from
        // resurrecting the deleted category on reload. A newer non-tombstone
        // from another client is still honored — means we re-created it.
        const tombstones = loadTombstones(pubkey)
        // Also seed from tombstones we just fetched — a delete set on another
        // device arrives as a regular replaceable event, and without seeding
        // the isTombstone filter drops it while any stale cached copy would
        // resurrect the deleted category on the next cache-merge pass.
        const eventsArr = Array.from(events)
        seedTombstonesFromEvents(eventsArr, tombstones, pubkey, saveTombstone)
        const tombstoneFor = (ev) => {
          if (ev.kind === 10003) return tombstones[PRIMARY_CATEGORY_ID] || 0
          const dTag = ev.tags?.find(t => t[0] === 'd')?.[1]
          return dTag ? (tombstones[dTag] || 0) : 0
        }

        const parsed = eventsArr
          .filter(ev => !isTombstone(ev))
          .filter(ev => (ev.created_at || 0) > tombstoneFor(ev))
          .map(parseEventToCategory)
        // Merge (dedup by id, preferring the newest createdAt per id).
        const byId = new Map()
        for (const cat of parsed) {
          const existing = byId.get(cat.id)
          if (!existing || cat.createdAt > existing.createdAt) byId.set(cat.id, cat)
        }
        // Cache-aware merge: for every cached category, keep it if its
        // createdAt beats the freshest fetched event for that id. Solves the
        // "publish succeeded to one write relay, but fallback relays still
        // return the stale event" regression — the local cache is stamped
        // with the published event's real created_at in commitCategoryUpdate,
        // so a stale fetch can't outrank it by timestamp.
        //
        // Cache-only entries (local-only createCategory not yet published,
        // or anything the relay pool didn't return) are preserved too. A
        // genuinely newer write from another client wins because its
        // created_at will be higher than the cache's stamp.
        for (const c of cached) {
          if (!c?.id) continue
          // Skip cached entries that have been tombstoned — without this,
          // a delete on another device (whose tombstone we just seeded from
          // the fetch) could still get resurrected via the cache.
          const tombAt = tombstones[c.id] || 0
          if (tombAt && (Number(c.createdAt) || 0) <= tombAt) continue
          const cachedAt = Number(c.createdAt) || 0
          const existing = byId.get(c.id)
          if (!existing || cachedAt > (existing.createdAt || 0)) byId.set(c.id, c)
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

        // Async decrypt pass for NIP-51 private items. Sequential (not
        // parallel) so a bunker that prompts per request doesn't flood the
        // signer app with N concurrent approvals. We only decrypt for the
        // owner — visitors can't read anyone else's private items, period.
        if (!readOnly) {
          const ndkSigner = ndk.signer
          const needsDecrypt = result.filter(c => c.privateCiphertext && !c.readOnly)
          for (const cat of needsDecrypt) {
            if (cancelled) return
            if (!ndkSigner) break
            const tagArray = await decryptPrivateTagArray(cat.privateCiphertext, ndk)
            if (cancelled) return
            if (!tagArray) continue
            const privateItems = tagArrayToNoteItems(tagArray)
            setCategories(prev => prev.map(c =>
              c.id === cat.id ? { ...c, privateItems } : c
            ))
          }
        }
      } catch {
        if (cancelled) return
        // On failure, stick with whatever was cached.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, readOnly])

  // Publish a category. Two content strategies coexist:
  //
  //   A) No private items anywhere in the event — content is our JSON-
  //      extended format ([{id, addedAt}, ...] for notes,
  //      [{aTag, title, ...}, ...] for longform). Shared categories merge
  //      both shapes; per-item addedAt precision is preserved.
  //
  //   B) Any private items (ours or another module's) — content becomes
  //      the NIP-51 encrypted tag array. Public items fall back to
  //      event.created_at for their addedAt (per-item precision lost
  //      within that category, by design). Longform's `a`-tags stay in
  //      the event's tags array so their references survive; enrichment
  //      refetches their title/image/author from 30023 events.
  //
  // Cross-module merge (shared categories): on publish we decrypt the
  // existing ciphertext, filter out `e`-tags (notes owns those), keep
  // `a`-tags (longform's private items), and re-encrypt the union with
  // our current private items. If decrypt fails and we have new private
  // items to save, we bail rather than corrupt the blob.
  //
  // Returns true iff the relay publish succeeded.
  // Returns the published event's `created_at` on success, or 0 on failure.
  // Callers stamp the returned timestamp onto their cached category via
  // commitCategoryUpdate so the load-path merge can tell "freshly published"
  // from "stale relay echo" by comparing created_at.
  const publishCategory = useCallback(async (cat) => {
    if (readOnly || !pubkey) return 0
    if (cat.readOnly) return 0

    // Every branch below used to swallow failures in a bare `catch {}` —
    // including the one where encrypt would silently throw "undefined
    // recipient". Hoisted so it's in scope for every try/catch in here.
    const logFailure = (where, err) => {
      if (!import.meta.env.DEV) return
      try {
        // eslint-disable-next-line no-console
        console.error(`[bookmarks] ${where} failed for category "${cat.title}" (${cat.id}):`, err)
      } catch {}
    }

    try {
      const ndk = getNDK()
      const event = new NDKEvent(ndk)

      const hasPrivateItems = Array.isArray(cat.privateItems) && cat.privateItems.length > 0

      // Build the encrypted content blob from our current private items
      // plus any foreign (non-`e`) tags preserved from an existing blob.
      async function buildEncryptedContent(sourceCiphertext) {
        let foreignTags = []
        if (sourceCiphertext && looksEncrypted(sourceCiphertext)) {
          const existing = await decryptPrivateTagArray(sourceCiphertext, ndk)
          if (Array.isArray(existing)) {
            foreignTags = existing.filter(t => Array.isArray(t) && t[0] !== 'e')
          }
        }
        const ourTags = noteItemsToTagArray(cat.privateItems || [])
        const merged = [...ourTags, ...foreignTags]
        if (merged.length === 0) return ''
        return await encryptPrivateTagArray(merged, ndk)
      }

      if (cat.id === PRIMARY_CATEGORY_ID) {
        // Cross-module merge — refetch the latest 10003 so any data the
        // longform module wrote since our load isn't silently clobbered.
        const fresh = await fetchLatestPrimary(pubkey)
        let preservedTags = cat.extraTags || []
        let contentOverride = cat.rawContent || ''
        const freshContent = fresh ? (fresh.content || '') : ''
        const freshEncrypted = looksEncrypted(freshContent)
        if (fresh) {
          // Keep every non-`e` tag (longform's `a`-tags, NIP-51 `t`/`r`
          // tags, etc). We rewrite the `e`-tag set completely from our
          // `cat.items`. Strip any foreign `client` tag too — we re-add
          // ours below so cross-client edits don't end up with multiple
          // client tags accumulating across the chain.
          preservedTags = (fresh.tags || []).filter(t => t[0] !== 'e' && t[0] !== 'client')
        }

        if (hasPrivateItems) {
          // We have new private items — re-encrypt the merged blob (our
          // items plus any foreign tags the other module owns).
          try {
            contentOverride = await buildEncryptedContent(freshContent)
          } catch (err) {
            logFailure('encrypt (primary)', err)
            return false
          }
        } else if (freshEncrypted) {
          // No new private items and the blob is encrypted. Do NOT decrypt-
          // and-re-encrypt — if our async decrypt hasn't finished yet,
          // privateItems is empty and re-encrypting would filter out our own
          // `e`-tags, silently wiping them from the blob. Preserve verbatim;
          // we're only touching public items in this publish.
          contentOverride = freshContent
        } else {
          // Pure-public path (current behavior).
          const parsed = safeParseContentArray(freshContent || '[]')
          if (parsed) {
            const longformItems = parsed.filter(it => it && typeof it === 'object' && it.aTag)
            const mergedContent = [
              ...cat.items.map(it => ({ id: it.id, addedAt: it.addedAt || 0 })),
              ...longformItems,
            ]
            contentOverride = JSON.stringify(mergedContent)
          } else if (freshContent !== '') {
            contentOverride = freshContent
          } else {
            contentOverride = ''
          }
        }

        event.kind = 10003
        event.tags = [...preservedTags]
        for (const it of cat.items) {
          if (it?.id) event.tags.push(['e', it.id])
        }
        event.tags.push(['client', 'mynostr'])
        event.content = contentOverride
      } else {
        // Preserve the source kind (30001 or 30003) so categories authored
        // by other modules stay on their original kind. New categories
        // created here default to 30003 (current NIP-51 convention).
        // Strip any inherited `client` tag from extraTags before re-adding
        // ours below.
        const customExtras = (cat.extraTags || []).filter(t => t[0] !== 'client')
        event.kind = cat.sourceKind === 30001 ? 30001 : 30003
        event.tags = [['d', cat.id], ['title', cat.title], ...customExtras]
        for (const it of cat.items) {
          if (it?.id) event.tags.push(['e', it.id])
        }
        event.tags.push(['client', 'mynostr'])

        const hadCiphertext = !!cat.privateCiphertext
        if (hasPrivateItems) {
          try {
            event.content = await buildEncryptedContent(cat.privateCiphertext || '')
          } catch (err) {
            logFailure('encrypt (category)', err)
            return false
          }
        } else if (hadCiphertext) {
          // Preserve blob verbatim (see primary branch).
          event.content = cat.privateCiphertext
        } else {
          // Merge our items with any foreign content items (e.g., longform's
          // `{aTag, ...}`) so they round-trip intact.
          const mergedContent = [...cat.items, ...(cat.otherContentItems || [])]
          event.content = JSON.stringify(mergedContent)
        }
      }
      await signWithTimeout(event)
      // Bookmarks are replaceable (kind 10003/30001/30003) and the user will
      // keep editing them. Publish only to their own NIP-65 write relays so
      // every copy lives where future edits and deletes will land — a copy on
      // a fallback relay outside their write set would keep showing the old
      // state after any future change.
      const publishedTo = await publishToOwnOutbox(event)
      const reached = Array.from(publishedTo || []).map(r => r.url).filter(Boolean)
      if (reached.length === 0) {
        logFailure('publish', new Error('no relays acknowledged the event'))
        return 0
      }
      return Number(event.created_at) || Math.floor(Date.now() / 1000)
    } catch (err) {
      logFailure('sign/publish', err)
      return 0
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
      privateItems: [],
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

  // Commit a single category change to local state after its publish has
  // landed. Used by the publish-before-commit mutation paths below so the
  // UI only reflects what durably published to at least one relay.
  //
  // `publishedAt` (optional) is the event's `created_at` — stamping it on
  // the cached category makes the load-path merge able to tell "freshly
  // published locally" from "stale echo from a lagging fallback relay"
  // when deciding which version of a category wins on reload.
  const commitCategoryUpdate = useCallback((newCat, publishedAt) => {
    const stamped = Number.isFinite(publishedAt) && publishedAt > 0
      ? { ...newCat, createdAt: publishedAt }
      : newCat
    setCategories(prev => {
      const next = prev.map(c => c.id === stamped.id ? stamped : c)
      saveToStorage(pubkey, next)
      return next
    })
  }, [pubkey])

  // Mutually-exclusive bookmarks: a note lives in exactly one (category,
  // privacy) pair at a time. Adding to target X as privacy P removes it
  // from every other bucket — every other category AND the other privacy
  // side within the target. Each affected category gets one publish.
  //
  // Publish-before-commit: state is only updated after each event lands on
  // ≥1 relay. Target is published first so a partial failure results in
  // duplication (recoverable on refetch) rather than data loss. Returns
  // true iff the target publish succeeded.
  //
  // Trade-off: moving between kinds or privacy sides costs one publish per
  // touched category. Most NIP-07 extensions auto-approve replaceables;
  // NIP-46 signers surface each as a prompt. Acceptable.
  const addNote = useCallback(async (categoryId, noteId, options = {}) => {
    if (readOnly || !noteId) return false
    const id = noteId.toLowerCase()
    const privacy = options.privacy === 'private' ? 'private' : 'public'

    const current = categoriesRef.current
    const target = current.find(c => c.id === categoryId)
    if (!target) return false

    let targetNew = null
    const sourceNews = []
    for (const c of current) {
      const publicHas  = (c.items || []).some(it => it.id === id)
      const privateHas = (c.privateItems || []).some(it => it.id === id)
      if (c.id === categoryId) {
        if (privacy === 'public' && publicHas) {
          if (!privateHas) { targetNew = c; continue }
          targetNew = { ...c, privateItems: c.privateItems.filter(it => it.id !== id) }
          continue
        }
        if (privacy === 'private' && privateHas) {
          if (!publicHas) { targetNew = c; continue }
          targetNew = { ...c, items: c.items.filter(it => it.id !== id) }
          continue
        }
        const newItem = { id, addedAt: Date.now() }
        targetNew = {
          ...c,
          items:        privacy === 'public'  ? [newItem, ...(c.items || [])]        : (c.items || []).filter(it => it.id !== id),
          privateItems: privacy === 'private' ? [newItem, ...(c.privateItems || [])] : (c.privateItems || []).filter(it => it.id !== id),
        }
      } else if (publicHas || privateHas) {
        sourceNews.push({
          ...c,
          items:        publicHas  ? c.items.filter(it => it.id !== id)        : c.items,
          privateItems: privateHas ? c.privateItems.filter(it => it.id !== id) : c.privateItems,
        })
      }
    }
    if (!targetNew) return false

    // Target first — if it fails, abort without touching state.
    const targetAt = await publishCategory(targetNew)
    if (!targetAt) return false
    commitCategoryUpdate(targetNew, targetAt)

    // Source evictions: publish and commit each individually. A failure
    // here means the item is visible in both places until the user refetches
    // or retries — duplication, not loss.
    for (const src of sourceNews) {
      const at = await publishCategory(src)
      if (at) commitCategoryUpdate(src, at)
    }
    return true
  }, [readOnly, publishCategory, commitCategoryUpdate])

  const removeNote = useCallback(async (categoryId, noteId, options = {}) => {
    if (readOnly || !noteId) return false
    const id = noteId.toLowerCase()
    const privacy = options.privacy === 'private' ? 'private' : 'public'
    const cat = categoriesRef.current.find(c => c.id === categoryId)
    if (!cat || cat.readOnly) return false
    const newCat = privacy === 'private'
      ? { ...cat, privateItems: (cat.privateItems || []).filter(it => it.id !== id) }
      : { ...cat, items:        (cat.items || []).filter(it => it.id !== id) }
    const at = await publishCategory(newCat)
    if (at) commitCategoryUpdate(newCat, at)
    return at > 0
  }, [readOnly, publishCategory, commitCategoryUpdate])

  // Flip privacy for one note within a single category. One publish. Use
  // addNote to move between categories with privacy; use this for in-place
  // flips.
  const movePrivacy = useCallback(async (categoryId, noteId, newPrivacy) => {
    if (readOnly || !noteId) return false
    const id = noteId.toLowerCase()
    const target = newPrivacy === 'private' ? 'private' : 'public'
    const cat = categoriesRef.current.find(c => c.id === categoryId)
    if (!cat || cat.readOnly) return false
    const publicHas  = (cat.items || []).some(it => it.id === id)
    const privateHas = (cat.privateItems || []).some(it => it.id === id)
    let newCat = null
    if (target === 'private') {
      if (privateHas || !publicHas) return true
      const item = cat.items.find(it => it.id === id) || { id, addedAt: Date.now() }
      newCat = {
        ...cat,
        items:        cat.items.filter(it => it.id !== id),
        privateItems: [item, ...(cat.privateItems || [])],
      }
    } else {
      if (publicHas || !privateHas) return true
      const item = cat.privateItems.find(it => it.id === id) || { id, addedAt: Date.now() }
      newCat = {
        ...cat,
        items:        [item, ...(cat.items || [])],
        privateItems: cat.privateItems.filter(it => it.id !== id),
      }
    }
    const at = await publishCategory(newCat)
    if (at) commitCategoryUpdate(newCat, at)
    return at > 0
  }, [readOnly, publishCategory, commitCategoryUpdate])

  // Bulk move: same mutual-exclusivity semantics as addNote, but for a
  // batch. One publish per *changed* category (source buckets + destination)
  // — not per note. Moving 20 notes from Ungrouped → Reading Queue is 2
  // signatures, not 40.
  //
  // Publish-before-commit: target first, then sources. Each commit fires
  // only after that event lands.
  const bulkMove = useCallback(async (targetCategoryId, noteIds, options = {}) => {
    if (readOnly || !Array.isArray(noteIds) || noteIds.length === 0) return false
    const idSet = new Set(noteIds.map(n => n.toLowerCase()).filter(n => /^[0-9a-f]{64}$/.test(n)))
    if (idSet.size === 0) return false
    const privacy = options.privacy === 'private' ? 'private' : 'public'

    const current = categoriesRef.current
    const target = current.find(c => c.id === targetCategoryId)
    if (!target) return false

    const now = Date.now()
    let targetNew = null
    const sourceNews = []
    for (const c of current) {
      const pubList  = c.items || []
      const privList = c.privateItems || []
      if (c.id === targetCategoryId) {
        const targetBucket = privacy === 'private' ? privList : pubList
        const otherBucket  = privacy === 'private' ? pubList  : privList
        const existing = new Set(targetBucket.map(it => it.id))
        const toAdd = [...idSet].filter(id => !existing.has(id))
        const needsDemote = otherBucket.some(it => idSet.has(it.id))
        if (toAdd.length === 0 && !needsDemote) {
          targetNew = c
          continue
        }
        const newTarget = [...toAdd.map(id => ({ id, addedAt: now })), ...targetBucket]
        const newOther  = otherBucket.filter(it => !idSet.has(it.id))
        targetNew = {
          ...c,
          items:        privacy === 'private' ? newOther  : newTarget,
          privateItems: privacy === 'private' ? newTarget : newOther,
        }
      } else {
        const held = pubList.some(it => idSet.has(it.id)) || privList.some(it => idSet.has(it.id))
        if (held) {
          sourceNews.push({
            ...c,
            items:        pubList .filter(it => !idSet.has(it.id)),
            privateItems: privList.filter(it => !idSet.has(it.id)),
          })
        }
      }
    }
    if (!targetNew) return false

    const targetAt = await publishCategory(targetNew)
    if (!targetAt) return false
    commitCategoryUpdate(targetNew, targetAt)

    for (const src of sourceNews) {
      const at = await publishCategory(src)
      if (at) commitCategoryUpdate(src, at)
    }
    return true
  }, [readOnly, publishCategory, commitCategoryUpdate])

  const bulkRemove = useCallback(async (categoryId, noteIds, options = {}) => {
    if (readOnly || !Array.isArray(noteIds) || noteIds.length === 0) return false
    const idSet = new Set(noteIds.map(n => n.toLowerCase()).filter(n => /^[0-9a-f]{64}$/.test(n)))
    if (idSet.size === 0) return false
    const privacy = options.privacy === 'private' ? 'private' : 'public'
    const cat = categoriesRef.current.find(c => c.id === categoryId)
    if (!cat || cat.readOnly) return false
    const newCat = privacy === 'private'
      ? { ...cat, privateItems: (cat.privateItems || []).filter(it => !idSet.has(it.id)) }
      : { ...cat, items:        (cat.items || []).filter(it => !idSet.has(it.id)) }
    const targetLen = privacy === 'private' ? (cat.privateItems || []).length : (cat.items || []).length
    const nextLen   = privacy === 'private' ? newCat.privateItems.length : newCat.items.length
    if (nextLen === targetLen) return true
    const at = await publishCategory(newCat)
    if (at) commitCategoryUpdate(newCat, at)
    return at > 0
  }, [readOnly, publishCategory, commitCategoryUpdate])

  // Bulk flip privacy within a single category. Public items in the set
  // move to privateItems; already-private items are untouched. One publish.
  const bulkMovePrivacy = useCallback(async (categoryId, noteIds, newPrivacy) => {
    if (readOnly || !Array.isArray(noteIds) || noteIds.length === 0) return false
    const idSet = new Set(noteIds.map(n => n.toLowerCase()).filter(n => /^[0-9a-f]{64}$/.test(n)))
    if (idSet.size === 0) return false
    const target = newPrivacy === 'private' ? 'private' : 'public'
    const cat = categoriesRef.current.find(c => c.id === categoryId)
    if (!cat || cat.readOnly) return false
    const pubList  = cat.items || []
    const privList = cat.privateItems || []
    let newCat = null
    if (target === 'private') {
      const moving = pubList.filter(it => idSet.has(it.id))
      if (moving.length === 0) return true
      newCat = {
        ...cat,
        items:        pubList.filter(it => !idSet.has(it.id)),
        privateItems: [...moving, ...privList],
      }
    } else {
      const moving = privList.filter(it => idSet.has(it.id))
      if (moving.length === 0) return true
      newCat = {
        ...cat,
        items:        [...moving, ...pubList],
        privateItems: privList.filter(it => !idSet.has(it.id)),
      }
    }
    const at = await publishCategory(newCat)
    if (at) commitCategoryUpdate(newCat, at)
    return at > 0
  }, [readOnly, publishCategory, commitCategoryUpdate])

  // Atomic "create category + move selection into it". If the slug already
  // exists, we merge into the existing category (same forgiveness as
  // createCategory).
  //
  // Publish-before-commit: target (new or existing) is published first so a
  // failure there aborts the whole op without touching state. Source
  // evictions publish-then-commit individually.
  const bulkMoveToNew = useCallback(async (name, noteIds, options = {}) => {
    if (readOnly || !Array.isArray(noteIds) || noteIds.length === 0) return null
    const trimmed = (name || '').trim()
    if (!trimmed) return null
    const id = makeSlug(trimmed)
    const idSet = new Set(noteIds.map(n => n.toLowerCase()).filter(n => /^[0-9a-f]{64}$/.test(n)))
    if (idSet.size === 0) return null
    const privacy = options.privacy === 'private' ? 'private' : 'public'
    const now = Date.now()

    const current = categoriesRef.current
    const existingAt = current.findIndex(c => c.id === id)
    let targetNew = null
    let targetIsNew = false
    const sourceNews = []

    if (existingAt >= 0) {
      if (current[existingAt].readOnly) return null
      for (const c of current) {
        const pubList  = c.items || []
        const privList = c.privateItems || []
        if (c.id === id) {
          const targetBucket = privacy === 'private' ? privList : pubList
          const otherBucket  = privacy === 'private' ? pubList  : privList
          const existing = new Set(targetBucket.map(it => it.id))
          const toAdd = [...idSet].filter(iid => !existing.has(iid))
          const newTarget = [...toAdd.map(iid => ({ id: iid, addedAt: now })), ...targetBucket]
          const newOther  = otherBucket.filter(it => !idSet.has(it.id))
          targetNew = {
            ...c,
            items:        privacy === 'private' ? newOther  : newTarget,
            privateItems: privacy === 'private' ? newTarget : newOther,
          }
        } else {
          const held = pubList.some(it => idSet.has(it.id)) || privList.some(it => idSet.has(it.id))
          if (held) {
            sourceNews.push({
              ...c,
              items:        pubList .filter(it => !idSet.has(it.id)),
              privateItems: privList.filter(it => !idSet.has(it.id)),
            })
          }
        }
      }
    } else {
      targetIsNew = true
      const newItems = [...idSet].map(iid => ({ id: iid, addedAt: now }))
      targetNew = {
        id,
        title: trimmed,
        items:        privacy === 'private' ? []       : newItems,
        privateItems: privacy === 'private' ? newItems : [],
        createdAt: Math.floor(Date.now() / 1000),
        readOnly: false,
      }
      for (const c of current) {
        const pubList  = c.items || []
        const privList = c.privateItems || []
        const held = pubList.some(it => idSet.has(it.id)) || privList.some(it => idSet.has(it.id))
        if (held) {
          sourceNews.push({
            ...c,
            items:        pubList .filter(it => !idSet.has(it.id)),
            privateItems: privList.filter(it => !idSet.has(it.id)),
          })
        }
      }
    }

    if (!targetNew) return null

    const targetAt = await publishCategory(targetNew)
    if (!targetAt) return null
    const stampedTarget = { ...targetNew, createdAt: targetAt }

    // Commit target. For new categories, insert at head; for existing, map.
    setCategories(prev => {
      let next
      if (targetIsNew && !prev.some(c => c.id === stampedTarget.id)) {
        next = [stampedTarget, ...prev]
      } else {
        next = prev.map(c => c.id === stampedTarget.id ? stampedTarget : c)
      }
      saveToStorage(pubkey, next)
      return next
    })

    for (const src of sourceNews) {
      const at = await publishCategory(src)
      if (at) commitCategoryUpdate(src, at)
    }
    return id
  }, [readOnly, pubkey, publishCategory, commitCategoryUpdate])

  const renameCategory = useCallback(async (categoryId, newTitle) => {
    if (readOnly) return false
    if (categoryId === PRIMARY_CATEGORY_ID) return false
    const trimmed = (newTitle || '').trim()
    if (!trimmed) return false
    const cat = categoriesRef.current.find(c => c.id === categoryId)
    if (!cat || cat.readOnly) return false
    if (cat.title === trimmed) return true
    const newCat = { ...cat, title: trimmed }
    const at = await publishCategory(newCat)
    if (at) commitCategoryUpdate(newCat, at)
    return at > 0
  }, [readOnly, publishCategory, commitCategoryUpdate])

  // Delete a category. Items inside are moved back to the primary
  // Ungrouped list (creating it locally if the user had never published
  // one) so deleting never silently discards content. Primary gets
  // republished with the merged items, and the deleted category gets a
  // tombstone event (empty replaceable, same kind it was authored in).
  const deleteCategory = useCallback(async (categoryId) => {
    if (readOnly) return false
    if (categoryId === PRIMARY_CATEGORY_ID) return false

    // Read current categories via ref so the merge is computed from
    // fresh data and nothing is mutated until the durable publish lands.
    const current = categoriesRef.current
    const cat = current.find(c => c.id === categoryId)
    if (!cat || cat.readOnly) return false

    const sourceKind    = cat.sourceKind === 30001 ? 30001 : 30003
    const publicToRehome  = cat.items || []
    const privateToRehome = cat.privateItems || []

    // ── Atomicity contract ──────────────────────────────────────────────
    // Never leave items with no home. Order of operations:
    //   1. If the category has items, publish merged primary FIRST. If
    //      that fails, ABORT — no local state change, no tombstone.
    //      Items stay safely in the source category.
    //   2. Publish the tombstone. Only after it lands on ≥1 relay do we
    //      remove the source category and commit the merged primary.
    // Tombstone failure leaves the source category in local state so the
    // user can retry — the UI never claims a delete succeeded when it didn't.
    let primaryToPublish = null
    if (publicToRehome.length > 0 || privateToRehome.length > 0) {
      const primary = current.find(c => c.id === PRIMARY_CATEGORY_ID)
      if (primary) {
        const existingPub  = new Set((primary.items || []).map(it => it.id))
        const existingPriv = new Set((primary.privateItems || []).map(it => it.id))
        const mergedPub = [
          ...publicToRehome
            .filter(it => !existingPub.has(it.id))
            .map(it => ({ id: it.id, addedAt: it.addedAt || Date.now() })),
          ...(primary.items || []),
        ]
        const mergedPriv = [
          ...privateToRehome
            .filter(it => !existingPriv.has(it.id))
            .map(it => ({ id: it.id, addedAt: it.addedAt || Date.now() })),
          ...(primary.privateItems || []),
        ]
        primaryToPublish = { ...primary, items: mergedPub, privateItems: mergedPriv }
      } else {
        // No primary yet — synthesize one. First publish creates the
        // user's kind 10003 event.
        primaryToPublish = {
          id: PRIMARY_CATEGORY_ID,
          title: 'Ungrouped',
          items:        publicToRehome .map(it => ({ id: it.id, addedAt: it.addedAt || Date.now() })),
          privateItems: privateToRehome.map(it => ({ id: it.id, addedAt: it.addedAt || Date.now() })),
          createdAt: Math.floor(Date.now() / 1000),
          readOnly: false,
          extraTags: [],
          rawContent: '',
        }
      }
      const primaryAt = await publishCategory(primaryToPublish)
      if (!primaryAt) return false
      primaryToPublish = { ...primaryToPublish, createdAt: primaryAt }
    }

    // Tombstone the deleted category on the kind it was authored in —
    // replaceables are per-kind, so a 30003 tombstone wouldn't invalidate
    // a 30001 original. Await publish and confirm at least one relay.
    let tombstoneAt = 0
    try {
      const ndk = getNDK()
      const event = new NDKEvent(ndk)
      event.kind = sourceKind
      event.tags = [['d', categoryId], ['client', 'mynostr']]
      event.content = ''
      await signWithTimeout(event)
      // Same outbox-only reasoning as publishCategory — tombstones must reach
      // the same relay set that holds every copy of the category, otherwise
      // a fallback-only copy stays "alive" from other clients' perspective.
      const publishedTo = await publishToOwnOutbox(event)
      const landed = Array.from(publishedTo || []).length > 0
      if (!landed) return false
      tombstoneAt = Number(event.created_at) || Math.floor(Date.now() / 1000)
    } catch {
      return false
    }

    // Record the tombstone locally so a stale fetch from a lagging fallback
    // relay can't resurrect this category on the next reload — the load-path
    // filter drops any fetched event for this id whose created_at <= tombstoneAt.
    saveTombstone(pubkey, categoryId, tombstoneAt)

    // Both writes landed — safe to commit local state.
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
    return true
  }, [readOnly, pubkey, publishCategory])

  return { categories, loading, createCategory, addNote, removeNote, movePrivacy, deleteCategory, renameCategory, bulkMove, bulkRemove, bulkMovePrivacy, bulkMoveToNew, hiddenIdsByView, hideCategory, unhideCategory }
}

export const NOTE_PRIMARY_CATEGORY_ID = PRIMARY_CATEGORY_ID
