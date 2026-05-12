import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ShareButton from '../../components/ShareButton.jsx'
import Editor from './components/Editor.jsx'
import MetadataDrawer from './components/MetadataDrawer.jsx'
import DraftDrawer from './components/DraftDrawer.jsx'
import DiscoverView from './components/discover/DiscoverView.jsx'
import { useDraft } from '../../lib/useDraft.js'
import { useReadingLists } from '../../lib/useReadingLists.js'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import { ArticleBookmarksProvider } from './articleBookmarksContext.jsx'

/**
 * ArticlesModule — Module 0.
 * Three modes: Write · My Collection · Authors
 * Write tab is always mounted (hidden via CSS) so draft auto-save is preserved.
 * Drafts are auto-restored silently — no banner, just a small discard chip.
 * Routes kind 30023 "longform" content per NIP-23 — the URL/label is
 * "articles" because that's what users think of them as; internal variable
 * names still use "longform" where they describe the Nostr kind itself.
 */

function defaultMetadata() {
  return { title: '', summary: '', publishedAtDate: '', image: '', tagsRaw: '', tags: [] }
}
function defaultSource() {
  return { name: '', url: '' }
}

export default function ArticlesModule({ user, sessionUser, subtab }) {
  const { isOwner } = useOwnerContext()
  const navigate = useNavigate()
  const npub = user?.npub

  // ── Module tab derived from URL subtab ──────────────────────────────────
  // Unknown / owner-only subtabs visited by a non-owner fall through to the
  // default (see the bounce effect below). Bare `/articles` always means
  // the My Articles feed — Write has its own URL so the tab button and
  // shareable links both land consistently on the feed view.
  const moduleTab = (() => {
    if (subtab === 'mine') return 'mine'
    if (subtab === 'collection') return 'collection'
    if (subtab === 'search' && isOwner) return 'search'
    if (subtab === 'write' && isOwner) return 'write'
    return 'mine'
  })()

  // `mine` is the default view — map it to the bare /articles URL for
  // consistency with NotesModule's `notes` case, so the tab-button and
  // shareable-link shapes match across modules.
  const setModuleTab = useCallback((id) => {
    if (!npub) return
    const path = id === 'mine' ? `/${npub}/articles` : `/${npub}/articles/${id}`
    navigate(path)
  }, [npub, navigate])

  // ── Write-tab state ───────────────────────────────────────────────────────────
  const [content,    setContent]    = useState('')
  const [metadata,   setMetadata]   = useState(defaultMetadata())
  const [source,     setSource]     = useState(defaultSource())
  const [draftDrawerOpen,    setDraftDrawerOpen]    = useState(false)
  const [metadataDrawerOpen, setMetadataDrawerOpen] = useState(false)
  const metadataButtonRef = useRef(null)
  const [requestedAuthor, setRequestedAuthor] = useState(null)
  const [naddr,      setNaddr]      = useState('')

  // Draft restore chip (replaces the old disruptive banner)
  const [draftLoaded,  setDraftLoaded]  = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState(null)

  // Writes go through the *session* user (who can sign); the viewed user
  // may be someone else entirely. When !isOwner, drafts are disabled.
  const readOnly = !isOwner
  const draftPubkey = isOwner ? sessionUser?.pubkey : null
  const { saveDraft, loadDraft, clearDraft } = useDraft(draftPubkey)

  // ── Reading lists ─────────────────────────────────────────────────────
  // Session hook — the sole source of truth for MY reading lists + every
  // write. Exposed to the whole module tree via ArticleBookmarksContext so
  // three-dot menus, the reader pane, and bulk-action bars all land writes
  // here and see the resulting state change immediately (no stale display).
  // Matches NotesModule's single-context pattern.
  const canBookmark = !!sessionUser?.pubkey && !sessionUser?.readOnly
  const viewingOwnPage = canBookmark && sessionUser.pubkey === user?.pubkey
  const sessionHook = useReadingLists(canBookmark ? sessionUser : null)

  // Visitor read-only hook — loads the *viewed* user's lists so their
  // public Collection renders in the left panel. Gated on !viewingOwnPage
  // so on my own page we don't run a second concurrent fetch for the same
  // pubkey; that would give us two independent state copies of the same
  // data, and a write through the session hook (via the context) wouldn't
  // show up in the owner's Collection until the second instance refetched
  // on reload — exactly the stale-display bug.
  const viewedHook = useReadingLists(
    viewingOwnPage ? null : (user ? { ...user, readOnly: true } : null)
  )

  // Display source: session hook on my own page (so writes propagate
  // live into the Collection view), viewed hook when visiting someone
  // else (readOnly; owner mutators become no-ops automatically).
  const {
    lists, privateDecryptFailed, privateDecryptInProgress, decryptDiagnostic, retryDecrypt,
    removeArticle, removeArticlesBulk,
    moveArticle, moveArticlesBulk,
    movePrivacy, bulkMovePrivacy,
    deleteList, renameList, reorderLists,
    hiddenIdsByView, hideList, unhideList,
  } = viewingOwnPage ? sessionHook : viewedHook

  const bookmarksContextValue = {
    myLists:         sessionHook.lists,
    loading:         sessionHook.loading,
    addArticle:      sessionHook.addArticle,
    addArticlesBulk: sessionHook.addArticlesBulk,
    createList:      sessionHook.createList,
    // Remove-from-my-list needs to be reachable from every surface that
    // shows "Remove from bookmarks" (reader pane + three-dot menu),
    // including when the article was found via search rather than opened
    // from the user's own Collection. Routing it through the context so
    // the target is always MY lists (session), not the viewed user's.
    removeArticle:   sessionHook.removeArticle,
    canBookmark,
  }

  // If a visitor lands on an owner-only URL (e.g. /articles/write via stale
  // share or browser back after logout), redirect to the default view.
  useEffect(() => {
    if (!isOwner && (subtab === 'write' || subtab === 'search') && npub) {
      navigate(`/${npub}/articles`, { replace: true })
    }
  }, [isOwner, subtab, npub, navigate])

  // ── Auto-restore draft silently on mount ──────────────────────────────────────
  useEffect(() => {
    if (!isOwner) return
    const draft = loadDraft()
    if (!draft) return
    setContent(draft.content   || '')
    setMetadata(draft.metadata || defaultMetadata())
    setSource(draft.source     || defaultSource())
    setDraftLoaded(true)
    setDraftSavedAt(draft.savedAt || null)
  }, [isOwner]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-save ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOwner) return
    saveDraft(content, metadata, source)
  }, [content, metadata, source, isOwner]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draft discard ─────────────────────────────────────────────────────────────
  function handleDiscardDraft() {
    clearDraft()
    setContent('')
    setMetadata(defaultMetadata())
    setSource(defaultSource())
    setNaddr('')
    setDraftLoaded(false)
    setDraftSavedAt(null)
  }

  // ── Article load from Discover / Drawer / naddr input ────────────────────────
  function handleLoadArticle({ content: c, metadata: m, naddr: n = '' }) {
    setContent(c)
    setMetadata(m)
    setSource(defaultSource())
    setNaddr(n)
    setModuleTab('write')
  }

  // ── Post-publish reset ────────────────────────────────────────────────────────
  function handlePublishAnother() {
    clearDraft()
    setContent('')
    setMetadata(defaultMetadata())
    setSource(defaultSource())
    setNaddr('')
    setDraftLoaded(false)
    setDraftSavedAt(null)
  }

  // Whenever the "Articles" tab is (re)activated, pin the author filter to the
  // viewed user. Re-runs on tab change so a detour through Authors can't
  // leave the wrong author locked in.
  useEffect(() => {
    if (moduleTab !== 'mine') return
    if (!user?.pubkey) return
    const profile = user?.profile || {}
    setRequestedAuthor({
      pubkey: user.pubkey,
      name: profile.displayName || profile.name || '',
      picture: profile.picture || '',
    })
  }, [moduleTab, user?.pubkey]) // eslint-disable-line react-hooks/exhaustive-deps

  const isWriteActive = moduleTab === 'write' && isOwner

  // "My Articles" when you're viewing your own page, "Articles" when visiting
  // someone else — the label reflects whose page it is, not who's logged in.
  const myArticlesLabel = isOwner ? 'My Articles' : 'Articles'

  const visibleTabs = isOwner
    ? [
        { id: 'write',      label: 'Write' },
        { id: 'mine',       label: myArticlesLabel },
        { id: 'collection', label: 'My Collection' },
        { id: 'search',     label: 'Search' },
      ]
    : [
        { id: 'mine',       label: myArticlesLabel },
        { id: 'collection', label: 'Collection' },
      ]

  return (
    <ArticleBookmarksProvider value={bookmarksContextValue}>
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── Tab bar — always visible ── */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
        <div className="flex items-center gap-0 flex-shrink-0">
          {visibleTabs.map(({ id, label }, i, arr) => {
            const isActive = moduleTab === id
            return (
              <button key={id}
                onClick={() => setModuleTab(id)}
                className={`text-xs px-2.5 py-1 border transition-colors
                  ${i === 0 ? 'rounded-l' : ''} ${i === arr.length - 1 ? 'rounded-r' : ''}
                  ${isActive
                    ? 'bg-neutral-800 border-neutral-600 text-neutral-200'
                    : 'border-neutral-800 text-neutral-600 hover:text-neutral-400'
                  }`}>
                {label}
              </button>
            )
          })}
        </div>
        {/* Share is hidden on Write/Search — Write isn't a shareable
            surface, and Search is owner-only (visitors get redirected). */}
        {moduleTab !== 'write' && moduleTab !== 'search' && (
          <div className="shrink-0">
            <ShareButton variant="button" />
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      {draftDrawerOpen && (
        <DraftDrawer
          user={user}
          onLoad={handleLoadArticle}
          onClose={() => setDraftDrawerOpen(false)}
        />
      )}

      {/* ── Write tab — only mounted for the page owner ── */}
      {isOwner && (
        <div
          className="flex flex-1 overflow-hidden"
          style={{ display: isWriteActive ? 'flex' : 'none' }}
        >
          <Editor
            content={content}
            onChange={setContent}
            metadata={metadata}
            source={source}
            onClear={handlePublishAnother}
            onFileLoad={handleLoadArticle}
            readOnly={readOnly}
            user={user}
            naddr={naddr}
            onOpenDraftDrawer={() => setDraftDrawerOpen(true)}
            onToggleMetadata={() => setMetadataDrawerOpen(o => !o)}
            metadataOpen={metadataDrawerOpen}
            metadataButtonRef={metadataButtonRef}
          />
        </div>
      )}

      {/* Metadata drawer — only mounted while Write tab is active */}
      {isOwner && isWriteActive && metadataDrawerOpen && (
        <MetadataDrawer
          onClose={() => setMetadataDrawerOpen(false)}
          excludeRef={metadataButtonRef}
          draftLoaded={draftLoaded}
          draftSavedAt={draftSavedAt}
          onDiscardDraft={handleDiscardDraft}
          metadata={metadata}
          onMetadataChange={setMetadata}
          source={source}
          onSourceChange={setSource}
          content={content}
          user={user}
          readOnly={readOnly}
          onPublishAnother={handlePublishAnother}
          onPublishSuccess={() => { clearDraft(); setMetadataDrawerOpen(false) }}
        />
      )}

      {/* ── Discover view — always mounted, hidden when Write is active ── */}
      <div
        className="flex flex-1 overflow-hidden"
        style={{ display: !isWriteActive ? 'flex' : 'none' }}
      >
        <DiscoverView
          user={user}
          lists={lists}
          privateDecryptFailed={privateDecryptFailed}
          privateDecryptInProgress={privateDecryptInProgress}
          decryptDiagnostic={decryptDiagnostic}
          retryDecrypt={retryDecrypt}
          removeArticle={removeArticle}
          removeArticlesBulk={removeArticlesBulk}
          moveArticle={moveArticle}
          moveArticlesBulk={moveArticlesBulk}
          movePrivacy={movePrivacy}
          bulkMovePrivacy={bulkMovePrivacy}
          deleteList={deleteList}
          renameList={renameList}
          reorderLists={reorderLists}
          hiddenIdsByView={hiddenIdsByView}
          hideList={hideList}
          unhideList={unhideList}
          onLoadInEditor={isOwner ? handleLoadArticle : null}
          feedMode={moduleTab === 'write' ? 'collection' : moduleTab}
          onFeedModeChange={setModuleTab}
          readOnly={readOnly}
          requestedAuthor={requestedAuthor}
          onRequestedAuthorConsumed={() => setRequestedAuthor(null)}
        />
      </div>
    </div>
    </ArticleBookmarksProvider>
  )
}
