import { useState, useRef, useEffect, useCallback } from 'react'
import { getNDK } from '../../../../lib/ndk.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import ArticleFeed from './ArticleFeed.jsx'
import ArticleReadPanel from './ArticleReadPanel.jsx'
import AuthorSearch from './AuthorSearch.jsx'
import BulkActionBar from './BulkActionBar.jsx'
import AuthorProfilePanel from './AuthorProfilePanel.jsx'

const MIN_FEED_W = 220
function defaultFeedWidth() {
  return Math.max(MIN_FEED_W, Math.floor(window.innerWidth * 0.30))
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

export default function DiscoverView({ user, lists, addArticle, createList, removeArticle, moveArticle, deleteList, renameList, reorderLists, onLoadInEditor, feedMode, onFeedModeChange, readOnly, requestedAuthor, onRequestedAuthorConsumed }) {

  // ── Selection / filter ────────────────────────────────────────────────────────
  const [selected,    setSelectedRaw]    = useState(null)
  const [titleQuery,  setTitleQuery]  = useState('')

  const pubkey = user?.pubkey || ''

  function setSelected(article) {
    setSelectedRaw(article)
    saveLastArticleId(pubkey, feedMode, article?.id || null)
  }

  // ── Author search state ───────────────────────────────────────────────────────
  const [authorFilter,   setAuthorFilter]   = useState(() => loadLastAuthor(pubkey))
  const [searchResults,  setSearchResults]  = useState([])
  const [searchProfiles, setSearchProfiles] = useState(new Map())
  const [searchLoading,  setSearchLoading]  = useState(false)

  // ── Bookmark group management ─────────────────────────────────────────────────
  const [collapsed,  setCollapsed]  = useState({})
  const [checkedIds, setCheckedIds] = useState(new Set())

  // ── Author feed multi-select ──────────────────────────────────────────────────
  const [searchCheckedIds, setSearchCheckedIds] = useState(new Set())

  // ── Persist last author to localStorage ─────────────────────────────────────
  useEffect(() => { saveLastAuthor(pubkey, authorFilter) }, [authorFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Accept externally-requested author (e.g. "My Articles" from Write tab) ─
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
  useEffect(() => {
    if (feedMode !== 'collection' || !selected?.pubkey) return
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
  }, [feedMode, selected?.pubkey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load author articles when selected ────────────────────────────────────────

  useEffect(() => {
    if (!authorFilter) {
      setSearchResults([])
      setSearchProfiles(new Map())
      return
    }
    loadAuthorArticles(authorFilter.pubkey)
  }, [authorFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAuthorArticles(pubkey) {
    const gen = ++genRef.current
    setSearchLoading(true)
    setSearchResults([])
    setSelectedRaw(null)
    try {
      const ndk = getNDK()

      // Fetch kind 30023 articles BY this author directly from relays
      const events = await Promise.race([
        ndk.fetchEvents({ kinds: [30023], authors: [pubkey] }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000)),
      ])
      if (genRef.current !== gen) return

      // Convert NDKEvent set → array sorted by date
      const articles = Array.from(events).sort((a, b) => b.created_at - a.created_at)

      // Also fetch the author's profile
      const profileEvents = await Promise.race([
        ndk.fetchEvents({ kinds: [0], authors: [pubkey] }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
      ]).catch(() => new Set())
      if (genRef.current !== gen) return

      const profiles = new Map()
      for (const ev of Array.from(profileEvents)) {
        try {
          const p = JSON.parse(ev.content)
          profiles.set(ev.pubkey, { ...p, pubkey: ev.pubkey })
        } catch {}
      }

      setSearchResults(articles)
      setSearchProfiles(profiles)

      // Restore last viewed article if available
      const savedId = loadLastArticleIds(pubkey).search
      if (savedId) {
        const match = articles.find(a => a.id === savedId)
        if (match) setSelectedRaw(match)
      }
    } catch {
      if (genRef.current !== gen) return
    } finally {
      if (genRef.current === gen) setSearchLoading(false)
    }
  }

  // ── Build bookmark articles from reading lists ────────────────────────────────

  function buildBookmarkArticles() {
    const out = []
    for (const list of lists) {
      for (const item of (list.articles || [])) {
        out.push({
          id:          item.aTag,
          pubkey:      item.aTag?.split(':')[1] || '',
          created_at:  Math.floor((item.addedAt || 0) / 1000),
          content:     '',
          tags: [
            ['title', item.title || ''],
            ['image', item.image || ''],
            ['d',     item.aTag?.split(':')[2] || ''],
          ],
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

  const displayArticles = (() => {
    if (feedMode === 'search') return searchResults

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

  const displayProfiles = feedMode === 'search' ? searchProfiles : collectionProfiles

  // ── Respond to mode changes (feedMode is controlled by parent) ─────────────
  const prevFeedModeRef = useRef(feedMode)
  useEffect(() => {
    if (feedMode === prevFeedModeRef.current) return
    prevFeedModeRef.current = feedMode
    setTitleQuery('')
    // Restore last article for the target mode
    const savedIds = loadLastArticleIds(pubkey)
    const savedId = savedIds[feedMode]
    if (savedId) {
      if (feedMode === 'search') {
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
    setSelected(null)
  }

  // ── Panel drag ────────────────────────────────────────────────────────────────

  const startDrag = useCallback((e) => {
    const startX = e.clientX
    const startW = feedWidthRef.current
    function onMove(ev) {
      const maxW = Math.floor(window.innerWidth / 2)
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

  // ── Active author for profile panel (both modes) ───────────────────────────
  const activeProfilePubkey = feedMode === 'search'
    ? authorFilter?.pubkey || null
    : selected?.pubkey || null

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
              <AuthorSearch onSelectAuthor={setAuthorFilter} expanded />
            </div>
          </>
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

      {/* ── Body — persistent 3-pane layout ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left pane — article feed / bookmarks */}
        <div className="flex flex-col overflow-hidden flex-shrink-0"
          style={{ width: `${feedWidth}px` }}>

          {feedMode === 'search' ? (
            authorFilter ? (
              <>
                {searchCheckedIds.size > 0 && (
                  <BulkActionBar
                    articles={displayArticles.filter(a => searchCheckedIds.has(a.id))}
                    profiles={displayProfiles}
                    lists={lists}
                    onAddToList={addArticle}
                    onCreateList={createList}
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
                  lists={lists}
                  onAddToList={addArticle}
                  onCreateList={createList}
                  onLoadInEditor={onLoadInEditor}
                />
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
                lists={lists}
                onAddToList={addArticle}
                onCreateList={createList}
                onMoveArticle={moveArticle}
                onRemoveArticle={removeArticle}
                onClearSelection={() => setCheckedIds(new Set())}
              />
            )}
            {displayArticles.length > 0 && (
              <div className="flex items-center px-3 py-1.5 border-b border-neutral-800/60 flex-shrink-0">
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
              </div>
            )}
            <BookmarksPanel
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
              removeArticle={removeArticle}
              moveArticle={moveArticle}
              deleteList={deleteList}
              renameList={renameList}
              reorderLists={reorderLists}
              onOpenHelp={() => setHelpOpen(true)}
            />
            </>
          )}
        </div>

        {/* Drag handle between feed and center pane */}
        <div onMouseDown={startDrag}
          className="w-1 flex-shrink-0 bg-neutral-800 hover:bg-purple-700 cursor-col-resize transition-colors" />

        {/* Center pane — article reader or empty state */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selected ? (
            <ArticleReadPanel
              key={selected.id}
              article={selected}
              profile={displayProfiles.get(selected.pubkey)}
              lists={lists}
              onAddToList={addArticle}
              onCreateList={createList}
              onMoveArticle={moveArticle}
              onRemoveFromList={selected?._listId ? removeArticle : undefined}
              onLoadInEditor={onLoadInEditor}
              onClose={() => setSelected(null)}
              onAuthorClick={(author) => {
                setAuthorFilter(author)
                onFeedModeChange('search')
                setSelected(null)
              }}
              readOnly={!!user?.readOnly}
              user={user}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-xs text-neutral-700">Select an article to read</p>
            </div>
          )}
        </div>

        {/* Right pane — author profile (always rendered to prevent layout shift) */}
        <div className="flex-shrink-0 border-l border-neutral-800 overflow-y-auto bg-neutral-950" style={{ width: 280 }}>
          {activeProfilePubkey ? (
            <AuthorProfilePanel
              key={activeProfilePubkey}
              profile={displayProfiles.get(activeProfilePubkey)}
              pubkey={activeProfilePubkey}
              user={user}
              onAuthorClick={feedMode !== 'search' ? (author) => {
                setAuthorFilter(author)
                onFeedModeChange('search')
                setSelected(null)
              } : undefined}
            />
          ) : null}
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
        <p className="text-sm text-neutral-300">Search for a Nostr author</p>
        <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">
          Browse their long-form articles and recipes. Bookmark anything you want to keep in your Collection.
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
              <li>Use <span className="text-neutral-300">Author Search</span> here to find and bookmark articles</li>
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

function BookmarksPanel({ lists, titleQuery, collapsed, setCollapsed, selected, onSelect, displayArticles, checkedIds, onToggleCheck, addArticle, createList, removeArticle, moveArticle, deleteList, renameList, reorderLists, onOpenHelp }) {
  const [editingId,     setEditingId]     = useState(null)
  const [editTitle,     setEditTitle]     = useState('')
  const [confirmDel,    setConfirmDel]    = useState(null)
  const [itemMenuId,    setItemMenuId]    = useState(null) // aTag of item with open menu
  const [menuNewGroup,  setMenuNewGroup]  = useState(null) // null | 'move' | 'copy'
  const [menuNewName,   setMenuNewName]   = useState('')

  // Close item menu on outside click
  useEffect(() => {
    if (!itemMenuId) return
    function handler() { setItemMenuId(null); setMenuNewGroup(null); setMenuNewName('') }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [itemMenuId])

  // Set of visible article IDs (filtered by text query)
  const visibleIds = new Set(displayArticles.map(a => a.id))

  if (!lists.length || lists.every(l => !l.articles?.length)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-4">
        <div className="text-3xl text-neutral-700">📚</div>
        <div className="space-y-1.5">
          <p className="text-sm text-neutral-300">Your collection is empty</p>
          <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">
            Bookmark long-form articles and recipes from any Nostr app — they'll appear here.
            Or use <span className="text-neutral-400">Author Search</span> to find and bookmark articles.
          </p>
        </div>
        <button onClick={onOpenHelp}
          className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-500 transition-colors">
          Learn more
        </button>
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
    if (itemMenuId) { setItemMenuId(null); setMenuNewGroup(null); setMenuNewName('') }
  }

  return (
    <div className="overflow-y-auto flex-1" onClick={handlePanelClick}>
      {lists.map((list, listIndex) => {
        const allItems    = list.articles || []
        const items       = allItems.filter(item => visibleIds.has(item.aTag))
        const isCollapsed = !!collapsed[list.id]
        const isEditing   = editingId === list.id
        const isDeleting  = confirmDel === list.id

        return (
          <div key={list.id}>
            {/* Group header */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-neutral-900 border-b border-neutral-800 sticky top-0 z-10">
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
                  <span className="flex-1 truncate">{list.title}</span>
                )}
              </button>
              <span className="text-neutral-700 text-xs flex-shrink-0">
                {items.length !== allItems.length ? `${items.length}/${allItems.length}` : allItems.length}
              </span>
              {!isEditing && !isDeleting && (
                <>
                  {/* Group reorder arrows */}
                  <button onClick={e => { e.stopPropagation(); reorderLists(listIndex, listIndex - 1) }}
                    disabled={listIndex === 0}
                    className="text-neutral-700 hover:text-neutral-400 disabled:opacity-20 transition-colors px-0.5 text-[10px] flex-shrink-0"
                    title="Move group up">▲</button>
                  <button onClick={e => { e.stopPropagation(); reorderLists(listIndex, listIndex + 1) }}
                    disabled={listIndex === lists.length - 1}
                    className="text-neutral-700 hover:text-neutral-400 disabled:opacity-20 transition-colors px-0.5 text-[10px] flex-shrink-0"
                    title="Move group down">▼</button>
                  <button onClick={e => startEdit(list, e)}
                    className="text-neutral-700 hover:text-neutral-400 transition-colors px-1 text-xs flex-shrink-0"
                    title="Rename group">✎</button>
                  <button onClick={e => handleDeleteClick(list.id, e)}
                    className="text-neutral-700 hover:text-red-500 transition-colors px-1 text-xs flex-shrink-0"
                    title="Delete group">✕</button>
                </>
              )}
              {isDeleting && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs text-neutral-500">Delete?</span>
                  <button onClick={() => { deleteList(list.id); setConfirmDel(null) }}
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
              const dateStr = item.addedAt
                ? new Date(item.addedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : ''
              const menuOpen = itemMenuId === item.aTag
              const otherLists = lists.filter(l => l.id !== list.id)

              return (
                <div key={item.aTag}
                  className={`relative flex items-center border-b border-neutral-800/60 transition-colors ${isSelected ? 'bg-purple-950/30' : 'hover:bg-neutral-800/40'}`}
                  style={{ height: '88px' }}>
                  {/* Checkbox */}
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
                    {menuOpen && (
                      <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 min-w-[180px] max-h-[70vh] overflow-y-auto"
                        onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                        {/* Move to */}
                        <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">Move to</p>
                        {otherLists.map(target => (
                          <button key={`mv-${target.id}`}
                            onClick={() => { moveArticle(list.id, target.id, item.aTag); setItemMenuId(null); setMenuNewGroup(null) }}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate">
                            {target.title}
                          </button>
                        ))}
                        {menuNewGroup === 'move' && itemMenuId === item.aTag ? (
                          <div className="px-2 py-1.5 flex gap-1">
                            <input autoFocus type="text" value={menuNewName} onChange={e => setMenuNewName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && menuNewName.trim()) {
                                  (async () => {
                                    const newList = await createList(menuNewName.trim())
                                    moveArticle(list.id, newList.id, item.aTag)
                                    setItemMenuId(null); setMenuNewGroup(null); setMenuNewName('')
                                  })()
                                }
                                if (e.key === 'Escape') setMenuNewGroup(null)
                              }}
                              placeholder="Group name…" maxLength={60}
                              className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none" />
                            <button onClick={async () => {
                              if (!menuNewName.trim()) return
                              const newList = await createList(menuNewName.trim())
                              moveArticle(list.id, newList.id, item.aTag)
                              setItemMenuId(null); setMenuNewGroup(null); setMenuNewName('')
                            }} disabled={!menuNewName.trim()}
                              className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors">✓</button>
                          </div>
                        ) : (
                          <button onClick={() => { setMenuNewGroup('move'); setMenuNewName('') }}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors">
                            + New group
                          </button>
                        )}
                        <div className="border-t border-neutral-700" />

                        {/* Copy to */}
                        <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">Copy to</p>
                        {otherLists.map(target => (
                          <button key={`cp-${target.id}`}
                            onClick={() => {
                              addArticle(target.id, {
                                aTag: item.aTag, title: item.title, image: item.image,
                                author: item.author, authorPic: item.authorPic,
                                addedAt: Date.now(), tTags: item.tTags || [],
                              })
                              setItemMenuId(null); setMenuNewGroup(null)
                            }}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate">
                            {target.title}
                          </button>
                        ))}
                        {menuNewGroup === 'copy' && itemMenuId === item.aTag ? (
                          <div className="px-2 py-1.5 flex gap-1">
                            <input autoFocus type="text" value={menuNewName} onChange={e => setMenuNewName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && menuNewName.trim()) {
                                  (async () => {
                                    const newList = await createList(menuNewName.trim())
                                    addArticle(newList.id, {
                                      aTag: item.aTag, title: item.title, image: item.image,
                                      author: item.author, authorPic: item.authorPic,
                                      addedAt: Date.now(), tTags: item.tTags || [],
                                    })
                                    setItemMenuId(null); setMenuNewGroup(null); setMenuNewName('')
                                  })()
                                }
                                if (e.key === 'Escape') setMenuNewGroup(null)
                              }}
                              placeholder="Group name…" maxLength={60}
                              className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none" />
                            <button onClick={async () => {
                              if (!menuNewName.trim()) return
                              const newList = await createList(menuNewName.trim())
                              addArticle(newList.id, {
                                aTag: item.aTag, title: item.title, image: item.image,
                                author: item.author, authorPic: item.authorPic,
                                addedAt: Date.now(), tTags: item.tTags || [],
                              })
                              setItemMenuId(null); setMenuNewGroup(null); setMenuNewName('')
                            }} disabled={!menuNewName.trim()}
                              className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors">✓</button>
                          </div>
                        ) : (
                          <button onClick={() => { setMenuNewGroup('copy'); setMenuNewName('') }}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors">
                            + New group
                          </button>
                        )}
                        <div className="border-t border-neutral-700" />

                        {/* Remove */}
                        <button
                          onClick={() => { removeArticle(list.id, item.aTag); setItemMenuId(null); setMenuNewGroup(null) }}
                          className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-950/40 transition-colors">
                          Remove from "{list.title}"
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
