import { useState, useRef, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { useIsMobile } from '../../../../hooks/useIsMobile.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
// Trust note: events returned by Primal are rendered without local signature
// verification (same model as Primal's own clients). A compromised Primal
// could display fabricated articles, but we never sign or publish based on
// them — the blast radius is display-layer disinformation only.
import { fetchAuthorLongformFeed } from '../../../../lib/primal.js'
import { isSafeUrl, getPublishedAt, withTimeout } from '../../../../lib/utils.js'
import { useReadingLists } from '../../../../lib/useReadingLists.js'
import { useArticleBookmarksContext } from '../../articleBookmarksContext.jsx'
import ArticleFeed from './ArticleFeed.jsx'
import ArticleReadPanel from './ArticleReadPanel.jsx'
import AuthorSearch from './AuthorSearch.jsx'
import BulkActionBar from './BulkActionBar.jsx'
import ArticleActionsMenu from './ArticleActionsMenu.jsx'

const MIN_FEED_W = 220
const MIN_READER_W = 320
const DEFAULT_FEED_W = 780
function defaultFeedWidth() {
  // 780 px is the target for every Discover view (My Articles, My Collection,
  // Search > Author, Search > Collection). Clamp against the available width
  // so narrow viewports (laptop + 240 px sidebar) don't starve the reader
  // pane below its minimum.
  const available = window.innerWidth - MIN_READER_W
  return Math.max(MIN_FEED_W, Math.min(DEFAULT_FEED_W, available))
}

function authorKey(pubkey) { return `mynostr_last_author_${pubkey}` }

// Recipe detection. Two match modes, any hit flips an article into the
// Recipes bucket:
//
//   1. Prefix match on `zapcooking*` and `nostrcooking*` — catches the
//      root tag (`zapcooking`) AND every sub-category the client writes
//      (`zapcooking-chicken`, `zapcooking-dinner`, `nostrcooking-italian`,
//      etc.). Future sub-categories come along for free; no list to
//      maintain. zap.cooking (current, live) uses `zapcooking`;
//      nostr.cooking (its fork predecessor, still has older recipes on
//      relays) uses `nostrcooking`.
//
//   2. Exact match on `recipe` / `recipes` — catches a MyNostr user who
//      tags their article naturally without knowing either namespace.
//
// All comparisons case-insensitive.
const RECIPE_EXACT_TAGS = new Set(['recipe', 'recipes'])
function isRecipeArticle(article) {
  const tags = article?.tags
  if (!Array.isArray(tags)) return false
  for (const t of tags) {
    if (t?.[0] !== 't') continue
    const v = String(t[1] || '').toLowerCase()
    if (v.startsWith('zapcooking') || v.startsWith('nostrcooking')) return true
    if (RECIPE_EXACT_TAGS.has(v)) return true
  }
  return false
}
function articleKey(pubkey) { return `mynostr_last_article_${pubkey}` }

function loadLastAuthor(pubkey) {
  try { return JSON.parse(localStorage.getItem(authorKey(pubkey))) } catch { return null }
}

function saveLastAuthor(pubkey, author) {
  try {
    if (author) localStorage.setItem(authorKey(pubkey), JSON.stringify(author))
    else localStorage.removeItem(authorKey(pubkey))
  } catch {}
}

function loadLastArticleIds(pubkey) {
  try { return JSON.parse(localStorage.getItem(articleKey(pubkey))) || {} } catch { return {} }
}

function saveLastArticleId(pubkey, mode, articleId) {
  try {
    const saved = loadLastArticleIds(pubkey)
    if (articleId) saved[mode] = articleId
    else delete saved[mode]
    localStorage.setItem(articleKey(pubkey), JSON.stringify(saved))
  } catch {}
}

// Keep an NDK subscription open for a fixed window so slow relays have time
// to reply after the fast ones EOSE. NDK's fetchEvents closes the sub on
// first EOSE-from-all-connected, which drops events that only live on a
// slower relay. Returns a { promise, stop } pair so the caller can cancel
// on unmount / supersession instead of letting it run to the timeout.
function collectFromRelays(ndk, filter, windowMs) {
  let sub = null
  let timer = null
  let resolveFn = null
  const byId = new Map()

  const promise = new Promise(resolve => {
    resolveFn = resolve
    try {
      sub = ndk.subscribe(filter, { closeOnEose: false, groupable: false })
      sub.on('event', ev => { if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev) })
    } catch {
      resolve([])
      return
    }
    timer = setTimeout(() => {
      try { sub?.stop() } catch {}
      resolve(Array.from(byId.values()))
      // Clear the reference so a later stop() doesn't try to resolve
      // an already-settled promise.
      resolveFn = null
      timer = null
    }, windowMs)
  })

  function stop() {
    if (timer) { clearTimeout(timer); timer = null }
    try { sub?.stop() } catch {}
    if (resolveFn) { resolveFn(Array.from(byId.values())); resolveFn = null }
  }

  return { promise, stop }
}

// For replaceable events (NIP-33), keep only the newest per (pubkey, d-tag).
function dedupeReplaceable(events) {
  const best = new Map()
  for (const ev of events) {
    const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
    const key = `${ev.pubkey}:${dTag}`
    const prev = best.get(key)
    if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) best.set(key, ev)
  }
  return Array.from(best.values())
}

