/**
 * DraftsTray — list pane for the Notes Write multi-draft workflow.
 *
 * Desktop: slim left column, always visible, rows = drafts.
 * Mobile: hidden by default; a "Drafts (N)" chip in the composer opens
 * the same list as a bottom sheet.
 *
 * Each row shows: first line of content (or "Untitled"), status dot,
 * and a trash icon. Clicking the row sets that draft as current.
 *
 * "+ New" seeds an empty draft and focuses it. "Publish all" opens a
 * confirmation modal before iterating through every draft with text.
 */
import { useState } from 'react'

function previewText(content) {
  const trimmed = (content || '').trim()
  if (!trimmed) return 'Empty draft'
  const firstLine = trimmed.split('\n')[0]
  return firstLine.length > 48 ? firstLine.slice(0, 48) + '…' : firstLine
}

function StatusDot({ status }) {
  const cls =
    status === 'publishing' ? 'bg-amber-400 animate-pulse'
      : status === 'published' ? 'bg-green-500'
      : status === 'failed'    ? 'bg-red-500'
      : 'bg-neutral-600'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} aria-hidden />
}

function TrashIcon({ className = 'w-3 h-3' }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.664 8.093A1.75 1.75 0 0 0 5.457 15h5.086a1.75 1.75 0 0 0 1.743-1.407L12.95 5.5h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm1.5 0A.75.75 0 0 1 7.25 2.5h1.5a.75.75 0 0 1 .75.75V4h-3V3.25Z" clipRule="evenodd" />
    </svg>
  )
}

function ConfirmPublishAll({ count, onCancel, onConfirm }) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-sm p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium text-neutral-100 mb-1.5">
          Publish {count} draft{count === 1 ? '' : 's'}?
        </h3>
        <p className="text-xs text-neutral-400 mb-4">
          Each draft will be signed and published in order. This can't be undone —
          notes on Nostr relays aren't reliably deletable.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors"
          >
            Publish all
          </button>
        </div>
      </div>
    </div>
  )
}

function DraftRow({ draft, isCurrent, onSelect, onDelete }) {
  return (
    <div
      onClick={onSelect}
      className={`group flex items-start gap-2 px-2.5 py-2 rounded cursor-pointer transition-colors ${
        isCurrent
          ? 'bg-purple-950/40 border border-purple-800/60'
          : 'border border-transparent hover:bg-neutral-800/60'
      }`}
    >
      <StatusDot status={draft.status} />
      <div className="flex-1 min-w-0">
        <p className={`text-xs truncate ${isCurrent ? 'text-neutral-100' : 'text-neutral-400'}`}>
          {previewText(draft.snapshot?.content)}
        </p>
        {draft.status === 'failed' && draft.publishError && (
          <p className="text-[10px] text-red-400 mt-0.5 truncate">{draft.publishError}</p>
        )}
        {draft.status === 'published' && (
          <p className="text-[10px] text-green-500 mt-0.5">Published</p>
        )}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete() }}
        title="Delete draft"
        className="shrink-0 text-neutral-500 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-1 -m-1"
      >
        <TrashIcon />
      </button>
    </div>
  )
}

export default function DraftsTray({
  drafts,
  currentDraftId,
  onSelectDraft,
  onCreateDraft,
  onDeleteDraft,
  onPublishAll,
  isMobileOpen = false,
  onMobileClose,
  isMobile = false,
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const publishable = drafts.filter(d => d.publishable?.content?.trim() && d.status !== 'published')
  const anyPublishing = drafts.some(d => d.status === 'publishing')

  function requestPublishAll() {
    if (publishable.length === 0 || anyPublishing) return
    setConfirmOpen(true)
  }
  function doPublishAll() {
    setConfirmOpen(false)
    onPublishAll()
    if (isMobile && onMobileClose) onMobileClose()
  }

  const list = (
    <>
      <div className="flex items-center justify-between gap-1.5 px-2.5 py-2 border-b border-neutral-800">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500 font-medium">
          Drafts ({drafts.length})
        </span>
        <button
          onClick={() => { onCreateDraft(); if (isMobile && onMobileClose) onMobileClose() }}
          title="New draft (Cmd/Ctrl+N)"
          className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5">
        {drafts.map(d => (
          <DraftRow
            key={d.id}
            draft={d}
            isCurrent={d.id === currentDraftId}
            onSelect={() => {
              onSelectDraft(d.id)
              if (isMobile && onMobileClose) onMobileClose()
            }}
            onDelete={() => onDeleteDraft(d.id)}
          />
        ))}
      </div>

      <div className="border-t border-neutral-800 p-2">
        <button
          onClick={requestPublishAll}
          disabled={publishable.length === 0 || anyPublishing}
          className="w-full text-xs py-1.5 rounded bg-purple-700/90 hover:bg-purple-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white transition-colors"
        >
          {anyPublishing ? 'Publishing…' : `Publish all (${publishable.length})`}
        </button>
      </div>
    </>
  )

  if (isMobile) {
    if (!isMobileOpen) return null
    return (
      <>
        <div
          className="fixed inset-0 bg-black/60 z-40"
          onClick={onMobileClose}
        />
        <div
          className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-neutral-700 rounded-t-lg z-50 flex flex-col"
          style={{ maxHeight: '70vh' }}
        >
          {list}
        </div>
        {confirmOpen && (
          <ConfirmPublishAll
            count={publishable.length}
            onCancel={() => setConfirmOpen(false)}
            onConfirm={doPublishAll}
          />
        )}
      </>
    )
  }

  return (
    <aside className="hidden md:flex flex-col w-[200px] flex-shrink-0 border-r border-neutral-800 bg-neutral-900/40">
      {list}
      {confirmOpen && (
        <ConfirmPublishAll
          count={publishable.length}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={doPublishAll}
        />
      )}
    </aside>
  )
}
