import { useState, useEffect } from 'react'
import Editor from './components/Editor.jsx'
import MetadataForm from './components/MetadataForm.jsx'
import OriginalSourceField from './components/OriginalSourceField.jsx'
import PublishButton from './components/PublishButton.jsx'
import ArticleDrawer from './components/ArticleDrawer.jsx'
import DraftDrawer from './components/DraftDrawer.jsx'
import DiscoverView from './components/discover/DiscoverView.jsx'
import { useDraft, formatDraftAge } from '../../lib/useDraft.js'
import { useReadingLists } from '../../lib/useReadingLists.js'

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

export default function LongformModule({ user }) {
  // ── Module tab: 'write' | 'collection' | 'search' ─────────────────────────
  const [moduleTab, setModuleTab] = useState('write')

  // ── Write-tab state ───────────────────────────────────────────────────────────
  const [content,    setContent]    = useState('')
  const [editorTab,  setEditorTab]  = useState('upload')
  const [metadata,   setMetadata]   = useState(defaultMetadata())
  const [source,     setSource]     = useState(defaultSource())
  const [drawerOpen, setDrawerOpen]       = useState(false)
  const [draftDrawerOpen, setDraftDrawerOpen] = useState(false)
  const [naddr,      setNaddr]      = useState('')

  // Draft restore chip (replaces the old disruptive banner)
  const [draftLoaded,  setDraftLoaded]  = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState(null)

  const readOnly = !!user?.readOnly
  const { saveDraft, loadDraft, clearDraft } = useDraft(user?.pubkey)

  // ── Reading lists ─────────────────────────────────────────────────────────────
  const { lists, createList, addArticle, removeArticle, moveArticle, deleteList, renameList, reorderLists } = useReadingLists(user)

  // ── Auto-restore draft silently on mount ──────────────────────────────────────
  useEffect(() => {
    if (readOnly) return
    const draft = loadDraft()
    if (!draft) return
    setContent(draft.content   || '')
    setMetadata(draft.metadata || defaultMetadata())
    setSource(draft.source     || defaultSource())
    setDraftLoaded(true)
    setDraftSavedAt(draft.savedAt || null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-save ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (readOnly) return
    saveDraft(content, metadata, source)
  }, [content, metadata, source]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Article load from Discover / Drawer ───────────────────────────────────────
  function handleLoadArticle({ content: c, metadata: m, naddr: n = '' }) {
    setContent(c)
    setMetadata(m)
    setSource(defaultSource())
    setNaddr(n)
    setEditorTab('write')
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

  const isWriteActive = moduleTab === 'write'

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── Tab bar — always visible ── */}
      <div className="flex items-center gap-0 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
        <div className="flex items-center gap-0 flex-shrink-0">
          {[
            { id: 'write',      label: 'Write' },
            { id: 'collection', label: 'My Collection' },
            { id: 'search',     label: 'Authors' },
          ].map(({ id, label }, i, arr) => {
            const isActive = moduleTab === id
            const disabled = id === 'write' && readOnly
            return (
              <button key={id}
                onClick={() => !disabled && setModuleTab(id)}
                disabled={disabled}
                className={`text-xs px-2.5 py-1 border transition-colors
                  ${i === 0 ? 'rounded-l' : ''} ${i === arr.length - 1 ? 'rounded-r' : ''}
                  ${disabled
                    ? 'border-neutral-800 text-neutral-700 cursor-not-allowed'
                    : isActive
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
      {drawerOpen && (
        <ArticleDrawer
          user={user}
          onLoad={handleLoadArticle}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      {draftDrawerOpen && (
        <DraftDrawer
          user={user}
          onLoad={handleLoadArticle}
          onClose={() => setDraftDrawerOpen(false)}
        />
      )}

      {/* ── Write tab — always mounted, hidden when inactive ── */}
      <div
        className="flex flex-1 overflow-hidden"
        style={{ display: isWriteActive ? 'flex' : 'none' }}
      >
        {/* Editor column */}
        <div className="flex-1 flex flex-col overflow-hidden border-r border-neutral-800">
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800">

            {/* Draft chip — only visible when content was auto-restored from storage */}
            {draftLoaded && !readOnly && (
              <div className="ml-auto flex items-center gap-1.5 text-xs text-neutral-600 border border-neutral-800 rounded px-2 py-1">
                <span>
                  Draft{draftSavedAt ? ` · ${formatDraftAge(draftSavedAt)}` : ''}
                </span>
                <button
                  onClick={handleDiscardDraft}
                  className="hover:text-red-500 transition-colors leading-none"
                  aria-label="Discard draft"
                >
                  ×
                </button>
              </div>
            )}
          </div>

          <Editor
            content={content}
            onChange={setContent}
            activeTab={editorTab}
            onTabChange={setEditorTab}
            metadata={metadata}
            source={source}
            onClear={handlePublishAnother}
            onFileLoad={handleLoadArticle}
            readOnly={readOnly}
            user={user}
            naddr={naddr}
            onOpenDrawer={readOnly ? null : () => setDrawerOpen(true)}
            onOpenDraftDrawer={readOnly ? null : () => setDraftDrawerOpen(true)}
          />
        </div>

        {/* Sidebar */}
        <div className="w-80 flex flex-col overflow-y-auto bg-neutral-950">
          <MetadataForm metadata={metadata} onChange={setMetadata} readOnly={readOnly} />
          <OriginalSourceField
            source={source}
            onChange={setSource}
            metadata={metadata}
            onMetadataChange={setMetadata}
            readOnly={readOnly}
          />
          <div className="p-4 mt-auto border-t border-neutral-800">
            <PublishButton
              content={content}
              metadata={metadata}
              source={source}
              user={user}
              onPublishAnother={handlePublishAnother}
              onPublishSuccess={clearDraft}
              readOnly={readOnly}
            />
          </div>
        </div>
      </div>

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
          onLoadInEditor={handleLoadArticle}
          feedMode={moduleTab === 'write' ? 'collection' : moduleTab}
          onFeedModeChange={setModuleTab}
          readOnly={readOnly}
        />
      </div>
    </div>
  )
}
