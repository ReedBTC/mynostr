import { useState, useEffect, useRef } from 'react'
import Editor from './components/Editor.jsx'
import MetadataDrawer from './components/MetadataDrawer.jsx'
import DraftDrawer from './components/DraftDrawer.jsx'
import DiscoverView from './components/discover/DiscoverView.jsx'
import { useDraft } from '../../lib/useDraft.js'
import { useReadingLists } from '../../lib/useReadingLists.js'
import { useOwnerContext } from '../../lib/ownerContext.jsx'

/**
 * LongformModule — Module 0.
 * Three modes: Write · My Collection · Authors
 * Write tab is always mounted (hidden via CSS) so draft auto-save is preserved.
 * Drafts are auto-restored silently — no banner, just a small discard chip.
 */

function defaultMetadata() {
  return { title: '', summary: '', publishedAtDate: '', image: '', tagsRaw: '', tags: [] }
}
function defaultSource() {
  return { name: '', url: '' }
}

export default function LongformModule({ user, sessionUser }) {
  const { isOwner } = useOwnerContext()

  // ── Module tab: 'write' | 'collection' | 'search' ─────────────────────────
  // Visitors land on "My Collection" (the viewed user's bookmarks) since
  // Write isn't available to them.
  const [moduleTab, setModuleTab] = useState(isOwner ? 'write' : 'mine')

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

  // ── Reading lists ─────────────────────────────────────────────────────────────
  const { lists, createList, addArticle, removeArticle, moveArticle, deleteList, renameList, reorderLists } = useReadingLists(user)

  // If a logged-out visitor somehow lands on the Write tab (e.g. via back
  // button), bounce them to Collection so they don't see a disabled editor.
  useEffect(() => {
    if (!isOwner && (moduleTab === 'write' || moduleTab === 'search')) setModuleTab('mine')
  }, [isOwner, moduleTab])

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
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── Tab bar — always visible ── */}
      <div className="flex items-center gap-0 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
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
          addArticle={addArticle}
          createList={createList}
          removeArticle={removeArticle}
          moveArticle={moveArticle}
          deleteList={deleteList}
          renameList={renameList}
          reorderLists={reorderLists}
          onLoadInEditor={isOwner ? handleLoadArticle : null}
          feedMode={moduleTab === 'write' ? 'collection' : moduleTab}
          onFeedModeChange={setModuleTab}
          readOnly={readOnly}
          requestedAuthor={requestedAuthor}
          onRequestedAuthorConsumed={() => setRequestedAuthor(null)}
        />
      </div>
    </div>
  )
}
