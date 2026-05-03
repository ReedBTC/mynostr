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
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isSchedulerConfigured,
  listScheduled,
  cancelScheduled,
  readLocalScheduled,
} from '../../../lib/scheduler.js'

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

function ConfirmDialog({ title, body, confirmLabel, confirmTone = 'purple', onCancel, onConfirm }) {
  const confirmClass = confirmTone === 'red'
    ? 'bg-red-600 hover:bg-red-500'
    : 'bg-purple-600 hover:bg-purple-500'
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-sm p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium text-neutral-100 mb-1.5">{title}</h3>
        <p className="text-xs text-neutral-400 mb-4">{body}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`text-xs px-3 py-1.5 rounded text-white font-semibold transition-colors ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function DraftRow({ draft, isCurrent, index, total, onSelect, onDelete, onMove }) {
  // Row swaps to an inline confirm panel on trash click — the visual change
  // is big enough that the "click again" requirement is obvious, and the
  // explicit Cancel button gives an easy out. Auto-resets after 4s.
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!pending) return
    const id = setTimeout(() => setPending(false), 4000)
    return () => clearTimeout(id)
  }, [pending])

  if (pending) {
    return (
      <div className="px-2.5 py-2 rounded bg-red-950/40 border border-red-900/60">
        <p className="text-xs text-red-300 mb-1.5 truncate">
          Delete draft: <span className="text-red-200">{previewText(draft.snapshot?.content)}</span>
        </p>
        <div className="flex gap-1.5">
          <button
            onClick={() => setPending(false)}
            className="flex-1 text-[11px] text-neutral-300 hover:text-neutral-100 px-2 py-1 rounded border border-neutral-700 hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            className="flex-1 text-[11px] text-white bg-red-600 hover:bg-red-500 px-2 py-1 rounded font-semibold transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    )
  }

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
      <span className="text-[10px] text-neutral-500 tabular-nums shrink-0 mt-px">{index + 1}.</span>
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
      {/* Reorder + delete. Arrows control publish queue position; same
          visibility pattern as the trash button (hover-revealed on
          desktop, always tappable on mobile). */}
      <div className="flex items-center gap-0.5 shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
        <button
          onClick={e => { e.stopPropagation(); onMove?.(-1) }}
          disabled={index === 0}
          title="Move up"
          aria-label="Move up in publish queue"
          className="text-neutral-500 hover:text-neutral-100 disabled:opacity-30 disabled:pointer-events-none p-1 -m-1 leading-none text-xs"
        >▲</button>
        <button
          onClick={e => { e.stopPropagation(); onMove?.(1) }}
          disabled={index === total - 1}
          title="Move down"
          aria-label="Move down in publish queue"
          className="text-neutral-500 hover:text-neutral-100 disabled:opacity-30 disabled:pointer-events-none p-1 -m-1 leading-none text-xs"
        >▼</button>
        <button
          onClick={e => { e.stopPropagation(); setPending(true) }}
          title="Delete draft"
          aria-label="Delete draft"
          className="text-neutral-500 hover:text-red-400 transition-colors p-1 -m-1"
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  )
}

export default function DraftsTray({
  drafts,
  currentDraftId,
  onSelectDraft,
  onCreateDraft,
  onDeleteDraft,
  onDeleteAllDrafts,
  onImportDrafts,
  onExportAllDrafts,
  onPublishAll,
  onMoveDraft,
  pubkey = '',
  isMobileOpen = false,
  onMobileClose,
  isMobile = false,
}) {
  // ── Scheduled section ────────────────────────────────────────────────
  // Worker is the source of truth; localStorage is just a fast-path
  // mirror so the section renders before the network round-trip.
  const schedulerEnabled = isSchedulerConfigured()
  const [scheduled, setScheduled] = useState(() => pubkey ? readLocalScheduled(pubkey) : [])
  const [scheduleSyncing, setScheduleSyncing] = useState(false)
  const [cancellingId, setCancellingId] = useState('')

  const refreshScheduled = useCallback(async () => {
    if (!schedulerEnabled || !pubkey) return
    setScheduleSyncing(true)
    try {
      const items = await listScheduled(pubkey)
      setScheduled(items.map(it => ({
        eventId: it.eventId,
        scheduledFor: it.scheduledFor,
        content: it.contentPreview || it.content || '',
        status: it.status,
        attempts: it.attempts,
      })))
    } catch {
      // On failure, fall back to local cache (already in state).
    } finally {
      setScheduleSyncing(false)
    }
  }, [schedulerEnabled, pubkey])

  // Initial fetch + refresh on tab focus so cross-device cancellations
  // and publish-after-fire transitions stay in sync.
  useEffect(() => {
    refreshScheduled()
    const onFocus = () => refreshScheduled()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshScheduled])

  async function handleCancelScheduled(eventId) {
    if (!pubkey || cancellingId) return
    setCancellingId(eventId)
    try {
      await cancelScheduled(eventId, pubkey)
      setScheduled(s => s.filter(e => e.eventId !== eventId))
    } catch (e) {
      // Surface inline so the user knows; no toast system here yet.
      console.warn('[scheduler] cancel failed:', e?.message || e)
    } finally {
      setCancellingId('')
    }
  }

  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false)
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const [importStatus, setImportStatus] = useState(null)
  const [exportStatus, setExportStatus] = useState(null)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef(null)
  const publishable = drafts.filter(d => d.publishable?.content?.trim() && d.status !== 'published')
  const exportable = drafts.filter(d => d.publishable?.content?.trim())
  const anyPublishing = drafts.some(d => d.status === 'publishing')
  // Nothing to clear when the only draft is a fresh empty one.
  const canClearAll = drafts.length > 1 || Boolean(drafts[0]?.snapshot?.content?.trim())

  function requestPublishAll() {
    if (publishable.length === 0 || anyPublishing) return
    setConfirmPublishOpen(true)
  }
  function doPublishAll() {
    setConfirmPublishOpen(false)
    onPublishAll()
    if (isMobile && onMobileClose) onMobileClose()
  }
  function requestClearAll() {
    if (!canClearAll || anyPublishing) return
    setConfirmClearOpen(true)
  }
  function doClearAll() {
    setConfirmClearOpen(false)
    onDeleteAllDrafts?.()
    if (isMobile && onMobileClose) onMobileClose()
  }

  async function handleImportFiles(files) {
    if (!onImportDrafts || files.length === 0) return
    setImportStatus(null)
    setImporting(true)
    try {
      const r = await onImportDrafts(files)
      setImportStatus(r)
      if (r.errors.length === 0 && r.imported > 0) {
        setTimeout(() => setImportStatus(null), 3000)
      }
    } finally {
      setImporting(false)
    }
  }

  function handleExportAll() {
    if (!onExportAllDrafts || exportable.length === 0) return
    const r = onExportAllDrafts()
    setExportStatus(r)
    setTimeout(() => setExportStatus(null), 3000)
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
        {drafts.map((d, i) => (
          <DraftRow
            key={d.id}
            draft={d}
            index={i}
            total={drafts.length}
            isCurrent={d.id === currentDraftId}
            onSelect={() => {
              onSelectDraft(d.id)
              if (isMobile && onMobileClose) onMobileClose()
            }}
            onDelete={() => onDeleteDraft(d.id)}
            onMove={(delta) => onMoveDraft?.(d.id, delta)}
          />
        ))}

        {/* Scheduled section — only renders when there are pending or
            failed scheduled notes for this pubkey. Sits below the
            drafts so the active workflow stays at the top. */}
        {schedulerEnabled && scheduled.length > 0 && (
          <div className="mt-3 pt-2 border-t border-neutral-800 space-y-1">
            <div className="px-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">
                Scheduled ({scheduled.length})
              </span>
              {scheduleSyncing && (
                <span className="text-[10px] text-neutral-600">syncing…</span>
              )}
            </div>
            {scheduled.map(item => (
              <ScheduledRow
                key={item.eventId}
                item={item}
                cancelling={cancellingId === item.eventId}
                onCancel={() => handleCancelScheduled(item.eventId)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-2 space-y-1.5">
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = [...(e.target.files || [])]
            e.target.value = ''
            await handleImportFiles(files)
          }}
        />
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={importing || anyPublishing}
          className="w-full text-xs py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 disabled:text-neutral-600 disabled:pointer-events-none transition-colors"
        >
          {importing ? 'Importing…' : 'Multi-JSON Import'}
        </button>
        <button
          onClick={handleExportAll}
          disabled={exportable.length === 0 || anyPublishing}
          className="w-full text-xs py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 disabled:text-neutral-600 disabled:pointer-events-none transition-colors"
        >
          Export All Drafts ({exportable.length})
        </button>
        <button
          onClick={requestClearAll}
          disabled={!canClearAll || anyPublishing}
          className="w-full text-xs py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-900 disabled:text-neutral-600 disabled:pointer-events-none transition-colors"
        >
          Clear All Drafts ({drafts.length})
        </button>
        <button
          onClick={requestPublishAll}
          disabled={publishable.length === 0 || anyPublishing}
          className="w-full text-xs py-1.5 rounded bg-purple-700/90 hover:bg-purple-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white transition-colors"
        >
          {anyPublishing ? 'Publishing…' : `Publish All (${publishable.length})`}
        </button>
        {importStatus && (importStatus.imported > 0 || importStatus.errors.length > 0) && (
          <div className="text-[10px] text-neutral-400 pt-1">
            {importStatus.imported > 0 && (
              <p className="text-green-500">Imported {importStatus.imported} draft{importStatus.imported === 1 ? '' : 's'}</p>
            )}
            {importStatus.errors.length > 0 && (
              <details className="mt-0.5">
                <summary className="text-red-400 cursor-pointer">
                  {importStatus.errors.length} file{importStatus.errors.length === 1 ? '' : 's'} skipped
                </summary>
                <ul className="mt-1 space-y-0.5 text-red-300">
                  {importStatus.errors.map((err, i) => (
                    <li key={i} className="truncate">{err}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {exportStatus && exportStatus.exported > 0 && (
          <p className="text-[10px] text-green-500 pt-1">
            Exported {exportStatus.exported} draft{exportStatus.exported === 1 ? '' : 's'}
            {exportStatus.skipped > 0 ? ` (${exportStatus.skipped} skipped — empty)` : ''}
          </p>
        )}
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
        {confirmPublishOpen && (
          <ConfirmDialog
            title={`Publish ${publishable.length} draft${publishable.length === 1 ? '' : 's'}?`}
            body="Each draft will be signed and published in order. This can't be undone — notes on Nostr relays aren't reliably deletable."
            confirmLabel="Publish All"
            onCancel={() => setConfirmPublishOpen(false)}
            onConfirm={doPublishAll}
          />
        )}
        {confirmClearOpen && (
          <ConfirmDialog
            title={`Delete all ${drafts.length} draft${drafts.length === 1 ? '' : 's'}?`}
            body="Every draft in this browser will be removed and replaced with one empty draft. This can't be undone — export anything important first."
            confirmLabel="Delete all"
            confirmTone="red"
            onCancel={() => setConfirmClearOpen(false)}
            onConfirm={doClearAll}
          />
        )}
      </>
    )
  }

  return (
    <aside className="hidden md:flex flex-col w-[200px] flex-shrink-0 border-r border-neutral-800 bg-neutral-900/40">
      {list}
      {confirmPublishOpen && (
        <ConfirmDialog
          title={`Publish ${publishable.length} draft${publishable.length === 1 ? '' : 's'}?`}
          body="Each draft will be signed and published in order. This can't be undone — notes on Nostr relays aren't reliably deletable."
          confirmLabel="Publish all"
          onCancel={() => setConfirmPublishOpen(false)}
          onConfirm={doPublishAll}
        />
      )}
      {confirmClearOpen && (
        <ConfirmDialog
          title={`Delete all ${drafts.length} draft${drafts.length === 1 ? '' : 's'}?`}
          body="Every draft in this browser will be removed and replaced with one empty draft. This can't be undone — export anything important first."
          confirmLabel="Delete all"
          confirmTone="red"
          onCancel={() => setConfirmClearOpen(false)}
          onConfirm={doClearAll}
        />
      )}
    </aside>
  )
}


function ScheduledRow({ item, cancelling, onCancel }) {
  const when = item.scheduledFor
    ? new Date(item.scheduledFor * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : ""
  const failed = item.status === "failed"
  const preview = (item.content || "").trim().split("\n")[0].slice(0, 60) || "(empty)"
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs border ${
        failed
          ? "border-red-900/60 bg-red-950/20"
          : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      <span className={failed ? "text-red-400" : "text-blue-400"}>
        {failed ? "⚠" : "🕐"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-neutral-300">{preview}</div>
        <div className="text-[10px] text-neutral-500 leading-tight">
          {failed ? `failed after ${item.attempts} attempts` : when}
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={cancelling}
        className="shrink-0 text-[10px] text-neutral-500 hover:text-red-300 disabled:opacity-40 transition-colors px-1"
        title={failed ? "Remove" : "Cancel"}
      >
        {cancelling ? "…" : (failed ? "Remove" : "Cancel")}
      </button>
    </div>
  )
}
