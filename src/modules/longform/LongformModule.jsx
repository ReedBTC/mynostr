import { useState, useEffect } from 'react'
import Editor from './components/Editor.jsx'
import MetadataForm from './components/MetadataForm.jsx'
import OriginalSourceField from './components/OriginalSourceField.jsx'
import PublishButton from './components/PublishButton.jsx'
import ArticleDrawer from './components/ArticleDrawer.jsx'
import HelpModal from './components/HelpModal.jsx'
import DraftBanner from './components/DraftBanner.jsx'
import { useDraft } from '../../lib/useDraft.js'

/**
 * LongformModule — Module 0.
 * Direct port of nostrmd's core editor experience (kind 30023 articles).
 * Lives inside AppShell; receives the authenticated user object as a prop.
 */

function defaultMetadata() {
  return { title: '', summary: '', publishedAtDate: '', image: '', tagsRaw: '', tags: [] }
}

function defaultSource() {
  return { name: '', url: '' }
}

export default function LongformModule({ user }) {
  const [content, setContent]       = useState('')
  const [activeTab, setActiveTab]   = useState('upload')
  const [metadata, setMetadata]     = useState(defaultMetadata())
  const [source, setSource]         = useState(defaultSource())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [helpOpen, setHelpOpen]     = useState(false)
  const [pendingDraft, setPendingDraft] = useState(null)
  const [naddr, setNaddr]           = useState('')

  const readOnly = !!user?.readOnly
  const { saveDraft, loadDraft, clearDraft } = useDraft(user?.pubkey)

  // Check for a saved draft on mount
  useEffect(() => {
    if (readOnly) return
    const draft = loadDraft()
    if (draft) setPendingDraft(draft)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save on every change
  useEffect(() => {
    if (readOnly) return
    saveDraft(content, metadata, source)
  }, [content, metadata, source]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleRestoreDraft() {
    if (!pendingDraft) return
    setContent(pendingDraft.content || '')
    setMetadata(pendingDraft.metadata || defaultMetadata())
    setSource(pendingDraft.source || defaultSource())
    setActiveTab('write')
    setPendingDraft(null)
  }

  function handleLoadArticle({ content: c, metadata: m, naddr: n = '' }) {
    setContent(c)
    setMetadata(m)
    setSource(defaultSource())
    setNaddr(n)
    setActiveTab('write')
  }

  function handlePublishAnother() {
    clearDraft()
    setContent('')
    setMetadata(defaultMetadata())
    setSource(defaultSource())
    setNaddr('')
  }

  return (
    <div className="flex flex-1 overflow-hidden">

      {/* Draft restore banner */}
      {pendingDraft && (
        <DraftBanner
          draft={pendingDraft}
          onRestore={handleRestoreDraft}
          onDiscard={() => { clearDraft(); setPendingDraft(null) }}
        />
      )}

      {/* Help modal */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      {/* Article drawer */}
      {drawerOpen && (
        <ArticleDrawer
          user={user}
          onLoad={handleLoadArticle}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {/* Editor — takes remaining width */}
      <div className="flex-1 flex flex-col overflow-hidden border-r border-neutral-800">
        {/* Toolbar row */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800">
          <button
            onClick={() => setDrawerOpen(true)}
            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
          >
            My Articles
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
          >
            ?
          </button>
        </div>

        <Editor
          content={content}
          onChange={setContent}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          metadata={metadata}
          source={source}
          onClear={handlePublishAnother}
          onFileLoad={handleLoadArticle}
          readOnly={readOnly}
          user={user}
          naddr={naddr}
        />
      </div>

      {/* Sidebar: metadata + source + publish */}
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
  )
}