export default function DiscoverView({ user, lists, privateDecryptFailed = 0, privateDecryptInProgress = false, decryptDiagnostic = null, retryDecrypt, removeArticle, removeArticlesBulk, moveArticle, moveArticlesBulk, movePrivacy, bulkMovePrivacy, deleteList, renameList, reorderLists, hiddenIdsByView, hideList, unhideList, onLoadInEditor, feedMode, onFeedModeChange, readOnly, requestedAuthor, onRequestedAuthorConsumed }) {
  // Session-scoped bookmark writers live in ArticleBookmarksContext so any
  // descendant (the three-dot menu on an author's bookmarked item, the
  // reader-pane bookmark button, the bulk-action bar on a search feed)
  // pulls the same live set of lists + mutators without prop drilling.
  // Matches NotesModule's pattern.
  //
  // `sessionRemoveArticle` is renamed to distinguish it from the
  // display-hook `removeArticle` prop. The display-hook version operates
  // on whatever hook is currently the display source (sessionHook on own
  // page, viewedHook on visits) — used by owner-only "Remove" affordances
  // on the owner's own collection three-dot menu. The session version
  // always targets MY lists, which is what the reader-pane bookmark
  // button needs when the article came from search rather than from my
  // own collection.
  const {
    myLists, addArticle, addArticlesBulk, createList, canBookmark,
    removeArticle: sessionRemoveArticle,
  } = useArticleBookmarksContext()

  // Below md:, the two-pane layout collapses to one-pane-at-a-time: the feed
  // until an article is picked, then the reader (with a back arrow) until
  // dismissed. Desktop keeps its resizable side-by-side layout.
  const isMobile = useIsMobile()
  const navigate = useNavigate()

  // ── Selection / filter ────────────────────────────────────────────────────────
  const [selected,    setSelectedRaw]    = useState(null)
  const [titleQuery,  setTitleQuery]  = useState('')

  // Owner-only privacy view — the Collection tab toolbar pill flips between
  // public and private buckets. Visitors stay on 'public' (their reading of
  // another author's lists can't see private items anyway).
  const [privacyView, setPrivacyView] = useState('public')
  // Leaving the Collection tab resets privacyView so a stale 'private'
  // selection doesn't bleed into the next visit.
  useEffect(() => {
    if (feedMode !== 'collection') setPrivacyView('public')
  }, [feedMode])

  const pubkey = user?.pubkey || ''

  function setSelected(article) {
    setSelectedRaw(article)
    // Only persist browsing state on the owner's own page — otherwise every
    // visited author leaves residue keyed by *their* pubkey in localStorage,
    // which is both unbounded growth and a behavioral leak on shared devices.
    if (!readOnly) saveLastArticleId(pubkey, feedMode, article?.id || null)
  }
  // URL sync for the reader pane lives further down — it depends on
  // `searchParams` from useSearchParams() which is declared below the
  // content-filter section. Look for "URL sync for the open article".

  // ── Author-feed state (shared by 'search' and 'mine' modes) ──────────────────
  // Only 'search' mode persists — 'mine' always pins the viewed user and is
  // a separate concept from an author search.
  const [authorFilter,   setAuthorFilter]   = useState(() => loadLastAuthor(pubkey))
  const [searchResults,  setSearchResults]  = useState([])
  const [searchProfiles, setSearchProfiles] = useState(new Map())
  const [searchLoading,  setSearchLoading]  = useState(false)
  const isAuthorFeed = feedMode === 'search' || feedMode === 'mine'

  // ── Author view mode (Search pill: their articles vs their bookmarks) ─────
  // Only meaningful in 'search' with a picked author. Reset on author swap so
  // the toggle doesn't carry across unrelated authors.
  const [authorViewMode, setAuthorViewMode] = useState('articles') // 'articles' | 'collection'
  useEffect(() => { setAuthorViewMode('articles') }, [authorFilter?.pubkey])

  // ── Content filter: Writing vs Recipes ───────────────────────────────────
  // URL-synced via ?type=recipes so the filtered view is shareable. Absent
  // param = 'writing' (default). Unknown values fall back to 'writing'.
  //
  // Only meaningful on author-articles feeds (mine + search > author-
  // articles); elsewhere it's inert but we still read the param so it
  // survives tab switches.
  const [searchParams, setSearchParams] = useSearchParams()
  const contentFilter = searchParams.get('type') === 'recipes' ? 'recipes' : 'writing'
  const supportsContentFilter =
    !!authorFilter &&
    (feedMode === 'mine' || (feedMode === 'search' && authorViewMode === 'articles'))

  function setContentFilter(next) {
    const params = new URLSearchParams(searchParams)
    if (next === 'recipes') params.set('type', 'recipes')
    else params.delete('type')
    // replace so the back button doesn't feel stuttery when toggling.
    setSearchParams(params, { replace: true })
    // Selection + currently-open article belong to the pre-toggle result
    // set; flipping filters should reset both so the user doesn't find
    // themselves with phantom checks or a reader pane for an article
    // that's no longer in the visible feed.
    setSearchCheckedIds(new Set())
    setSelectedRaw(null)
  }

  // ── URL sync for the open article ──────────────────────────────────
  // When `selected` changes, push (or strip) ?article=<naddr> on the
  // URL so the address bar matches what the user is reading. Lets
  // copy-from-URL-bar produce a useful share link without requiring
  // the three-dot menu. The reader's open/close paths are scattered —
  // some go through setSelected, some hit setSelectedRaw(null) — so
  // we sync via an effect on `selected` rather than wrapping every
  // call site.
  //
  // Cold-mount guard: on first render `selected` is null. Without the
  // guard, the effect would unconditionally strip any pre-existing
  // ?article= param from the URL — defeating the entire deep-link
  // share story. The ref skips the FIRST run; subsequent runs (real
  // open/close transitions) sync as expected.
  //
  // Has to live AFTER the useSearchParams() call above; placing it
  // earlier crashes with "Cannot access 'searchParams' before
  // initialization" at render time.
  const urlSyncReady = useRef(false)
  useEffect(() => {
    if (!urlSyncReady.current) {
      urlSyncReady.current = true
      return
    }
    let naddr = ''
    if (selected?.pubkey) {
      const dTag = selected.tags?.find(t => t[0] === 'd')?.[1] || ''
      if (dTag) {
        try {
          naddr = nip19.naddrEncode({ kind: 30023, pubkey: selected.pubkey, identifier: dTag })
        } catch {}
      }
    }
    const cur = searchParams.get('article') || ''
    if (cur === naddr) return  // no-op when URL already matches
    const next = new URLSearchParams(searchParams)
    if (naddr) next.set('article', naddr)
    else next.delete('article')
    setSearchParams(next, { replace: true })
  }, [selected, searchParams, setSearchParams])

  // Read-only fetch of the *searched* author's reading lists. Hook handles
  // null pubkey by returning empty lists, so we gate the pubkey to only
  // fetch when the Collection pill is active — avoids pulling 10003/30001/30003
  // for every searched author who the viewer may never click into.
  const authorCollectionUser = (
    feedMode === 'search' && authorViewMode === 'collection' && authorFilter?.pubkey
      ? { pubkey: authorFilter.pubkey, readOnly: true }
      : null
  )
  const authorCollection = useReadingLists(authorCollectionUser)

  // ── Bookmark group management ─────────────────────────────────────────────────
  const [collapsed,  setCollapsed]  = useState({})
  // Separate collapse map for the author-collection view so one viewer's
  // idea of "Favorites collapsed" on their own tab doesn't bleed into every
  // author's collection panel (different lists can share ids like '_bookmarks').
  const [authorCollapsed, setAuthorCollapsed] = useState({})
  useEffect(() => { setAuthorCollapsed({}) }, [authorFilter?.pubkey])
  const [checkedIds, setCheckedIds] = useState(new Set())
  // Manage-groups mode lives here (not in BookmarksPanel) so the toggle
  // button can render in the Select-all toolbar row above the panel.
  const [manageMode, setManageMode] = useState(false)
  const hasManageableGroups = lists.some(l => l.id !== '_bookmarks')
  // If the last manageable group disappears (e.g., last delete) drop out.
  useEffect(() => {
    if (manageMode && !hasManageableGroups) setManageMode(false)
  }, [manageMode, hasManageableGroups])

  // ── Author feed multi-select ──────────────────────────────────────────────────
  const [searchCheckedIds, setSearchCheckedIds] = useState(new Set())

  // Article IDs and bookmark-item aTags live in different ID spaces, so a
  // selection made in one view has no meaning in the other — clear when
  // flipping to avoid ghost selections. Ditto the currently-open article.
  // First-mount skip — otherwise the clear runs before restoreSelectedFromSaved
  // could land (today that restore is async so we'd race benignly; tomorrow
  // someone adds a synchronous restore and we'd silently wipe it).
  const viewToggleFirstMountRef = useRef(true)
  useEffect(() => {
    if (viewToggleFirstMountRef.current) { viewToggleFirstMountRef.current = false; return }
    setSearchCheckedIds(new Set())
    setSelectedRaw(null)
  }, [authorViewMode])

  // Explicit-search-only helper — anything that should count as "the user
  // searched for this author" goes through here so we persist it.
  function pickSearchAuthor(author) {
    setAuthorFilter(author)
    if (!readOnly) saveLastAuthor(pubkey, author)
  }

  // When the user pastes an naddr into Search, we load the author's feed and
  // auto-select the specific article (matched by d-tag). The dTag sits here
  // until the freshly-loaded searchResults effect consumes it.
  const pendingArticleDTagRef = useRef(null)
  function handleSelectArticle({ pubkey: authorPk, dTag, author }) {
    pendingArticleDTagRef.current = { pubkey: authorPk, dTag }
    pickSearchAuthor(author)
  }

  // Cold-mount seed from ?article=<naddr>. BechResolver redirects shared
  // naddr links to /<authorNpub>/articles?article=<naddr>; without this seed
  // the recipient just lands on the author's feed with no article opened.
  // Reuses the same pendingArticleDTagRef pipeline as the Search-paste flow:
  // once the author's articles load (via requestedAuthor → authorFilter →
  // loadAuthorArticles), the consume-pending effect below matches by d-tag
  // and opens the reader (with a direct (pubkey, d-tag) fallback fetch if
  // the article is older than the top-100 feed window).
  const articleSeedConsumedRef = useRef(false)
  useEffect(() => {
    if (articleSeedConsumedRef.current) return
    articleSeedConsumedRef.current = true
    const naddr = searchParams.get('article')
    if (!naddr) return
    try {
      const decoded = nip19.decode(naddr)
      if (decoded.type !== 'naddr') return
      const { kind, pubkey: authorPk, identifier: dTag } = decoded.data
      if (kind !== 30023 || !authorPk || !dTag) return
      pendingArticleDTagRef.current = { pubkey: authorPk, dTag }
    } catch {}
  }, [searchParams])

  // ── Accept externally-requested author (from "My Articles" tab) ──────────
  // Does NOT persist — the pinned-to-viewed-user state shouldn't pollute the
  // Search Authors tab's last-searched memory.
  useEffect(() => {
    if (!requestedAuthor) return
    setAuthorFilter(requestedAuthor)
    onRequestedAuthorConsumed?.()
  }, [requestedAuthor]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Restore last collection article on mount / when lists change ───────────
  const collectionRestoredRef = useRef(false)
  useEffect(() => {
    if (collectionRestoredRef.current) return
    if (feedMode !== 'collection') return
    const savedId = loadLastArticleIds(pubkey).collection
    if (!savedId) return
    const articles = buildBookmarkArticles()
    const match = articles.find(a => a.id === savedId)
    if (match) {
      setSelectedRaw(match)
      collectionRestoredRef.current = true
    }
  }, [feedMode, lists]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Profile cache for collection mode ──────────────────────────────────────
  const [collectionProfiles, setCollectionProfiles] = useState(new Map())

  // ── Help overlay ──────────────────────────────────────────────────────────────
  const [helpOpen, setHelpOpen] = useState(false)

  // ── Panel resizing ────────────────────────────────────────────────────────────
  const [feedWidth, setFeedWidth] = useState(() => defaultFeedWidth())
  const feedWidthRef = useRef(0)
  if (feedWidthRef.current === 0) feedWidthRef.current = defaultFeedWidth()
  const genRef = useRef(0)

  // ── Fetch profile for selected article's author (collection mode) ─────────
  // Also fires when a searched author's Collection pill is active — articles
  // there can be authored by anyone, so the reader needs profile lookup too.
  useEffect(() => {
    const needsProfile = feedMode === 'collection' ||
      (feedMode === 'search' && authorViewMode === 'collection')
    if (!needsProfile || !selected?.pubkey) return
    if (collectionProfiles.has(selected.pubkey)) return
    let cancelled = false
    ;(async () => {
      try {
        const ndk = getNDK()
        const events = await withTimeout(
          ndk.fetchEvents({ kinds: [0], authors: [selected.pubkey] }),
          5000,
        )
        if (cancelled) return
        for (const ev of Array.from(events)) {
          try {
            const p = JSON.parse(ev.content)
            setCollectionProfiles(prev => new Map(prev).set(ev.pubkey, { ...p, pubkey: ev.pubkey }))
          } catch {}
        }
      } catch {}
    })()
    return () => { cancelled = true }
  }, [feedMode, authorViewMode, selected?.pubkey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load author articles when selected ────────────────────────────────────────

  useEffect(() => {
    if (!authorFilter?.pubkey) {
      setSearchResults([])
      setSearchProfiles(new Map())
      return
    }
    loadAuthorArticles(authorFilter.pubkey)
  }, [authorFilter?.pubkey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Active subscription trackers — stopped on supersession and on unmount
  // so superseded author fetches don't keep pulling events for their full
  // timeout window.
  const activeSubsRef = useRef([])
  function trackSub(subHandle) {
    activeSubsRef.current.push(subHandle)
    return subHandle
  }
  function stopActiveSubs() {
    const subs = activeSubsRef.current
    activeSubsRef.current = []
    for (const s of subs) {
      try { s.stop() } catch {}
    }
  }
  useEffect(() => () => stopActiveSubs(), [])

  function restoreSelectedFromSaved(articles) {
    const savedId = loadLastArticleIds(pubkey)[feedMode]
    if (!savedId) return
    const match = articles.find(a => a.id === savedId)
    if (match) setSelectedRaw(match)
  }

  // Consume pending naddr-dTag once the author's feed has loaded. If the
  // article isn't in the top-100 feed Primal returned, fall back to a direct
  // NDK lookup by (pubkey, d-tag) so older articles still resolve.
  useEffect(() => {
    const pending = pendingArticleDTagRef.current
    if (!pending) return
    if (searchLoading) return
    if (searchResults.length === 0) return
    if (pending.pubkey !== authorFilter?.pubkey) return

    const match = searchResults.find(a =>
      (a.tags?.find(t => t[0] === 'd')?.[1] || '') === pending.dTag
    )
    if (match) {
      pendingArticleDTagRef.current = null
      setSelected(match)
      return
    }

    // Article not in the feed window — fetch it directly and prepend.
    let cancelled = false
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        if (cancelled) return
        const events = await withTimeout(
          ndk.fetchEvents({
            kinds: [30023], authors: [pending.pubkey], '#d': [pending.dTag],
          }),
          8000,
          'fetch-timeout'
        )
        if (cancelled) return
        const article = Array.from(events)[0]
        if (!article) {
          pendingArticleDTagRef.current = null
          return
        }
        setSearchResults(prev => {
          if (prev.some(a => a.id === article.id)) return prev
          return [article, ...prev]
        })
        pendingArticleDTagRef.current = null
        setSelected(article)
      } catch {
        pendingArticleDTagRef.current = null
      }
    })()
    return () => { cancelled = true }
  }, [searchResults, searchLoading, authorFilter?.pubkey]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAuthorArticles(authorPubkey) {
    // Cancel any in-flight author/profile subscriptions from a prior call so
    // a fast-switching user doesn't leave N sockets open until each 3s window.
    stopActiveSubs()
    const gen = ++genRef.current
    setSearchLoading(true)
    setSearchResults([])
    setSelectedRaw(null)
    try {
      // Two-stage fetch:
      //   1. Primal — fast (< 500ms typical). Renders immediately so the
      //      feed isn't blocked on slower relay EOSEs. Good enough for the
      //      common case.
      //   2. Direct relay pull — augments Primal's results. Primal's
      //      `long_form_content_feed` under-indexes articles from some
      //      clients (zap.cooking recipes were the pathological case that
      //      surfaced this — Primal returned 6 of the author's articles
      //      but none of their zap.cooking-published recipes, even though
      //      the events exist on common relays). Merged via
      //      dedupeReplaceable so duplicates collapse to newest-by-d-tag.
      //
      // Relay pull always runs; no longer gated on Primal returning zero.
      // The cost is ~3–4s of background work; the UI is already interactive
      // after Primal's response so the user doesn't feel it.
      const primal = await fetchAuthorLongformFeed(authorPubkey, null, 100)
      if (genRef.current !== gen) return

      let articles = dedupeReplaceable(primal.articles || [])
        .sort((a, b) => getPublishedAt(b) - getPublishedAt(a))
      const profiles = new Map(primal.profiles || new Map())

      // Track whether we've already flipped loading off within this
      // invocation. Can't rely on reading `searchLoading` from the
      // closure below — it's captured at render time and doesn't see the
      // setSearchLoading(true) we fired at the top of this function, nor
      // the setSearchLoading(false) we may fire below. Local bool is the
      // only honest signal.
      let loadingFlipped = false

      // Show Primal results immediately — the common case is "done" once
      // the relay augment lands and just adds a few more rows in place.
      if (articles.length > 0) {
        setSearchResults(articles)
        setSearchProfiles(profiles)
        setSearchLoading(false)
        loadingFlipped = true
        restoreSelectedFromSaved(articles)
      }

      // Relay augment — fires for every author, not just on Primal=0.
      // Merge results into the already-rendered list via
      // dedupeReplaceable so any zap.cooking / other-client recipes
      // Primal missed slide into the feed without displacing what's
      // already there.
      const ndk = getNDK()
      await connectAndWait(ndk, 3000).catch(() => {})
      if (genRef.current !== gen) return

      const articleSub = trackSub(collectFromRelays(
        ndk, { kinds: [30023], authors: [authorPubkey] }, 3000
      ))
      const rawRelayArticles = await articleSub.promise
      if (genRef.current !== gen) return

      const combined = dedupeReplaceable([...articles, ...rawRelayArticles])
        .sort((a, b) => getPublishedAt(b) - getPublishedAt(a))

      // Only call setSearchResults if the merge actually added anything —
      // keeps React from re-rendering the feed for no reason.
      if (combined.length !== articles.length) {
        articles = combined
        setSearchResults(articles)
        // Flip loading off + restore selection only when Primal-empty →
        // relay-has-data path; Primal-already-had-data path already did
        // both up top. `loadingFlipped` keeps us honest about which is
        // which without relying on stale closure state.
        if (articles.length > 0 && !loadingFlipped) {
          setSearchLoading(false)
          loadingFlipped = true
          restoreSelectedFromSaved(articles)
        }
      }

      // If BOTH Primal and relays returned nothing, we're in the clear-
      // empty state; flip loading off so the empty state can render.
      if (articles.length === 0) {
        setSearchResults([])
        setSearchLoading(false)
        loadingFlipped = true
      }

      // Fetch profile from relays only if Primal didn't include it.
      if (!profiles.has(authorPubkey)) {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        if (genRef.current !== gen) return
        const profileSub = trackSub(collectFromRelays(
          ndk, { kinds: [0], authors: [authorPubkey] }, 2000
        ))
        const profileEvents = await profileSub.promise
        if (genRef.current !== gen) return
        const best = new Map()
        for (const ev of profileEvents) {
          const prev = best.get(ev.pubkey)
          if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) best.set(ev.pubkey, ev)
        }
        for (const ev of best.values()) {
          try {
            const p = JSON.parse(ev.content)
            profiles.set(ev.pubkey, { ...p, pubkey: ev.pubkey })
          } catch {}
        }
        if (genRef.current === gen) setSearchProfiles(new Map(profiles))
      }
    } catch {
      if (genRef.current !== gen) return
    } finally {
      if (genRef.current === gen) setSearchLoading(false)
    }
  }

  // ── Build bookmark articles from reading lists ────────────────────────────────
  // `view` selects which bucket to materialize: 'public' reads `list.articles`,
  // 'private' reads `list.privateArticles`. Each output row carries _privacy
  // so downstream UI (lock icon, mutation options) can dispatch correctly.

  function buildBookmarkArticles(listsToUse = lists, view = 'public') {
    const out = []
    const bucket = view === 'private' ? 'privateArticles' : 'articles'
    for (const list of (listsToUse || [])) {
      for (const item of (list[bucket] || [])) {
        const pub = item.publishedAt || 0
        const tags = [
          ['title', item.title || ''],
          ['image', item.image || ''],
          ['d',     item.aTag?.split(':')[2] || ''],
        ]
        if (pub) tags.push(['published_at', String(pub)])
        out.push({
          id:          item.aTag,
          pubkey:      item.aTag?.split(':')[1] || '',
          // Fall back to addedAt for feed date when no published_at stored yet.
          created_at:  pub || Math.floor((item.addedAt || 0) / 1000),
          content:     '',
          tags,
          _aTag:       item.aTag,
          _listId:     list.id,
          _listTitle:  list.title,
          _privacy:    view,
          _authorName: item.author || '',
          _authorPic:  item.authorPic || '',
          _tTags:      item.tTags || [],
        })
      }
    }
    return out
  }

  // ── Computed display articles ──────────────────────────────────────────────────

  // Collection pill view of a searched author flattens *their* lists into
  // article shapes, so the reader panel + ArticleActionsMenu can render
  // identically to the owner's Collection tab.
  const inAuthorCollectionView = feedMode === 'search' && authorViewMode === 'collection' && !!authorFilter

  const displayArticles = (() => {
    if (inAuthorCollectionView) return buildBookmarkArticles(authorCollection.lists, 'public')
    if (isAuthorFeed) {
      // Writing pill hides recipes; Recipes pill shows only recipes. There's
      // no "all" — that was the explicit design: every article lands in
      // exactly one of the two buckets, matching zap.cooking's own mental
      // model where recipes are a first-class content type.
      return contentFilter === 'recipes'
        ? searchResults.filter(isRecipeArticle)
        : searchResults.filter(a => !isRecipeArticle(a))
    }

    const items = buildBookmarkArticles(lists, privacyView)
    const lq = titleQuery.trim().toLowerCase()
    if (!lq) return items
    return items.filter(a => {
      const title  = (a.tags?.find(t => t[0] === 'title')?.[1] || '').toLowerCase()
      const author = (a._authorName || '').toLowerCase()
      const listTitle = (a._listTitle || '').toLowerCase()
      return title.includes(lq) || author.includes(lq) || listTitle.includes(lq)
    })
  })()

  // Per-view hidden set and cross-view counts — the toggle pill needs to
  // show "Public (n)" / "Private (m)" for the owner to gauge how many items
  // sit behind each flag without actually flipping the view.
  const hiddenIds = hiddenIdsByView?.[privacyView] || new Set()
  const publicCount  = lists.reduce((n, l) => n + (l.articles?.length || 0), 0)
  const privateCount = lists.reduce((n, l) => n + (l.privateArticles?.length || 0), 0)

  // In author-collection view, articles come from many different pubkeys —
  // reuse collectionProfiles (same cache the owner's Collection tab uses)
  // so the reader has profile data when the user drills into an article.
  const displayProfiles = inAuthorCollectionView
    ? collectionProfiles
    : (isAuthorFeed ? searchProfiles : collectionProfiles)

  // ── Respond to mode changes (feedMode is controlled by parent) ─────────────
  const prevFeedModeRef = useRef(feedMode)
  useEffect(() => {
    if (feedMode === prevFeedModeRef.current) return
    const prev = prevFeedModeRef.current
    prevFeedModeRef.current = feedMode
    setTitleQuery('')

    // Entering 'search' — restore to last-searched author (may be null →
    // blank search). Don't carry over whatever 'mine' pinned.
    if (feedMode === 'search' && prev !== 'search') {
      setAuthorFilter(loadLastAuthor(pubkey))
    }

    // Restore last article for the target mode
    const savedIds = loadLastArticleIds(pubkey)
    const savedId = savedIds[feedMode]
    if (savedId) {
      if (feedMode === 'search' || feedMode === 'mine') {
        const match = searchResults.find(a => a.id === savedId)
        setSelectedRaw(match || null)
      } else {
        const match = buildBookmarkArticles().find(a => a.id === savedId)
        setSelectedRaw(match || null)
      }
    } else {
      setSelectedRaw(null)
    }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  function handleClearAuthor() {
    setAuthorFilter(null)
    if (!readOnly) saveLastAuthor(pubkey, null)
    setSelected(null)
  }

  // ── Panel drag ────────────────────────────────────────────────────────────────

  const startDrag = useCallback((e) => {
    const startX = e.clientX
    const startW = feedWidthRef.current
    function onMove(ev) {
      const maxW = Math.max(MIN_FEED_W, window.innerWidth - MIN_READER_W)
      const newW = Math.max(MIN_FEED_W, Math.min(maxW, startW + ev.clientX - startX))
      feedWidthRef.current = newW
      setFeedWidth(newW)
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    e.preventDefault()
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 h-full overflow-hidden">

      {/* ── Help overlay ── */}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
        {feedMode === 'search' ? (
          <>
            {authorFilter && (
              <div className="flex items-center gap-2 flex-shrink-0 min-w-0">
                {authorFilter.picture && isSafeUrl(authorFilter.picture) && (
                  <img src={authorFilter.picture} alt=""
                    className="w-5 h-5 rounded-full flex-shrink-0 object-cover"
                    onError={e => { e.target.style.display = 'none' }} />
                )}
                <span className="text-xs text-purple-300 truncate max-w-[120px]">{authorFilter.name}</span>
                <span className="text-xs text-neutral-700">
                  · {searchLoading ? 'loading…' : `${searchResults.length} article${searchResults.length !== 1 ? 's' : ''}`}
                </span>
                <button onClick={handleClearAuthor}
                  className="text-xs text-neutral-600 hover:text-neutral-400 flex-shrink-0 transition-colors">
                  ✕
                </button>
              </div>
            )}
            <div className="flex-1">
              <AuthorSearch
                onSelectAuthor={pickSearchAuthor}
                onSelectArticle={handleSelectArticle}
                expanded
              />
            </div>
          </>
        ) : feedMode === 'mine' ? (
          <div className="flex items-center gap-2 flex-shrink-0 min-w-0">
            {authorFilter?.picture && isSafeUrl(authorFilter.picture) && (
              <img src={authorFilter.picture} alt=""
                className="w-5 h-5 rounded-full flex-shrink-0 object-cover"
                onError={e => { e.target.style.display = 'none' }} />
            )}
            <span className="text-xs text-neutral-300 truncate max-w-[200px]">
              {authorFilter?.name || 'Articles'}
            </span>
            <span className="text-xs text-neutral-700">
              · {searchLoading ? 'loading…' : `${searchResults.length} article${searchResults.length !== 1 ? 's' : ''}`}
            </span>
          </div>
        ) : (
          <>
            {!readOnly && (
              <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5 flex-shrink-0">
                {[
                  { key: 'public',  label: 'Public',  count: publicCount  },
                  { key: 'private', label: 'Private', count: privateCount },
                ].map(opt => {
                  const active = privacyView === opt.key
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => {
                        setPrivacyView(opt.key)
                        setSelectedRaw(null)
                        setCheckedIds(new Set())
                      }}
                      className={`text-[11px] px-2.5 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 ${
                        active
                          ? (opt.key === 'private' ? 'bg-neutral-700 text-neutral-100' : 'bg-purple-700 text-white')
                          : 'text-neutral-400 hover:text-neutral-200'
                      }`}
                      title={opt.key === 'private'
                        ? 'Private bookmarks — encrypted, only you see them'
                        : 'Public bookmarks — visible to anyone on Nostr'}
                    >
                      {opt.key === 'private' && (
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                          <rect x="3" y="7" width="10" height="7" rx="1.2" />
                          <path d="M5 7V5a3 3 0 016 0v2" strokeLinecap="round" />
                        </svg>
                      )}
                      <span>{opt.label}</span>
                      <span className={active ? 'opacity-90' : 'opacity-60'}>({opt.count})</span>
                    </button>
                  )
                })}
              </div>
            )}
            <input type="text" value={titleQuery}
              onChange={e => setTitleQuery(e.target.value)}
              placeholder="Filter by title, author, or list name…"
              className="flex-1 min-w-0 bg-neutral-800 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500 placeholder-neutral-600" />
            <button onClick={() => setHelpOpen(true)}
              className="text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-600 hover:text-neutral-300 hover:border-neutral-600 transition-colors flex-shrink-0"
              title="How does Collection work?">
              ?
            </button>
          </>
        )}
      </div>

      {/* Decrypt state banner — three modes:
          1. In-progress: "Decrypting…" while runDecryptPass is sweeping.
          2. Pending-no-attempts-in-flight: "Tap to decrypt" — covers the
             silent-fail case on mobile Firefox where the cold-load
             sweep rejected without ever surfacing a prompt.
          3. (Same UI as #2 when the retry loop has finished with failures.)
          Mirrors the BookmarksTab pattern. */}
      {!readOnly && privacyView === 'private' && (() => {
        // `privateDecrypted` is the runtime success flag from
        // useReadingLists. The old `privateArticles.length === 0`
        // proxy was the bug that flagged cross-module shared lists
        // (notes + longform sharing 10003/30001/30003) as "couldn't
        // decrypt" whenever the blob held only `e` tags — decrypt
        // succeeded; the articles-side filter legitimately returned
        // zero articles.
        const pendingDecryptCount = lists.filter(
          l => l.privateCiphertext && !l.privateDecrypted,
        ).length
        if (pendingDecryptCount === 0) return null
        return (
          <div className="px-4 pt-2 flex-shrink-0">
            <div className="px-3 py-2 rounded border border-amber-900/60 bg-amber-950/25 text-[11px] text-amber-200 flex items-start gap-2">
              <span className="text-base leading-none mt-0.5" aria-hidden>
                {privateDecryptInProgress ? '🔒' : '⚠'}
              </span>
              <div className="flex-1">
                {privateDecryptInProgress ? (
                  <span>
                    Decrypting your private bookmarks
                    {pendingDecryptCount > 1 ? ` (${pendingDecryptCount} lists)` : ''}…
                    Your signer extension may prompt you to approve.
                  </span>
                ) : (
                  <>
                    <span>
                      Couldn't decrypt {pendingDecryptCount}
                      {' '}{pendingDecryptCount === 1 ? 'private list' : 'private lists'}.
                      {' '}Your signer needs to approve a decrypt prompt — try the button below.
                      On mobile Firefox, the prompt sometimes doesn't render unless you tap to trigger it.
                    </span>
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => { retryDecrypt?.() }}
                        disabled={privateDecryptInProgress}
                        className="px-2.5 py-1 rounded bg-amber-700/40 hover:bg-amber-700/60 disabled:opacity-50 text-amber-100 text-[11px] font-medium border border-amber-700/40"
                      >
                        Tap to decrypt
                      </button>
                    </div>
                    {decryptDiagnostic && (
                      <details className="mt-2 text-[10px] text-amber-300/80">
                        <summary className="cursor-pointer hover:text-amber-200">Details for support</summary>
                        <div className="mt-1 space-y-0.5 font-mono">
                          <div>nip04 exposed: {String(decryptDiagnostic.available?.nip04)}</div>
                          <div>nip44 exposed: {String(decryptDiagnostic.available?.nip44)}</div>
                          <div>signer attached: {String(decryptDiagnostic.available?.hasSigner)}</div>
                          {decryptDiagnostic.errors?.map((e, i) => (
                            <div key={i} className="break-all">• {e}</div>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Body — feed + reader, 50/50 default on desktop; on mobile either
          feed OR reader (controlled by whether an article is selected). ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left pane — article feed / bookmarks. Hidden on mobile while an
            article is open; full-width when visible. */}
        <div className={`flex flex-col overflow-hidden ${
            isMobile
              ? selected ? 'hidden' : 'flex-1 w-full'
              : 'flex-shrink-0'
          }`}
          style={isMobile ? undefined : { width: `${feedWidth}px` }}>

          {isAuthorFeed ? (
            authorFilter ? (
              <>
                {/* Top-of-feed pill row.
                      • Author/Collection (search mode only) — switches
                        the feed between the picked author's articles and
                        their reading lists. 'mine' pins the viewing user
                        so the equivalent "their bookmarks" would just
                        duplicate the Collection tab.
                      • Writing/Recipes (both mine + search > author-
                        articles) — partitions kind-30023 events by
                        whether they carry a recipe t-tag. Hidden in
                        Author's Collection view because collection items
                        go through a separate parsing path. */}
                {(feedMode === 'search' || supportsContentFilter) && (
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-800/60 flex-shrink-0 flex-wrap">
                    {feedMode === 'search' && (
                      <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5">
                        {[
                          { key: 'articles',   label: 'Author' },
                          { key: 'collection', label: 'Collection' },
                        ].map(opt => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => setAuthorViewMode(opt.key)}
                            className={`text-[11px] px-2.5 py-0.5 rounded-full transition-colors ${
                              authorViewMode === opt.key
                                ? 'bg-purple-700 text-white'
                                : 'text-neutral-400 hover:text-neutral-200'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                    {supportsContentFilter && (
                      <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5">
                        {[
                          { key: 'writing', label: 'Writing' },
                          { key: 'recipes', label: 'Recipes' },
                        ].map(opt => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => setContentFilter(opt.key)}
                            className={`text-[11px] px-2.5 py-0.5 rounded-full transition-colors ${
                              contentFilter === opt.key
                                ? 'bg-purple-700 text-white'
                                : 'text-neutral-400 hover:text-neutral-200'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {searchCheckedIds.size > 0 && (
                  <BulkActionBar
                    articles={displayArticles.filter(a => searchCheckedIds.has(a.id))}
                    profiles={displayProfiles}
                    lists={canBookmark ? myLists : []}
                    onAddToList={canBookmark ? addArticle : null}
                    onAddManyToList={canBookmark ? addArticlesBulk : null}
                    onCreateList={canBookmark ? createList : null}
                    onClearSelection={() => setSearchCheckedIds(new Set())}
                  />
                )}
                {displayArticles.length > 0 && (
                  <div className="flex items-center px-3 py-1.5 border-b border-neutral-800/60 flex-shrink-0">
                    <label className="flex items-center gap-2 text-xs text-neutral-600 hover:text-neutral-400 cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        checked={displayArticles.length > 0 && displayArticles.every(a => searchCheckedIds.has(a.id))}
                        onChange={e => {
                          if (e.target.checked) {
                            setSearchCheckedIds(new Set(displayArticles.map(a => a.id)))
                          } else {
                            setSearchCheckedIds(new Set())
                          }
                        }}
                        className="accent-purple-600 opacity-30 hover:opacity-80 checked:opacity-100 transition-opacity"
                      />
                      Select all
                    </label>
                  </div>
                )}

                {inAuthorCollectionView ? (
                  authorCollection.loading && authorCollection.lists.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center py-16">
                      <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : (
                    <BookmarksPanel
                      manageMode={false}
                      // `lists` = the searched author's lists (for display
                      // in the left panel). `myLists` + `canBookmark` are
                      // threaded so each item's three-dot can offer
                      // "Add to bookmarks" targeting OUR own lists —
                      // readOnly stays true so owner-only edit affordances
                      // (move/remove/flip) stay hidden.
                      lists={authorCollection.lists}
                      myLists={myLists}
                      titleQuery=""
                      collapsed={authorCollapsed}
                      setCollapsed={setAuthorCollapsed}
                      selected={selected}
                      // Don't persist as the last-opened search article — the
                      // restore path looks in searchResults (author's written
                      // articles), so a bookmark aTag would never match.
                      onSelect={(article) => setSelectedRaw(article)}
                      displayArticles={displayArticles}
                      checkedIds={searchCheckedIds}
                      onToggleCheck={(id, checked) => {
                        setSearchCheckedIds(prev => {
                          const next = new Set(prev)
                          checked ? next.add(id) : next.delete(id)
                          return next
                        })
                      }}
                      addArticle={canBookmark ? addArticle : undefined}
                      createList={canBookmark ? createList : undefined}
                      deleteList={undefined}
                      renameList={undefined}
                      reorderLists={undefined}
                      hiddenIds={undefined}
                      hideList={undefined}
                      unhideList={undefined}
                      readOnly={true}
                      canBookmark={canBookmark}
                      onOpenHelp={() => setHelpOpen(true)}
                    />
                  )
                ) : (
                  <ArticleFeed
                    articles={displayArticles}
                    profiles={displayProfiles}
                    loading={searchLoading}
                    loadingMore={false}
                    hasMore={false}
                    selectedId={selected?.id}
                    checkedIds={searchCheckedIds}
                    onSelect={setSelected}
                    onToggleSelect={(id, checked) => {
                      setSearchCheckedIds(prev => {
                        const next = new Set(prev)
                        checked ? next.add(id) : next.delete(id)
                        return next
                      })
                    }}
                    onLoadMore={() => {}}
                    lists={canBookmark ? myLists : null}
                    onAddToList={canBookmark ? addArticle : null}
                    onCreateList={canBookmark ? createList : null}
                    onLoadInEditor={onLoadInEditor}
                  />
                )}
              </>
            ) : (
              <SearchEmptyState />
            )
          ) : (
            <>
            {checkedIds.size > 0 && (
              <BulkActionBar
                articles={displayArticles.filter(a => checkedIds.has(a.id))}
                profiles={new Map()}
                lists={canBookmark ? myLists : []}
                onAddToList={canBookmark ? addArticle : null}
                onAddManyToList={canBookmark ? addArticlesBulk : null}
                onCreateList={canBookmark ? createList : null}
                onMoveArticle={readOnly ? null : moveArticle}
                onMoveArticlesBulk={readOnly ? null : moveArticlesBulk}
                onBulkMovePrivacy={readOnly ? null : bulkMovePrivacy}
                onRemoveArticle={readOnly ? null : removeArticle}
                onRemoveArticlesBulk={readOnly ? null : removeArticlesBulk}
                onClearSelection={() => setCheckedIds(new Set())}
                privacyView={privacyView}
              />
            )}
            {(displayArticles.length > 0 || (!readOnly && hasManageableGroups)) && (
              <div className="flex items-center px-3 py-1.5 border-b border-neutral-800/60 flex-shrink-0">
                {displayArticles.length > 0 && (
                  <label className="flex items-center gap-2 text-xs text-neutral-600 hover:text-neutral-400 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={displayArticles.length > 0 && displayArticles.every(a => checkedIds.has(a.id))}
                      onChange={e => {
                        if (e.target.checked) {
                          setCheckedIds(new Set(displayArticles.map(a => a.id)))
                        } else {
                          setCheckedIds(new Set())
                        }
                      }}
                      className="accent-purple-600 opacity-30 hover:opacity-80 checked:opacity-100 transition-opacity"
                    />
                    Select all
                  </label>
                )}
                {!readOnly && hasManageableGroups && (
                  <button
                    onClick={() => setManageMode(m => !m)}
                    className={`ml-auto text-[11px] px-2 py-0.5 rounded border transition-colors ${
                      manageMode
                        ? 'bg-neutral-800 border-neutral-600 text-neutral-200'
                        : 'border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'
                    }`}
                    title="Rename, hide, or delete groups"
                  >
                    {manageMode ? 'Done' : 'Manage groups'}
                  </button>
                )}
              </div>
            )}
            <BookmarksPanel
              manageMode={manageMode}
              lists={lists}
              myLists={myLists}
              titleQuery={titleQuery}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              selected={selected}
              onSelect={setSelected}
              displayArticles={displayArticles}
              checkedIds={checkedIds}
              onToggleCheck={(id, checked) => {
                setCheckedIds(prev => {
                  const next = new Set(prev)
                  checked ? next.add(id) : next.delete(id)
                  return next
                })
              }}
              addArticle={addArticle}
              moveArticle={moveArticle}
              removeArticle={removeArticle}
              createList={createList}
              deleteList={deleteList}
              renameList={renameList}
              reorderLists={reorderLists}
              movePrivacy={movePrivacy}
              hiddenIds={hiddenIds}
              hideList={(id) => hideList(id, privacyView)}
              unhideList={(id) => unhideList(id, privacyView)}
              readOnly={readOnly}
              canBookmark={canBookmark}
              privacyView={privacyView}
              onOpenHelp={() => setHelpOpen(true)}
            />
            </>
          )}
        </div>

        {/* Drag handle between feed and reader — desktop only. */}
        {!isMobile && (
          <div onMouseDown={startDrag}
            className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-purple-700 cursor-col-resize transition-colors" />
        )}

        {/* Right pane — article reader. On mobile, hidden until an article
            is selected; then takes the whole body until the back arrow
            dismisses it. */}
        <div className={`flex flex-col overflow-hidden ${
          isMobile
            ? selected ? 'flex-1 w-full' : 'hidden'
            : 'flex-1'
        }`}>
          {selected ? (() => {
            // When viewing another author's Collection, `selected._listId` points
            // at *their* list — the viewer doesn't own it, so Move/Remove would
            // fail against the publish path. Strip the foreign-list markers so
            // the panel renders as a non-bookmarked item (Copy/Add To only).
            //
            // Distinguish by *view*, not by id match — id collisions on the
            // NIP-51 primary list (`_bookmarks`, shared by every user) and on
            // common slugs ("favorites" etc) would make a pure id.some() check
            // think Alice's bookmark is Reed's and route clicks into
            // moveArticle against Reed's hook → fails silently because Reed's
            // list doesn't contain that aTag.
            const isOwnBookmark = !inAuthorCollectionView
              && !!selected?._listId
              && lists?.some(l => l.id === selected._listId)
            const panelArticle = inAuthorCollectionView && selected?._listId
              ? { ...selected, _listId: undefined, _listTitle: undefined, _privacy: undefined }
              : selected
            return (
            <ArticleReadPanel
              key={selected.id}
              article={panelArticle}
              profile={displayProfiles.get(selected.pubkey)}
              lists={canBookmark ? myLists : null}
              onAddToList={canBookmark ? addArticle : null}
              onCreateList={canBookmark ? createList : null}
              onMoveArticle={readOnly || !isOwnBookmark ? null : moveArticle}
              onMovePrivacy={readOnly || !isOwnBookmark ? null : movePrivacy}
              // Remove targets MY lists, not the display hook's — so it
              // works when the article was opened from search-author
              // results and happens to already be in one of my lists.
              // sessionRemoveArticle comes from the context above, which
              // always points at the session hook.
              onRemoveFromList={canBookmark ? sessionRemoveArticle : undefined}
              defaultPrivacy={privacyView}
              onLoadInEditor={onLoadInEditor}
              onClose={() => setSelected(null)}
              onAuthorClick={(author) => {
                // Navigate to the author's articles page rather than
                // bouncing through the in-module Search tab. The Search
                // path was owner-gated (visitors got bounced) and broke
                // when logged out entirely. A direct navigate works in
                // every state — visitor, owner, logged-out — and gives
                // the click a predictable destination (the author's
                // own /articles).
                if (!author?.pubkey) return
                let np = ''
                try { np = nip19.npubEncode(author.pubkey) } catch {}
                if (np) navigate(`/${np}/articles`)
              }}
              readOnly={readOnly}
              canBookmark={canBookmark}
              user={user}
              isMobile={isMobile}
            />
            )
          })() : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-xs text-neutral-700">Select an article to read</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Search empty state ──────────────────────────────────────────────────────────

function SearchEmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-4">
      <div className="text-3xl text-neutral-700">🔍</div>
      <div className="space-y-1.5">
        <p className="text-sm text-neutral-300">Search</p>
        <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">
          Search by author name, or paste an <span className="text-neutral-400">npub</span> to jump to an author, or an <span className="text-neutral-400">naddr</span> to open a specific article.
        </p>
      </div>
    </div>
  )
}

// ── Help overlay ────────────────────────────────────────────────────────────────

function HelpOverlay({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onMouseDown={onClose}>
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md"
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">How Collection Works</h2>
          <button onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none">
            ✕
          </button>
        </div>
        <div className="px-5 py-4 space-y-4 text-xs text-neutral-400 leading-relaxed">
          <div>
            <p className="text-neutral-200 font-medium mb-1">Your Collection uses Nostr bookmarks (NIP-51)</p>
            <p>
              Any long-form article or recipe you bookmark in another Nostr app
              (Primal, Habla, zap.cooking, etc.) will appear here automatically.
              Your bookmarks are stored as public Nostr events on your relays.
            </p>
          </div>
          <div>
            <p className="text-neutral-200 font-medium mb-1">How to add items</p>
            <ul className="list-disc list-inside space-y-1 text-neutral-500">
              <li>Bookmark articles in any Nostr client</li>
              <li>Use <span className="text-neutral-300">Search</span> here to find and bookmark articles</li>
              <li>Create named reading lists to organize your collection</li>
            </ul>
          </div>
          <div>
            <p className="text-neutral-200 font-medium mb-1">What you can do here</p>
            <ul className="list-disc list-inside space-y-1 text-neutral-500">
              <li>Read articles and recipes in a clean reader</li>
              <li>Organize into named reading lists</li>
              <li>Export as .md or .epub</li>
              <li>Load into the editor to republish or remix</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Bookmarks panel ─────────────────────────────────────────────────────────────

function BookmarksPanel({ lists, myLists, titleQuery, collapsed, setCollapsed, selected, onSelect, displayArticles, checkedIds, onToggleCheck, addArticle, moveArticle, removeArticle, createList, deleteList, renameList, reorderLists, movePrivacy, hiddenIds, hideList, unhideList, readOnly, canBookmark, privacyView = 'public', onOpenHelp, manageMode }) {
  const [editingId,     setEditingId]     = useState(null)
  const [editTitle,     setEditTitle]     = useState('')
  const [confirmDel,    setConfirmDel]    = useState(null)
  const [itemMenuId,    setItemMenuId]    = useState(null) // aTag of item with open menu
  // List-scoped mutation status so a failed rename/delete surfaces in the
  // header instead of silently reverting. `pendingListOp` is the op in
  // flight ('renaming' | 'deleting' | null); `errorListId` parks the most
  // recent failed list so the user sees the Yes/✎ didn't land.
  const [pendingList,   setPendingList]   = useState({ id: null, op: null })
  const [errorListId,   setErrorListId]   = useState(null)

  // Leaving manage mode cancels any in-flight rename/delete prompts so
  // they don't resurface the next time manage is opened.
  useEffect(() => {
    if (manageMode) return
    if (editingId) setEditingId(null)
    if (confirmDel) setConfirmDel(null)
  }, [manageMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close item menu on outside click
  useEffect(() => {
    if (!itemMenuId) return
    function handler() { setItemMenuId(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [itemMenuId])

  // Set of visible article IDs (filtered by text query)
  const visibleIds = new Set(displayArticles.map(a => a.id))

  // Show onboarding only when the user has zero bookmark categories at
  // all. Categories that contain only non-longform bookmarks (e.g., kind 1
  // notes from the Notes module) still render here as empty groups — user
  // keeps visibility into the same category list across both modules.
  // Visitors also see the empty-state when every public list is empty,
  // since the map below filters those rows out.
  const bucketKey = privacyView === 'private' ? 'privateArticles' : 'articles'
  const visitorHasNothing = readOnly && !lists.some(l => (l.articles?.length || 0) > 0)
  // In private view, an owner with no private items should see a targeted
  // empty state rather than the generic onboarding copy — they know how to
  // bookmark, just haven't marked anything private yet.
  const ownerPrivateEmpty = !readOnly && privacyView === 'private'
    && !lists.some(l => (l.privateArticles?.length || 0) > 0)
  if (!lists.length || visitorHasNothing || ownerPrivateEmpty) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-4">
        <div className="text-3xl text-neutral-700">{ownerPrivateEmpty ? '🔒' : '📚'}</div>
        <div className="space-y-1.5">
          {readOnly ? (
            <>
              <p className="text-sm text-neutral-300">No public bookmarks</p>
              <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">
                This user hasn't published any public reading lists yet.
              </p>
            </>
          ) : ownerPrivateEmpty ? (
            <>
              <p className="text-sm text-neutral-300">No private bookmarks</p>
              <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">
                Mark items private from the Public view to store them encrypted.
                Only you can decrypt and see them.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-neutral-300">Your collection is empty</p>
              <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">
                Bookmark long-form articles and recipes from any Nostr app — they'll appear here.
                Or use <span className="text-neutral-400">Search</span> to find and bookmark articles.
              </p>
            </>
          )}
        </div>
        {!readOnly && !ownerPrivateEmpty && (
          <button onClick={onOpenHelp}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-500 transition-colors">
            Learn more
          </button>
        )}
      </div>
    )
  }

  const totalVisible = displayArticles.length
  if (totalVisible === 0 && titleQuery.trim()) {
    return (
      <div className="flex items-center justify-center flex-1 py-16">
        <p className="text-sm text-neutral-600">No matches.</p>
      </div>
    )
  }

  function toggleCollapse(id) {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function startEdit(list, e) {
    e.stopPropagation()
    setEditingId(list.id)
    setEditTitle(list.title)
    setConfirmDel(null)
  }

  async function commitEdit(list) {
    const t = editTitle.trim()
    if (!t || t === list.title) { setEditingId(null); return }
    setEditingId(null)
    setPendingList({ id: list.id, op: 'renaming' })
    setErrorListId(null)
    try {
      const ok = await renameList(list.id, t)
      if (ok === false) {
        setErrorListId(list.id)
        setTimeout(() => setErrorListId(prev => prev === list.id ? null : prev), 3000)
      }
    } catch {
      setErrorListId(list.id)
      setTimeout(() => setErrorListId(prev => prev === list.id ? null : prev), 3000)
    } finally {
      setPendingList({ id: null, op: null })
    }
  }

  async function confirmDelete(listId) {
    setConfirmDel(null)
    setPendingList({ id: listId, op: 'deleting' })
    setErrorListId(null)
    try {
      const ok = await deleteList(listId)
      if (ok === false) {
        setErrorListId(listId)
        setTimeout(() => setErrorListId(prev => prev === listId ? null : prev), 3000)
      }
    } catch {
      setErrorListId(listId)
      setTimeout(() => setErrorListId(prev => prev === listId ? null : prev), 3000)
    } finally {
      setPendingList({ id: null, op: null })
    }
  }

  function handleDeleteClick(id, e) {
    e.stopPropagation()
    setConfirmDel(id === confirmDel ? null : id)
    setEditingId(null)
  }

  // Close item menu when clicking outside
  function handlePanelClick() {
    if (itemMenuId) setItemMenuId(null)
  }

  return (
    <div className="overflow-y-auto flex-1" onClick={handlePanelClick}>
      {lists.map((list, listIndex) => {
        const isPrimary   = list.id === '_bookmarks'
        const isHidden    = !!hiddenIds?.has(list.id)
        // Outside manage mode, suppress hidden groups entirely. We return
        // null from the map (rather than filtering lists upstream) so that
        // listIndex stays aligned with the full reorderLists array.
        if (isHidden && !manageMode) return null

        const allItems    = list[bucketKey] || []
        // Visitor view: visitors can't manage or hide chips, so an empty
        // category is just clutter. Owners keep seeing empties so they can
        // add articles or manually hide the group. Visitors never see the
        // private bucket at all (bucketKey is always 'articles' for them).
        if (readOnly && allItems.length === 0) return null
        // Sort by published_at (or addedAt fallback) desc so the newest
        // article surfaces first, matching the author feed behavior.
        const items       = allItems
          .filter(item => visibleIds.has(item.aTag))
          .slice()
          .sort((a, b) => {
            const at = a.publishedAt || Math.floor((a.addedAt || 0) / 1000)
            const bt = b.publishedAt || Math.floor((b.addedAt || 0) / 1000)
            return bt - at
          })
        const isCollapsed = !!collapsed[list.id]
        const isEditing   = editingId === list.id
        const isDeleting  = confirmDel === list.id

        return (
          <div key={list.id} className={isHidden ? 'opacity-60' : ''}>
            {/* Group header */}
            <div className={`flex items-center gap-1 px-2 py-1.5 border-b border-neutral-800 sticky top-0 z-10 ${
              isHidden ? 'bg-neutral-900/60 border-dashed' : 'bg-neutral-900'
            }`}>
              <button onClick={() => toggleCollapse(list.id)}
                className="flex items-center gap-2 flex-1 min-w-0 text-xs font-medium text-neutral-400 hover:text-neutral-200 transition-colors text-left">
                <span className={`flex-shrink-0 transition-transform text-[10px] ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                {isEditing ? (
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitEdit(list); if (e.key === 'Escape') setEditingId(null) }}
                    onBlur={() => commitEdit(list)}
                    onClick={e => e.stopPropagation()}
                    className="flex-1 bg-neutral-800 border border-neutral-600 rounded px-2 py-0.5 text-xs text-neutral-100 focus:outline-none focus:border-purple-600"
                  />
                ) : (
                  <span className={`flex-1 truncate ${isHidden ? 'text-neutral-500' : ''}`}>{list.title}</span>
                )}
              </button>
              <span className="text-neutral-700 text-xs flex-shrink-0">
                {items.length !== allItems.length ? `${items.length}/${allItems.length}` : allItems.length}
              </span>
              {!readOnly && !isEditing && !isDeleting && (
                <>
                  {/* Group reorder arrows — always available, even outside
                      manage mode, since reordering isn't destructive. */}
                  <button onClick={e => { e.stopPropagation(); reorderLists(listIndex, listIndex - 1) }}
                    disabled={listIndex === 0}
                    className="text-neutral-700 hover:text-neutral-400 disabled:opacity-20 transition-colors px-0.5 text-[10px] flex-shrink-0"
                    title="Move group up">▲</button>
                  <button onClick={e => { e.stopPropagation(); reorderLists(listIndex, listIndex + 1) }}
                    disabled={listIndex === lists.length - 1}
                    className="text-neutral-700 hover:text-neutral-400 disabled:opacity-20 transition-colors px-0.5 text-[10px] flex-shrink-0"
                    title="Move group down">▼</button>
                  {manageMode && !isPrimary && (
                    <>
                      <button onClick={e => startEdit(list, e)}
                        className="text-neutral-700 hover:text-neutral-400 transition-colors px-1 text-xs flex-shrink-0"
                        title="Rename group">✎</button>
                      <button
                        onClick={e => { e.stopPropagation(); (isHidden ? unhideList : hideList)?.(list.id) }}
                        className="text-neutral-700 hover:text-neutral-300 transition-colors px-1 flex-shrink-0"
                        title={isHidden ? 'Show in this view' : 'Hide from this view'}
                        aria-label={isHidden ? `Show ${list.title}` : `Hide ${list.title}`}
                      >
                        {isHidden ? (
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                            <path d="M2 2l12 12" strokeLinecap="round" />
                            <path d="M6.5 4.2A7.4 7.4 0 018 4c4.5 0 7 4 7 4a13 13 0 01-2 2.4M11 11.6A7.4 7.4 0 018 12c-4.5 0-7-4-7-4a13 13 0 012.6-3" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M6.6 6.6a2 2 0 002.8 2.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                            <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round" />
                            <circle cx="8" cy="8" r="2" />
                          </svg>
                        )}
                      </button>
                      <button onClick={e => handleDeleteClick(list.id, e)}
                        className="text-neutral-700 hover:text-red-500 transition-colors px-1 text-xs flex-shrink-0"
                        title="Delete group (items move to Ungrouped)">✕</button>
                    </>
                  )}
                </>
              )}
              {isDeleting && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs text-neutral-500" title="Items in this group will move to Ungrouped">Delete?</span>
                  <button onClick={() => confirmDelete(list.id)}
                    title="Items will move to Ungrouped"
                    className="text-xs text-red-500 hover:text-red-400 transition-colors px-1">Yes</button>
                  <button onClick={() => setConfirmDel(null)}
                    className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors px-1">No</button>
                </div>
              )}
              {pendingList.id === list.id && pendingList.op && (
                <span className="flex items-center gap-1 text-xs text-neutral-500 flex-shrink-0">
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  <span>{pendingList.op === 'deleting' ? 'Deleting…' : 'Saving…'}</span>
                </span>
              )}
              {errorListId === list.id && pendingList.id !== list.id && (
                <span className="text-xs text-red-400 flex-shrink-0" title="Publish failed — try again">⚠️ Failed</span>
              )}
            </div>

            {!isCollapsed && items.length === 0 && (
              <div className="px-4 py-3 text-xs text-neutral-600 italic">
                {allItems.length === 0
                  ? 'Empty group — move or copy items here from other groups'
                  : 'No items match your filter'}
              </div>
            )}

            {!isCollapsed && items.map(item => {
              const fakeArticle = displayArticles.find(a => a.id === item.aTag)
              if (!fakeArticle) return null
              // When we're in a non-owner context (readOnly panel = viewing
              // someone else's collection), `fakeArticle._listId` points at
              // THEIR list, not ours. The action menu's "isAlreadyBookmarked"
              // detection uses `_listId` to decide move-vs-add and to offer
              // move/remove affordances — if we leave the foreign id in,
              // those handlers try to operate on a list the viewer doesn't
              // own and silently bail (or publish against a list id that
              // doesn't exist in their own pubkey's namespace). Strip the
              // foreign markers so the menu treats this as a fresh add.
              const menuArticle = readOnly
                ? { ...fakeArticle, _listId: undefined, _listTitle: undefined, _privacy: undefined }
                : fakeArticle
              const isSelected = selected?.id === fakeArticle.id
              const displayTitle = item.title || item.aTag?.split(':')[2] || 'Untitled'
              const isHex = (s) => s && (/^[a-f0-9]{6,}$/i.test(s) || s.startsWith('npub'))
              const authorDisplay = item.author && !isHex(item.author) ? item.author : ''
              const tagSummary = (item.tTags || []).slice(0, 3).join(', ')
              const dateMs = item.publishedAt
                ? item.publishedAt * 1000
                : (item.addedAt || 0)
              const dateStr = dateMs
                ? new Date(dateMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : ''
              const menuOpen = itemMenuId === item.aTag
              // Owner on their own collection: "Move to…" shows OTHER of
              // their lists. Non-owner (logged-in visitor): the Add-to
              // picker must target MY lists, not theirs — adding to
              // Alice's list ID with my signing key would just create a
              // stray entry in my namespace.
              const pickerLists = !readOnly
                ? lists.filter(l => l.id !== list.id)
                : (myLists || [])

              return (
                <div key={item.aTag}
                  className={`relative flex items-center border-b border-neutral-800/60 transition-colors ${isSelected ? 'bg-purple-950/30' : 'hover:bg-neutral-800/40'}`}
                  style={{ height: '88px' }}>
                  {/* Checkbox — shown for both owner and readOnly viewers.
                      Parent gates bookmarking props so readOnly selection can
                      only drive export, not bookmark/move/remove. */}
                  <div className="pl-2 pr-0 flex items-center flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={checkedIds.has(item.aTag)}
                      onChange={e => onToggleCheck(item.aTag, e.target.checked)}
                      className="accent-purple-600 cursor-pointer opacity-30 hover:opacity-80 checked:opacity-100 transition-opacity" />
                  </div>
                  <button onClick={() => onSelect(fakeArticle)}
                    className="flex items-center gap-3 px-2 text-left flex-1 min-w-0 h-full">
                    <div className="w-14 h-14 rounded flex-shrink-0 bg-neutral-800 overflow-hidden">
                      {item.image && isSafeUrl(item.image)
                        ? <img src={item.image} alt="" className="w-full h-full object-cover"
                            onError={e => { e.target.style.display = 'none' }} />
                        : <div className="w-full h-full flex items-center justify-center text-neutral-600 text-lg">📄</div>
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate leading-snug ${item.title ? 'text-neutral-100' : 'text-neutral-500 italic'} flex items-center gap-1.5`}>
                        {privacyView === 'private' && (
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"
                            className="text-neutral-500 flex-shrink-0"
                            title="Private bookmark — encrypted, only you see it">
                            <rect x="3" y="7" width="10" height="7" rx="1.2" />
                            <path d="M5 7V5a3 3 0 016 0v2" strokeLinecap="round" />
                          </svg>
                        )}
                        <span className="truncate">{displayTitle}</span>
                      </p>
                      {tagSummary && (
                        <p className="text-xs text-neutral-500 mt-0.5 truncate">{tagSummary}</p>
                      )}
                      <div className="flex items-center gap-1.5 mt-1">
                        {item.authorPic && isSafeUrl(item.authorPic) && (
                          <img src={item.authorPic} alt="" className="w-4 h-4 rounded-full object-cover flex-shrink-0"
                            onError={e => { e.target.style.display = 'none' }} />
                        )}
                        <p className="text-xs text-neutral-600 truncate">{authorDisplay}{authorDisplay && dateStr ? ' · ' : ''}{dateStr}</p>
                      </div>
                    </div>
                  </button>

                  {/* Three-dots menu. Shown when the viewer can DO
                      anything with this item — either they own the list
                      (full edit suite) or they're a logged-in visitor
                      who can at least bookmark it to their own list. */}
                  {(!readOnly || canBookmark) && (
                  <ItemMenuTrigger
                    open={menuOpen}
                    onToggle={() => setItemMenuId(menuOpen ? null : item.aTag)}
                    onClose={() => setItemMenuId(null)}
                    article={menuArticle}
                    title={item.title || ''}
                    image={item.image || ''}
                    tTags={item.tTags || []}
                    lists={pickerLists}
                    onAddToList={canBookmark ? addArticle : null}
                    onCreateList={canBookmark ? createList : null}
                    /* Owner-only ops: move/remove/flip target the
                       VIEWED user's list state — only exposed when the
                       viewer is the owner of that list. */
                    onMoveArticle={!readOnly ? moveArticle : undefined}
                    onRemoveFromList={!readOnly ? removeArticle : undefined}
                    onMovePrivacy={!readOnly ? movePrivacy : undefined}
                    defaultPrivacy={privacyView}
                    authorName={item.author || ''}
                    authorPic={item.authorPic || ''}
                  />
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/**
 * ItemMenuTrigger — small wrapper that owns its own triggerRef so the
 * portaled ArticleActionsMenu can anchor to the exact three-dot button
 * that opened it. Without this, mapping over items would share a single
 * ref across all triggers and the menu would attach to the wrong one.
 */
function ItemMenuTrigger({ open, onToggle, onClose, ...menuProps }) {
  const triggerRef = useRef(null)
  return (
    <div className="flex-shrink-0 pr-2 relative" ref={triggerRef} onMouseDown={e => e.stopPropagation()}>
      <button
        onClick={e => { e.stopPropagation(); onToggle() }}
        className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
        title="Actions"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      <ArticleActionsMenu
        open={open}
        onClose={onClose}
        triggerRef={triggerRef}
        {...menuProps}
      />
    </div>
  )
}
