import { useState, useRef, useEffect, useCallback } from 'react'
import { useIsMobile } from '../../../../hooks/useIsMobile.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
// Trust note: events returned by Primal are rendered without local signature
// verification (same model as Primal's own clients). A compromised Primal
// could display fabricated articles, but we never sign or publish based on
// them — the blast radius is display-layer disinformation only.
import { fetchAuthorLongformFeed } from '../../../../lib/primal.js'
import { isSafeUrl, getPublishedAt, withTimeout } from '../../../../lib/utils.js'
import { useReadingLists } from '../../../../lib/useReadingLists.js'
import ArticleFeed from './ArticleFeed.jsx'
import ArticleReadPanel from './ArticleReadPanel.jsx'
import AuthorSearch from './AuthorSearch.jsx'
import BulkActionBar from './BulkActionBar.jsx'
import ArticleActionsMenu from './ArticleActionsMenu.jsx'

const MIN_FEED_W = 220
const MIN_READER_W = 320
function defaultFeedWidth() {
  return Math.max(MIN_FEED_W, Math.floor(window.innerWidth / 2))
}

function authorKey(pubkey) { return `mynostr_last_author_${pubkey}` }
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

export default function DiscoverView({ user, lists, addArticle, addArticlesBulk, createList, removeArticle, removeArticlesBulk, moveArticle, moveArticlesBulk, deleteList, renameList, reorderLists, hiddenIds, hideList, unhideList, onLoadInEditor, feedMode, onFeedModeChange, readOnly, requestedAuthor, onRequestedAuthorConsumed }) {

  // Below md:, the two-pane layout collapses to one-pane-at-a-time: the feed
  // until an article is picked, then the reader (with a back arrow) until
  // dismissed. Desktop keeps its resizable side-by-side layout.
  const isMobile = useIsMobile()

  // ── Selection / filter ────────────────────────────────────────────────────────
  const [selected,    setSelectedRaw]    = useState(null)
  const [titleQuery,  setTitleQuery]  = useState('')

  const pubkey = user?.pubkey || ''

  function setSelected(article) {
    setSelectedRaw(article)
    // Only persist browsing state on the owner's own page — otherwise every
    // visited author leaves residue keyed by *their* pubkey in localStorage,
    // which is both unbounded growth and a behavioral leak on shared devices.
    if (!readOnly) saveLastArticleId(pubkey, feedMode, article?.id || null)
  }

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
        const events = await Promise.race([
          ndk.fetchEvents({ kinds: [0], authors: [selected.pubkey] }),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
        ])
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
      // Primal's indexer has every author's articles pre-collected from all
      // the relays it crawls — single fast WebSocket call, no EOSE timing
      // games. This is the primary source.
      const primal = await fetchAuthorLongformFeed(authorPubkey, null, 100)
      if (genRef.current !== gen) return

      let articles = dedupeReplaceable(primal.articles || [])
        .sort((a, b) => getPublishedAt(b) - getPublishedAt(a))
      const profiles = new Map(primal.profiles || new Map())

      // Show Primal results immediately — the common case is "done".
      if (articles.length > 0) {
        setSearchResults(articles)
        setSearchProfiles(profiles)
        setSearchLoading(false)
        restoreSelectedFromSaved(articles)
      }

      // Fallback only when Primal returned nothing (rare — brand-new author,
      // or Primal outage). Don't block the UI on it.
      if (articles.length === 0) {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        if (genRef.current !== gen) return

        const articleSub = trackSub(collectFromRelays(
          ndk, { kinds: [30023], authors: [authorPubkey] }, 3000
        ))
        const rawArticles = await articleSub.promise
        if (genRef.current !== gen) return

        articles = dedupeReplaceable(rawArticles)
          .sort((a, b) => getPublishedAt(b) - getPublishedAt(a))
        setSearchResults(articles)
        restoreSelectedFromSaved(articles)
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

  function buildBookmarkArticles(listsToUse = lists) {
    const out = []
    for (const list of (listsToUse || [])) {
      for (const item of (list.articles || [])) {
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
    if (inAuthorCollectionView) return buildBookmarkArticles(authorCollection.lists)
    if (isAuthorFeed) return searchResults

    const items = buildBookmarkArticles()
    const lq = titleQuery.trim().toLowerCase()
    if (!lq) return items
    return items.filter(a => {
      const title  = (a.tags?.find(t => t[0] === 'title')?.[1] || '').toLowerCase()
      const author = (a._authorName || '').toLowerCase()
      const listTitle = (a._listTitle || '').toLowerCase()
      return title.includes(lq) || author.includes(lq) || listTitle.includes(lq)
    })
  })()

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
                {/* Author/Collection pill — search mode only. 'mine' pins the
                    viewing user so a "their bookmarks" view would just duplicate
                    the Collection tab. */}
                {feedMode === 'search' && (
                  <div className="flex items-center px-3 py-1.5 border-b border-neutral-800/60 flex-shrink-0">
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
                  </div>
                )}

                {searchCheckedIds.size > 0 && (
                  <BulkActionBar
                    articles={displayArticles.filter(a => searchCheckedIds.has(a.id))}
                    profiles={displayProfiles}
                    lists={readOnly ? [] : lists}
                    onAddToList={readOnly ? null : addArticle}
                    onAddManyToList={readOnly ? null : addArticlesBulk}
                    onCreateList={readOnly ? null : createList}
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
                      lists={authorCollection.lists}
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
                      addArticle={undefined}
                      createList={undefined}
                      deleteList={undefined}
                      renameList={undefined}
                      reorderLists={undefined}
                      hiddenIds={undefined}
                      hideList={undefined}
                      unhideList={undefined}
                      readOnly={true}
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
                    lists={readOnly ? null : lists}
                    onAddToList={readOnly ? null : addArticle}
                    onCreateList={readOnly ? null : createList}
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
                lists={readOnly ? [] : lists}
                onAddToList={readOnly ? null : addArticle}
                onAddManyToList={readOnly ? null : addArticlesBulk}
                onCreateList={readOnly ? null : createList}
                onMoveArticle={readOnly ? null : moveArticle}
                onMoveArticlesBulk={readOnly ? null : moveArticlesBulk}
                onRemoveArticle={readOnly ? null : removeArticle}
                onRemoveArticlesBulk={readOnly ? null : removeArticlesBulk}
                onClearSelection={() => setCheckedIds(new Set())}
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
              createList={createList}
              deleteList={deleteList}
              renameList={renameList}
              reorderLists={reorderLists}
              hiddenIds={hiddenIds}
              hideList={hideList}
              unhideList={unhideList}
              readOnly={readOnly}
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
          {selected ? (
            <ArticleReadPanel
              key={selected.id}
              article={selected}
              profile={displayProfiles.get(selected.pubkey)}
              lists={readOnly ? null : lists}
              onAddToList={readOnly ? null : addArticle}
              onCreateList={readOnly ? null : createList}
              onMoveArticle={readOnly ? null : moveArticle}
              onRemoveFromList={!readOnly && selected?._listId ? removeArticle : undefined}
              onLoadInEditor={onLoadInEditor}
              onClose={() => setSelected(null)}
              onAuthorClick={(author) => {
                pickSearchAuthor(author)
                onFeedModeChange('search')
                setSelected(null)
              }}
              readOnly={readOnly}
              user={user}
              isMobile={isMobile}
            />
          ) : (
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

function BookmarksPanel({ lists, titleQuery, collapsed, setCollapsed, selected, onSelect, displayArticles, checkedIds, onToggleCheck, addArticle, createList, deleteList, renameList, reorderLists, hiddenIds, hideList, unhideList, readOnly, onOpenHelp, manageMode }) {
  const [editingId,     setEditingId]     = useState(null)
  const [editTitle,     setEditTitle]     = useState('')
  const [confirmDel,    setConfirmDel]    = useState(null)
  const [itemMenuId,    setItemMenuId]    = useState(null) // aTag of item with open menu

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
  if (!lists.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-4">
        <div className="text-3xl text-neutral-700">📚</div>
        <div className="space-y-1.5">
          {readOnly ? (
            <>
              <p className="text-sm text-neutral-300">No public bookmarks</p>
              <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">
                This user hasn't published any public reading lists yet.
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
        {!readOnly && (
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

  function commitEdit(list) {
    const t = editTitle.trim()
    if (t && t !== list.title) renameList(list.id, t)
    setEditingId(null)
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

        const allItems    = list.articles || []
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
                  <button onClick={() => { deleteList(list.id); setConfirmDel(null) }}
                    title="Items will move to Ungrouped"
                    className="text-xs text-red-500 hover:text-red-400 transition-colors px-1">Yes</button>
                  <button onClick={() => setConfirmDel(null)}
                    className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors px-1">No</button>
                </div>
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
              const otherLists = lists.filter(l => l.id !== list.id)

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
                      <p className={`text-sm font-medium truncate leading-snug ${item.title ? 'text-neutral-100' : 'text-neutral-500 italic'}`}>
                        {displayTitle}
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

                  {/* Three-dots menu */}
                  {!readOnly && (
                  <div className="flex-shrink-0 pr-2 relative" onMouseDown={e => e.stopPropagation()}>
                    <button
                      onClick={e => { e.stopPropagation(); setItemMenuId(menuOpen ? null : item.aTag) }}
                      className="w-7 h-7 flex items-center justify-center rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
                      title="Actions">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="3" r="1.5" />
                        <circle cx="8" cy="8" r="1.5" />
                        <circle cx="8" cy="13" r="1.5" />
                      </svg>
                    </button>
                    <ArticleActionsMenu
                      open={menuOpen}
                      onClose={() => setItemMenuId(null)}
                      article={fakeArticle}
                      title={item.title || ''}
                      image={item.image || ''}
                      tTags={item.tTags || []}
                      lists={otherLists}
                      onAddToList={addArticle}
                      onCreateList={createList}
                      authorName={item.author || ''}
                      authorPic={item.authorPic || ''}
                    />
                  </div>
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
